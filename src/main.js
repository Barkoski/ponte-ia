/* Ponte IA — processo principal.
   Aqui ficam: a janela, o menu, as chaves de API (criptografadas pelo Windows)
   e as chamadas HTTP. O processo principal não sofre restrição de CORS, então
   as chamadas saem daqui e chegam à interface já normalizadas. */
'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs   = require('fs');
const { fileURLToPath } = require('url');

const USER      = app.getPath('userData');
const CFG_FILE  = path.join(USER, 'config.json');
const CONV_FILE = path.join(USER, 'conversa.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const SECRETS   = ['kAnthropic', 'kOpenai'];
const PROVIDERS = new Set(['claude', 'gpt']);
const MAX_CHAT_BYTES = 60 * 1024 * 1024;
const MAX_CONV_BYTES = 60 * 1024 * 1024;
const MAX_EXPORT_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

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

function publicCfg(raw){
  const out = {};
  const stringFields = {
    mClaude: 160, mGpt: 160, mGptManual: 160, effort: 16, thinking: 24,
    sysPrompt: 30000, theme: 16, mode: 24, synth: 16
  };
  for (const [k, max] of Object.entries(stringFields)){
    if (typeof raw?.[k] === 'string') out[k] = raw[k].slice(0, max);
  }
  if (typeof raw?.persist === 'boolean') out.persist = raw.persist;
  for (const k of ['modelsC', 'modelsG']){
    if (Array.isArray(raw?.[k]))
      out[k] = raw[k].filter(x => typeof x === 'string').slice(0, 200).map(x => x.slice(0, 160));
  }
  return out;
}

function atomicWrite(file, data, mode = 0o600){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function writeCfg({ cfg, secrets, clearSecrets } = {}){
  const anterior = readCfg();
  const out = { ...publicCfg(anterior), ...publicCfg(cfg || {}) };
  const clear = new Set(Array.isArray(clearSecrets) ? clearSecrets : []);
  const novos = secrets && typeof secrets === 'object' ? secrets : {};

  for (const k of SECRETS){
    if (clear.has(k)) out[k] = '';
    else if (typeof novos[k] === 'string' && novos[k].trim())
      out[k] = novos[k].trim().slice(0, 512);
    else out[k] = anterior[k] || '';
  }

  const seguro = safeStorage.isEncryptionAvailable();
  if (!seguro && SECRETS.some(k => out[k]))
    throw new Error('A criptografia segura do sistema não está disponível. As chaves não foram gravadas em texto puro.');

  for (const k of SECRETS){
    if (out[k] && seguro)
      out[k] = { enc: safeStorage.encryptString(out[k]).toString('base64') };
    else delete out[k];
  }
  atomicWrite(CFG_FILE, JSON.stringify(out, null, 2));
  const volta = readCfg();
  return {
    seguro,
    cfg: publicCfg(volta),
    keys: { anthropic: !!volta.kAnthropic, openai: !!volta.kOpenai }
  };
}

/* ============================ chamadas de API ============================ */

const jobs = new Map();   // webContents.id:id -> AbortController

function valido(e){
  try {
    if (!e?.senderFrame || e.senderFrame !== e.sender.mainFrame) return false;
    const u = new URL(e.senderFrame.url);
    return u.protocol === 'file:' && path.normalize(fileURLToPath(u)) === path.normalize(INDEX_FILE);
  } catch { return false; }
}

function assertValido(e){
  if (!valido(e)) throw new Error('Origem IPC não autorizada.');
}

function secureHandle(channel, fn){
  ipcMain.handle(channel, async (e, payload) => {
    assertValido(e);
    return fn(e, payload);
  });
}

function tamanhoJson(v){
  try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); }
  catch { return Infinity; }
}

function timedSignal(parent, ms = REQUEST_TIMEOUT_MS){
  const ac = new AbortController();
  let timedOut = false;
  const abort = () => ac.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, ms);
  return {
    signal: ac.signal,
    timedOut: () => timedOut,
    cleanup(){
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    }
  };
}

async function detalheErro(resp){
  let d = '';
  try { const j = await resp.json(); d = j?.error?.message || JSON.stringify(j); }
  catch { try { d = await resp.text(); } catch {} }
  return `HTTP ${resp.status} — ${d || 'sem detalhe'}`;
}

/* Lê SSE com LF ou CRLF e entrega cada objeto JSON já desserializado. */
async function lerSSE(resp, onEvent){
  const ct = resp.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('text/event-stream'))
    throw new Error('O provedor respondeu em formato inesperado em vez de um stream SSE.');

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let eventos = 0;

  const bloco = raw => {
    const dados = raw.split(/\r?\n/)
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!dados || dados === '[DONE]') return;
    try {
      onEvent(JSON.parse(dados));
      eventos++;
    } catch (e){
      throw new Error('O provedor enviou um evento SSE inválido: ' + String(e?.message || e));
    }
  };

  for (;;){
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))){
      bloco(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  }
  buf += dec.decode();
  if (buf.trim()) bloco(buf);
  if (!eventos) throw new Error('O stream terminou sem nenhum evento reconhecido.');
  return eventos;
}

async function chamarClaude({ body, key, send, signal }){
  const tempo = timedSignal(signal);
  const pedir = payload => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: tempo.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ ...payload, stream: true })
  });

  try {
    let resp = await pedir(body);
    if (!resp.ok){
      const status = resp.status;
      const msg = await detalheErro(resp);
      if (status === 400 && (body.thinking || body.output_config) &&
          /(thinking|output_config|effort|display)/i.test(msg)){
        const compat = { ...body };
        delete compat.thinking;
        delete compat.output_config;
        send({ type: 'notice', message: 'Este modelo não aceita os controles avançados de raciocínio; a chamada foi refeita em modo compatível.' });
        resp = await pedir(compat);
        if (!resp.ok) throw new Error(await detalheErro(resp));
      } else throw new Error(msg);
    }

    let recusa = false, erroStream = null;
    let usage = { input_tokens: 0, output_tokens: 0 };
    await lerSSE(resp, ev => {
      if (ev.type === 'message_start' && ev.message?.usage)
        usage.input_tokens = ev.message.usage.input_tokens || 0;
      else if (ev.type === 'content_block_delta'){
        if (ev.delta?.type === 'text_delta')          send({ type: 'text',  text: ev.delta.text });
        else if (ev.delta?.type === 'thinking_delta') send({ type: 'think', text: ev.delta.thinking });
      } else if (ev.type === 'message_delta'){
        if (ev.delta?.stop_reason === 'refusal') recusa = true;
        if (ev.usage?.output_tokens != null) usage.output_tokens = ev.usage.output_tokens;
      } else if (ev.type === 'error'){
        erroStream = ev.error?.message || 'erro no stream';
      }
    });
    if (erroStream) throw new Error(erroStream);
    if (recusa) send({ type: 'text', text: '\n\n_(interrompido pelos filtros de segurança da Anthropic)_' });
    send({ type: 'usage', usage });
  } catch (e){
    if (tempo.timedOut()) throw new Error('Tempo limite de 3 minutos excedido na Anthropic.');
    throw e;
  } finally {
    tempo.cleanup();
  }
}

async function chamarOpenAI({ body, key, send, signal }){
  const tempo = timedSignal(signal);
  const pedir = (stream) => fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal: tempo.signal,
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: JSON.stringify({
      ...body,
      store: false,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {})
    })
  });

  try {
    let resp = await pedir(true);
    if (!resp.ok){
      const status = resp.status;
      const msg = await detalheErro(resp);
      // algumas contas não liberam streaming; só repete quando o erro for inequívoco
      if ((status === 400 || status === 403) &&
          /(streaming?.*(verif|not available|not enabled)|(verif|not available|not enabled).*streaming?)/i.test(msg)){
        resp = await pedir(false);
        if (!resp.ok) throw new Error(await detalheErro(resp));
        const j = await resp.json();
        const texto = j.choices?.[0]?.message?.content || j.choices?.[0]?.message?.refusal;
        send({ type: 'text', text: texto || '(resposta vazia)' });
        if (j.usage) send({ type: 'usage', usage: {
          input_tokens: j.usage.prompt_tokens || 0,
          output_tokens: j.usage.completion_tokens || 0
        }});
        return;
      }
      throw new Error(msg);
    }

    let erroStream = null;
    await lerSSE(resp, ev => {
      if (ev.error) erroStream = ev.error.message || 'erro no stream';
      const d = ev.choices?.[0]?.delta;
      if (d?.content) send({ type: 'text', text: d.content });
      if (d?.refusal) send({ type: 'text', text: d.refusal });
      if (ev.usage) send({ type: 'usage', usage: {
        input_tokens: ev.usage.prompt_tokens || 0,
        output_tokens: ev.usage.completion_tokens || 0
      }});
    });
    if (erroStream) throw new Error(erroStream);
  } catch (e){
    if (tempo.timedOut()) throw new Error('Tempo limite de 3 minutos excedido na OpenAI.');
    throw e;
  } finally {
    tempo.cleanup();
  }
}

secureHandle('chat:start', async (e, { id, provider, body } = {}) => {
  if (!PROVIDERS.has(provider)) throw new Error('Provedor inválido.');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('ID de chamada inválido.');
  if (!body || typeof body !== 'object' || Array.isArray(body) || tamanhoJson(body) > MAX_CHAT_BYTES)
    throw new Error('Corpo da chamada inválido ou grande demais.');

  const cfg = readCfg();
  const key = provider === 'claude' ? cfg.kAnthropic : cfg.kOpenai;
  if (!key) {
    e.sender.send('chat', { id, type: 'error', message: 'Chave de API não configurada (Ctrl+, para abrir as Configurações).' });
    return;
  }

  const ac = new AbortController();
  const jobId = e.sender.id + ':' + id;
  if (jobs.has(jobId)) throw new Error('Já existe uma chamada com este ID.');
  jobs.set(jobId, ac);
  const send = m => manda(e.sender, id, m);

  try {
    const fn = provider === 'claude' ? chamarClaude : chamarOpenAI;
    await fn({ body, key, send, signal: ac.signal });
    send({ type: 'done' });
  } catch (e){
    if (e?.name === 'AbortError') send({ type: 'aborted' });
    else send({ type: 'error', message: String(e?.message || e) });
  } finally {
    jobs.delete(jobId);
  }
});

function manda(sender, id, msg){
  if (sender && !sender.isDestroyed()) sender.send('chat', { id, ...msg });
}

ipcMain.on('chat:abort', (e, id) => {
  if (!valido(e) || typeof id !== 'string') return;
  const ac = jobs.get(e.sender.id + ':' + id);
  if (ac) ac.abort();
});

/* Lista de modelos, buscada em cada provedor — nada é chutado. */
secureHandle('models:list', async (_e, { provider, key: candidateKey } = {}) => {
  if (!PROVIDERS.has(provider)) return { ok: false, erro: 'Provedor inválido.' };
  const cfg = readCfg();
  const stored = provider === 'claude' ? cfg.kAnthropic : cfg.kOpenai;
  const key = typeof candidateKey === 'string' && candidateKey.trim()
    ? candidateKey.trim().slice(0, 512) : stored;
  if (!key) return { ok: false, erro: 'Chave de API não configurada.' };
  const tempo = timedSignal(undefined, 30 * 1000);
  try {
    if (provider === 'claude'){
      const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        signal: tempo.signal,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      });
      if (!r.ok) throw new Error(await detalheErro(r));
      const j = await r.json();
      return { ok: true, list: (j.data || []).map(m => m.id).filter(Boolean).slice(0, 200) };
    }
    const r = await fetch('https://api.openai.com/v1/models', {
      signal: tempo.signal,
      headers: { authorization: 'Bearer ' + key }
    });
    if (!r.ok) throw new Error(await detalheErro(r));
    const j = await r.json();
    const list = (j.data || []).map(m => m.id)
      .filter(id => /^(gpt|o\d|chatgpt)/i.test(id) &&
                   !/(audio|realtime|transcribe|tts|image|embedding|moderation|search|dall)/i.test(id))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    return { ok: true, list: list.slice(0, 200) };
  } catch (e){
    return {
      ok: false,
      erro: tempo.timedOut() ? 'Tempo limite de 30 segundos excedido ao buscar modelos.' : String(e?.message || e)
    };
  } finally {
    tempo.cleanup();
  }
});

/* ============================ arquivos ============================ */

secureHandle('cfg:get',  () => {
  const cfg = readCfg();
  return {
    cfg: publicCfg(cfg),
    keys: { anthropic: !!cfg.kAnthropic, openai: !!cfg.kOpenai },
    seguro: safeStorage.isEncryptionAvailable()
  };
});
secureHandle('cfg:set',  (_e, payload) => {
  try { return { ok: true, ...writeCfg(payload) }; }
  catch (err) { return { ok: false, erro: String(err?.message || err) }; }
});
secureHandle('conv:load', () => {
  try {
    const conv = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'));
    return Array.isArray(conv) ? conv : [];
  } catch { return []; }
});
secureHandle('conv:save', (_e, conv) => {
  try {
    if (!conv || !conv.length) fs.rmSync(CONV_FILE, { force: true });
    else {
      if (!Array.isArray(conv) || conv.length > 2000) throw new Error('Histórico inválido.');
      const raw = JSON.stringify(conv);
      if (Buffer.byteLength(raw, 'utf8') > MAX_CONV_BYTES)
        throw new Error('A conversa passou do limite local de 60 MB. Exporte e inicie uma nova conversa.');
      atomicWrite(CONV_FILE, raw);
    }
    return { ok: true };
  } catch (err) { return { ok: false, erro: String(err?.message || err) }; }
});
secureHandle('app:info', () => ({
  versao: app.getVersion(),
  electron: process.versions.electron,
  pasta: USER,
  seguro: safeStorage.isEncryptionAvailable()
}));
secureHandle('pasta:abrir', () => shell.openPath(USER));

secureHandle('export:md', async (_e, { texto, nome } = {}) => {
  if (typeof texto !== 'string' || Buffer.byteLength(texto, 'utf8') > MAX_EXPORT_BYTES)
    throw new Error('Exportação inválida ou maior que 25 MB.');
  const seguroNome = path.basename(typeof nome === 'string' ? nome : 'ponte-ia.md')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 120);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Salvar conversa',
    defaultPath: path.join(app.getPath('documents'), seguroNome),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Texto', extensions: ['txt'] }]
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, texto, 'utf8');
  return { ok: true, filePath };
});

secureHandle('confirmar', async (_e, { titulo, texto } = {}) => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Cancelar', 'Confirmar'], defaultId: 0, cancelId: 0,
    title: 'Ponte IA', message: String(titulo || '').slice(0, 200), detail: String(texto || '').slice(0, 4000)
  });
  return response === 1;
});

secureHandle('avisar', async (_e, { titulo, texto } = {}) => {
  await dialog.showMessageBox(win, {
    type: 'info', buttons: ['OK'], title: 'Ponte IA',
    message: String(titulo || '').slice(0, 200), detail: String(texto || '').slice(0, 4000)
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
      ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' }] : [])
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
      sandbox: true
    }
  });
  const contentsId = win.webContents.id;
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  Menu.setApplicationMenu(menu());

  // links externos abrem no navegador, nunca dentro do app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) setImmediate(() => shell.openExternal(url));
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    try {
      if (path.normalize(fileURLToPath(new URL(url))) === path.normalize(INDEX_FILE)) return;
    } catch {}
    e.preventDefault();
    if (/^https:\/\//i.test(url)) setImmediate(() => shell.openExternal(url));
  });
  win.webContents.on('render-process-gone', () => {
    for (const [id, ac] of jobs) if (id.startsWith(contentsId + ':')) ac.abort();
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win){ if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    criarJanela();
  });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) criarJanela(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
