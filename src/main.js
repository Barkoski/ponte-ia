/* Ponte IA — processo principal.
   Aqui ficam: a janela, o menu, as chaves de API (criptografadas pelo Windows)
   e as chamadas HTTP. O processo principal não sofre restrição de CORS, então
   as chamadas saem daqui e chegam à interface já normalizadas. */
'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs   = require('fs');

const USER      = app.getPath('userData');
const CFG_FILE  = path.join(USER, 'config.json');
const CONV_FILE = path.join(USER, 'conversa.json');
const SECRETS   = ['kAnthropic', 'kOpenai'];

let win = null;

/* ============================ configuração ============================ */

function readCfg(){
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); }
  catch { return {}; }
  for (const k of SECRETS){
    const v = raw[k];
    if (v && typeof v === 'object' && v.enc){
      try { raw[k] = safeStorage.decryptString(Buffer.from(v.enc, 'base64')); }
      catch { raw[k] = ''; }        // perfil do Windows mudou — chave ilegível
    }
  }
  return raw;
}

function writeCfg(cfg){
  const out = { ...cfg };
  const seguro = safeStorage.isEncryptionAvailable();
  for (const k of SECRETS){
    if (out[k] && seguro)
      out[k] = { enc: safeStorage.encryptString(out[k]).toString('base64') };
  }
  fs.mkdirSync(USER, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
  return seguro;
}

/* ============================ chamadas de API ============================ */

const jobs = new Map();   // id -> AbortController

async function detalheErro(resp){
  let d = '';
  try { const j = await resp.json(); d = j?.error?.message || JSON.stringify(j); }
  catch { try { d = await resp.text(); } catch {} }
  return `HTTP ${resp.status} — ${d || 'sem detalhe'}`;
}

/* Lê um corpo SSE e entrega cada objeto JSON já desserializado. */
async function lerSSE(resp, onEvent){
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;){
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0){
      const bloco = buf.slice(0, sep); buf = buf.slice(sep + 2);
      for (const linha of bloco.split('\n')){
        if (!linha.startsWith('data:')) continue;
        const p = linha.slice(5).trim();
        if (!p || p === '[DONE]') continue;
        try { onEvent(JSON.parse(p)); } catch {}
      }
    }
  }
}

async function chamarClaude({ body, key, send, signal }){
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ ...body, stream: true })
  });
  if (!resp.ok) throw new Error(await detalheErro(resp));

  let recusa = false, erroStream = null;
  await lerSSE(resp, ev => {
    if (ev.type === 'content_block_delta'){
      if (ev.delta?.type === 'text_delta')          send({ type: 'text',  text: ev.delta.text });
      else if (ev.delta?.type === 'thinking_delta') send({ type: 'think', text: ev.delta.thinking });
    } else if (ev.type === 'message_delta'){
      if (ev.delta?.stop_reason === 'refusal') recusa = true;
    } else if (ev.type === 'error'){
      erroStream = ev.error?.message || 'erro no stream';
    }
  });
  if (erroStream) throw new Error(erroStream);
  if (recusa) send({ type: 'text', text: '\n\n_(interrompido pelos filtros de segurança da Anthropic)_' });
}

async function chamarOpenAI({ body, key, send, signal }){
  const pedir = (stream) => fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: JSON.stringify({ ...body, stream })
  });

  let resp = await pedir(true);
  if (!resp.ok){
    const msg = await detalheErro(resp);
    // contas sem verificação não liberam streaming — refaz sem
    if (/stream|verif/i.test(msg)){
      resp = await pedir(false);
      if (!resp.ok) throw new Error(await detalheErro(resp));
      const j = await resp.json();
      send({ type: 'text', text: j.choices?.[0]?.message?.content || '(resposta vazia)' });
      return;
    }
    throw new Error(msg);
  }
  await lerSSE(resp, ev => {
    const d = ev.choices?.[0]?.delta;
    if (d?.content) send({ type: 'text', text: d.content });
  });
}

ipcMain.handle('chat:start', async (_e, { id, provider, body }) => {
  const cfg = readCfg();
  const key = provider === 'claude' ? cfg.kAnthropic : cfg.kOpenai;
  if (!key) { manda(id, { type: 'error', message: 'Chave de API não configurada (Ctrl+, para abrir as Configurações).' }); return; }

  const ac = new AbortController();
  jobs.set(id, ac);
  const send = (m) => manda(id, m);

  try {
    const fn = provider === 'claude' ? chamarClaude : chamarOpenAI;
    await fn({ body, key, send, signal: ac.signal });
    send({ type: 'done' });
  } catch (e){
    if (e?.name === 'AbortError') send({ type: 'aborted' });
    else send({ type: 'error', message: String(e?.message || e) });
  } finally {
    jobs.delete(id);
  }
});

function manda(id, msg){
  if (win && !win.isDestroyed()) win.webContents.send('chat', { id, ...msg });
}

ipcMain.on('chat:abort', (_e, id) => {
  const ac = jobs.get(id);
  if (ac) ac.abort();
});

/* Lista de modelos, buscada em cada provedor — nada é chutado. */
ipcMain.handle('models:list', async (_e, { provider, key }) => {
  try {
    if (provider === 'claude'){
      const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      });
      if (!r.ok) throw new Error(await detalheErro(r));
      const j = await r.json();
      return { ok: true, list: (j.data || []).map(m => m.id) };
    }
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: 'Bearer ' + key }
    });
    if (!r.ok) throw new Error(await detalheErro(r));
    const j = await r.json();
    const list = (j.data || []).map(m => m.id)
      .filter(id => /^(gpt|o\d|chatgpt)/i.test(id) &&
                   !/(audio|realtime|transcribe|tts|image|embedding|moderation|search|dall)/i.test(id))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    return { ok: true, list };
  } catch (e){
    return { ok: false, erro: String(e?.message || e) };
  }
});

/* ============================ arquivos ============================ */

ipcMain.handle('cfg:get',  () => ({ cfg: readCfg(), seguro: safeStorage.isEncryptionAvailable() }));
ipcMain.handle('cfg:set',  (_e, cfg) => ({ seguro: writeCfg(cfg) }));
ipcMain.handle('conv:load', () => {
  try { return JSON.parse(fs.readFileSync(CONV_FILE, 'utf8')); } catch { return []; }
});
ipcMain.handle('conv:save', (_e, conv) => {
  try {
    if (!conv || !conv.length) fs.rmSync(CONV_FILE, { force: true });
    else fs.writeFileSync(CONV_FILE, JSON.stringify(conv), { mode: 0o600 });
    return true;
  } catch { return false; }
});
ipcMain.handle('app:info', () => ({
  versao: app.getVersion(),
  electron: process.versions.electron,
  pasta: USER,
  seguro: safeStorage.isEncryptionAvailable()
}));
ipcMain.handle('pasta:abrir', () => shell.openPath(USER));

ipcMain.handle('export:md', async (_e, { texto, nome }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Salvar conversa',
    defaultPath: path.join(app.getPath('documents'), nome),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Texto', extensions: ['txt'] }]
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, texto, 'utf8');
  return { ok: true, filePath };
});

ipcMain.handle('confirmar', async (_e, { titulo, texto }) => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Cancelar', 'Confirmar'], defaultId: 0, cancelId: 0,
    title: 'Ponte IA', message: titulo, detail: texto
  });
  return response === 1;
});

ipcMain.handle('avisar', async (_e, { titulo, texto }) => {
  await dialog.showMessageBox(win, {
    type: 'info', buttons: ['OK'], title: 'Ponte IA', message: titulo, detail: texto
  });
});

/* ============================ janela e menu ============================ */

function menu(){
  const paraTela = (o) => win && win.webContents.send('menu', o);
  return Menu.buildFromTemplate([
    { label: 'Arquivo', submenu: [
      { label: 'Nova conversa', accelerator: 'CmdOrCtrl+N', click: () => paraTela('nova') },
      { label: 'Exportar em Markdown…', accelerator: 'CmdOrCtrl+E', click: () => paraTela('exportar') },
      { type: 'separator' },
      { label: 'Configurações…', accelerator: 'CmdOrCtrl+,', click: () => paraTela('config') },
      { label: 'Pasta de dados', click: () => shell.openPath(USER) },
      { type: 'separator' },
      { role: 'quit', label: 'Sair' }
    ]},
    { label: 'Editar', submenu: [
      { role: 'undo',      label: 'Desfazer' },
      { role: 'redo',      label: 'Refazer' },
      { type: 'separator' },
      { role: 'cut',       label: 'Recortar' },
      { role: 'copy',      label: 'Copiar' },
      { role: 'paste',     label: 'Colar' },
      { role: 'selectAll', label: 'Selecionar tudo' }
    ]},
    { label: 'Conversa', submenu: [
      { label: 'Enviar',                    accelerator: 'CmdOrCtrl+Return', click: () => paraTela('enviar') },
      { label: 'Parar',                     accelerator: 'Esc',              click: () => paraTela('parar') },
      { type: 'separator' },
      { label: 'Cada um analisa o outro',   accelerator: 'CmdOrCtrl+D',      click: () => paraTela('cruzar') },
      { label: 'Síntese',                   accelerator: 'CmdOrCtrl+S',      click: () => paraTela('sintese') }
    ]},
    { label: 'Exibir', submenu: [
      { role: 'resetZoom',      label: 'Zoom normal' },
      { role: 'zoomIn',         label: 'Aumentar zoom' },
      { role: 'zoomOut',        label: 'Diminuir zoom' },
      { type: 'separator' },
      { label: 'Alternar tema', accelerator: 'CmdOrCtrl+T', click: () => paraTela('tema') },
      { role: 'togglefullscreen', label: 'Tela cheia' },
      { type: 'separator' },
      { role: 'reload',           label: 'Recarregar' },
      { role: 'toggleDevTools',   label: 'Ferramentas de desenvolvedor' }
    ]},
    { label: 'Ajuda', submenu: [
      { label: 'Sobre', click: () => dialog.showMessageBox(win, {
          type: 'info', title: 'Ponte IA', message: 'Ponte IA ' + app.getVersion(),
          detail: 'Claude e ChatGPT na mesma conversa.\n\n' +
                  'As chaves de API ficam neste computador, protegidas pela criptografia do Windows.\n' +
                  'O texto das conversas é enviado à Anthropic e à OpenAI para gerar as respostas.\n\n' +
                  'Electron ' + process.versions.electron + '\nDados em: ' + USER,
          buttons: ['OK']
        }) }
    ]}
  ]);
}

function criarJanela(){
  win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 700, minHeight: 520,
    title: 'Ponte IA',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#F4F1EC',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  Menu.setApplicationMenu(menu());

  // links externos abrem no navegador, nunca dentro do app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win){ if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(criarJanela);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) criarJanela(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
