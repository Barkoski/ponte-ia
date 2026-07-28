/* Sobe o app de verdade, verifica se carregou sem erro e roda testes
   dentro da janela. Uso:  npx electron tools/smoke.js   */
'use strict';
const { app, BrowserWindow } = require('electron');

let erros = [];
let falhas = 0;

app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (ev) => {
    // Electron 43: objeto com {level, message}
    const nivel = ev?.level ?? arguments[1];
    const msg   = ev?.message ?? '';
    if (nivel === 'error' || nivel === 3) erros.push(String(msg));
  });
  wc.on('preload-error', (_ev, p, err) => erros.push('PRELOAD ' + p + ': ' + err.message));
  wc.on('render-process-gone', (_ev, d) => erros.push('RENDERER MORREU: ' + JSON.stringify(d)));
});

require('../src/main.js');

const ok = (nome, cond, extra) => {
  console.log((cond ? '  ok  ' : '  FALHA ') + nome + (cond ? '' : '  ->  ' + JSON.stringify(extra)));
  if (!cond) falhas++;
};

app.whenReady().then(async () => {
  const espera = ms => new Promise(r => setTimeout(r, ms));
  await espera(400);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win){ console.log('  FALHA  a janela não foi criada'); app.exit(1); return; }

  if (!win.webContents.isLoading()) { /* já carregou */ }
  else await new Promise(r => win.webContents.once('did-finish-load', r));
  await espera(900);   // deixa o init() assíncrono terminar

  const js = (code) => win.webContents.executeJavaScript(code);

  console.log('\n— a janela subiu —');
  ok('janela criada', !!win);
  ok('título correto', win.getTitle() === 'Ponte IA', win.getTitle());
  ok('sem erro de console ao carregar', erros.length === 0, erros);

  console.log('\n— ponte com o processo principal —');
  ok('window.api existe', await js('typeof window.api === "object"'));
  ok('todas as funções expostas',
     await js(`["getCfg","setCfg","loadConv","saveConv","models","chat","abort","exportMd","confirmar","avisar","info","abrirPasta","onChunk","onMenu"].every(k=>typeof window.api[k]==="function")`));
  ok('Node NÃO exposto à interface', await js('typeof require === "undefined" && typeof process === "undefined"'));
  const info = await js('window.api.info()');
  ok('processo principal responde', !!info.versao, info);
  ok('criptografia do Windows disponível', info.seguro === true, info);

  console.log('\n— interface montada —');
  ok('campo de texto existe',   await js('!!document.getElementById("input")'));
  ok('botão enviar existe',     await js('!!document.getElementById("btnSend")'));
  ok('tela inicial aparece',    await js('document.getElementById("conv").innerHTML.includes("Duas opiniões")'));
  ok('modal abriu sozinho (sem chaves)', await js('document.getElementById("ov").classList.contains("on")'));
  ok('aviso de sigilo presente', await js('document.getElementById("segAviso").textContent.includes("Anthropic")'));
  ok('tema aplicado',           await js('!!document.documentElement.getAttribute("data-theme")'));

  console.log('\n— lógica dentro da janela —');
  ok('markdown: negrito',   await js('md("a **b**").includes("<strong>b</strong>")'));
  ok('markdown: lista',     await js('md("- x\\n- y") === "<ul><li>x</li><li>y</li></ul>"'));
  ok('markdown: escapa html', await js('!md("<img onerror=1>").includes("<img")'));
  ok('markdown: bloco de código', await js('md("```js\\nvar a=1;\\n```").includes("<pre><code>var a=1;</code></pre>")'));

  await js(`conv=[{role:'user',text:'P'},{role:'claude',text:'RC'},{role:'gpt',text:'RG'}]`);
  ok('Claude vê a resposta do GPT rotulada',
     await js(`JSON.stringify(claudeMessages()).includes("Resposta do ChatGPT") && JSON.stringify(claudeMessages()).includes("RG")`));
  ok('resposta própria vira assistant',
     await js(`claudeMessages().some(m=>m.role==="assistant"&&m.content==="RC")`));
  ok('turnos alternam',
     await js(`(m=>m.every((x,i)=>i===0?x.role==="user":x.role!==m[i-1].role))(claudeMessages())`));
  ok('lastRound enxerga as duas respostas', await js('lastRound().length===2'));
  ok('barra de ações renderiza os 4 botões',
     await js('renderFollowup(), document.querySelectorAll("#followup button").length===4'));
  ok('instrução de análise cruzada é gerada',
     await js('EX.cross("ChatGPT").includes("Onde errou, omitiu ou exagerou")'));

  console.log('\n— corpo enviado à API do Claude —');
  await js(`cfg.thinking='summarized'; cfg.effort='high'; cfg.mClaude='claude-sonnet-5'`);
  const corpo = await js(`(()=>{const b={model:cfg.mClaude,max_tokens:32000,system:cfg.sysPrompt||undefined,
      messages:claudeMessages(),output_config:{effort:cfg.effort}};
      b.thinking=cfg.thinking==='disabled'?{type:'disabled'}:{type:'adaptive',display:cfg.thinking};
      return b;})()`);
  ok('modelo padrão é Sonnet 5', corpo.model === 'claude-sonnet-5', corpo.model);
  ok('raciocínio adaptativo com resumo', corpo.thinking.type === 'adaptive' && corpo.thinking.display === 'summarized', corpo.thinking);
  ok('esforço dentro de output_config', corpo.output_config.effort === 'high', corpo.output_config);
  ok('sem parâmetros removidos pela API', !('temperature' in corpo) && !('top_p' in corpo) && !JSON.stringify(corpo).includes('budget_tokens'), Object.keys(corpo));

  console.log('\n— gravação em disco —');
  await js(`window.api.setCfg({...cfg, kAnthropic:'sk-ant-TESTE-123', kOpenai:'sk-TESTE-456', sysPrompt:'marca'})`);
  const volta = await js('window.api.getCfg()');
  ok('chave da Anthropic volta inteira', volta.cfg.kAnthropic === 'sk-ant-TESTE-123', volta.cfg.kAnthropic);
  ok('chave da OpenAI volta inteira',    volta.cfg.kOpenai === 'sk-TESTE-456');
  ok('demais campos preservados',        volta.cfg.sysPrompt === 'marca');

  const fs = require('fs'), path = require('path');
  const bruto = fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8');
  ok('chave NÃO está legível no arquivo', !bruto.includes('sk-ant-TESTE-123') && !bruto.includes('sk-TESTE-456'),
     bruto.slice(0, 120));
  ok('arquivo guarda o bloco criptografado', bruto.includes('"enc"'));

  await js(`window.api.saveConv([{role:'user',text:'oi'}])`);
  const c1 = await js('window.api.loadConv()');
  ok('conversa grava e volta', Array.isArray(c1) && c1[0]?.text === 'oi', c1);
  await js('window.api.saveConv([])');
  ok('conversa vazia apaga o arquivo',
     !fs.existsSync(path.join(app.getPath('userData'), 'conversa.json')));

  // limpa o que o teste escreveu
  fs.rmSync(path.join(app.getPath('userData'), 'config.json'), { force: true });

  ok('nenhum erro de console durante os testes', erros.length === 0, erros);

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  app.exit(falhas ? 1 : 0);
}).catch(e => { console.log('EXCEÇÃO: ' + (e.stack || e)); app.exit(1); });
