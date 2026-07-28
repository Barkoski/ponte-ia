/* Ponte IA — interface.
   Sem acesso a Node, a arquivos ou à rede: tudo passa por window.api (preload.js). */
'use strict';

/* ========================= 1. configuração ========================= */

const DEFAULT_SYS =
`Você é um dos dois assistentes trabalhando lado a lado com o usuário: um é o Claude (Anthropic), o outro é o ChatGPT (OpenAI). O usuário compara e combina as duas respostas.

Regras:
- Nunca invente fatos, números, datas, referências, artigos de lei ou jurisprudência. Se não souber ou não tiver a informação, diga isso explicitamente.
- Quando citar algo de memória, avise que é de memória e pode estar desatualizado.
- Quando a resposta do outro modelo aparecer marcada no histórico, leia com atenção: aponte o que está errado ou faltando antes de concordar. Discordância fundamentada é mais útil que eco.
- Seja direto e denso. Sem preâmbulo, sem repetir a pergunta.`;

const DEF = {
  kAnthropic:'', kOpenai:'',
  mClaude:'claude-sonnet-5', mGpt:'', mGptManual:'',
  effort:'high', thinking:'summarized',
  sysPrompt:DEFAULT_SYS, persist:true, theme:'light',
  modelsC:['claude-sonnet-5'], modelsG:[],
  mode:'parallel', synth:'claude'
};

let cfg = { ...DEF };
let seguro = false;          // criptografia do Windows disponível?
let conv = [];
let pending = [];
let busy = false;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function salvarCfg(){ window.api.setCfg(cfg).then(r => { seguro = r.seguro; }); }
function salvarConv(){ window.api.saveConv(cfg.persist ? conv : []); }

/* ========================= 2. markdown ========================= */

function md(src){
  if(!src) return '';
  const blocks = [];
  // marcador sorteado a cada chamada: nao colide com nada que o modelo escreva,
  // nao e espaco (sobrevive ao corte de fim de linha) e nao e tocado pelo escape
  const MARCA = "⦙"+Math.random().toString(36).slice(2,8)+"⦙";
  let t = String(src).replace(/```(\w*)\r?\n([\s\S]*?)```/g, (m,lang,code)=>{
    blocks.push('<pre><code>'+esc(code.replace(/\n$/,''))+'</code></pre>');
    return MARCA+(blocks.length-1)+MARCA;
  });
  t = esc(t);

  const lines = t.split(/\r?\n/), out = [];
  let list=null, para=[];
  const flushP = () => { if(para.length){ out.push('<p>'+para.join('<br>')+'</p>'); para=[]; } };
  const flushL = () => { if(list){ out.push('<'+list.tag+'>'+list.items.map(i=>'<li>'+i+'</li>').join('')+'</'+list.tag+'>'); list=null; } };

  for (const raw of lines){
    const line = raw.replace(/\s+$/,'');
    if (!line.trim()){ flushP(); flushL(); continue; }
    let m;
    if (new RegExp("^"+MARCA+"\\d+"+MARCA+"$").test(line)){ flushP(); flushL(); out.push(line); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))){
      const h = Math.min(4, m[1].length+2);
      flushP(); flushL(); out.push('<h'+h+'>'+m[2]+'</h'+h+'>'); continue;
    }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))){ flushP(); if(!list||list.tag!=='ul'){flushL();list={tag:'ul',items:[]};} list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))){ flushP(); if(!list||list.tag!=='ol'){flushL();list={tag:'ol',items:[]};} list.items.push(m[1]); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))){ flushP(); flushL(); out.push('<blockquote>'+m[1]+'</blockquote>'); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())){ flushP(); flushL(); out.push('<hr>'); continue; }
    flushL(); para.push(line);
  }
  flushP(); flushL();

  let html = out.join('');
  html = html.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g,'$1<em>$2</em>');
  html = html.replace(new RegExp(MARCA+"(\\d+)"+MARCA,"g"),(m,i)=>blocks[+i]);
  return html;
}

function setStatus(s, trabalhando){
  const el=$('status'); el.textContent=s;
  el.className = 'pill'+(trabalhando?' work':'');
}
function scrollDown(){ const m=$('main'); m.scrollTop = m.scrollHeight; }

/* ========================= 3. renderização ========================= */

const META = { user:{cls:'user',name:'Você'}, claude:{cls:'claude',name:'Claude'}, gpt:{cls:'gpt',name:'ChatGPT'} };
const NAME = { claude:'Claude', gpt:'ChatGPT' };
const OTHER= { claude:'gpt', gpt:'claude' };

function cardEl(role, tag, error){
  const m = META[role];
  const card = document.createElement('div');
  card.className = 'card '+m.cls+(error?' err':'');
  const hd = document.createElement('div'); hd.className='hd';
  const nome = document.createElement('span'); nome.textContent = error ? m.name+' — erro' : m.name;
  hd.appendChild(nome);
  if (tag){ const t=document.createElement('span'); t.className='tag'; t.textContent=tag; hd.appendChild(t); }
  const bd = document.createElement('div'); bd.className='bd';
  if (role!=='user'){
    const cp=document.createElement('button'); cp.className='copy ghost'; cp.textContent='copiar';
    cp.onclick=()=>{ navigator.clipboard.writeText(card.__texto||bd.innerText);
                     cp.textContent='copiado'; setTimeout(()=>cp.textContent='copiar',1200); };
    hd.appendChild(cp);
  }
  card.appendChild(hd); card.appendChild(bd);
  return {card, bd, nome};
}

function attsEl(atts){
  if(!atts||!atts.length) return null;
  const box=document.createElement('div'); box.className='atts';
  for(const a of atts){
    const el=document.createElement('span'); el.className='att';
    if(a.kind==='image'){ const im=document.createElement('img'); im.src='data:'+a.media_type+';base64,'+a.data; el.appendChild(im); }
    el.appendChild(document.createTextNode(a.name));
    box.appendChild(el);
  }
  return box;
}

function renderAll(){
  const c=$('conv'); c.innerHTML='';
  if(!conv.length){
    c.innerHTML='<div class="empty"><h2>Duas opiniões, uma conversa</h2>'+
      'Escreva embaixo. Conforme o modo escolhido, Claude e ChatGPT respondem, se criticam ou chegam a uma síntese.'+
      '<br><br><kbd>Ctrl</kbd>+<kbd>Enter</kbd> envia &nbsp;·&nbsp; <kbd>Ctrl</kbd>+<kbd>D</kbd> cruza as respostas'+
      ' &nbsp;·&nbsp; <kbd>Ctrl</kbd>+<kbd>,</kbd> configurações</div>';
    renderFollowup(); return;
  }
  let i=0;
  while(i<conv.length){
    const it=conv[i];
    if(it.role==='user'){ c.appendChild(userTurn(it)); i++; continue; }
    const grp=[]; let j=i;
    while(j<conv.length && conv[j].role!=='user' && grp.length<2){
      if(grp.length && ((conv[j].tag||'')!==(grp[0].tag||'') || conv[j].role===grp[0].role)) break;
      grp.push(conv[j]); j++;
    }
    const t=document.createElement('div');
    t.className='turn'+(grp.length===2?' par':'');
    (grp.length===2?grp:[it]).forEach(g=>t.appendChild(staticCard(g)));
    c.appendChild(t); i = grp.length===2 ? j : i+1;
  }
  renderFollowup(); scrollDown();
}

function userTurn(it){
  const t=document.createElement('div'); t.className='turn';
  const {card,bd}=cardEl('user');
  bd.innerHTML=md(it.text);
  const a=attsEl(it.atts); if(a) bd.appendChild(a);
  t.appendChild(card); return t;
}

function staticCard(it){
  const {card,bd}=cardEl(it.role, it.tag, it.error);
  card.__texto = it.text;
  if(it.thinking){
    const d=document.createElement('details'); d.className='think';
    const s=document.createElement('summary'); s.textContent='raciocínio';
    const x=document.createElement('div'); x.className='txt'; x.textContent=it.thinking;
    d.appendChild(s); d.appendChild(x); bd.appendChild(d);
  }
  const body=document.createElement('div'); body.innerHTML=md(it.text); bd.appendChild(body);
  return card;
}

function liveCard(container, role, tag){
  const {card,bd,nome}=cardEl(role, tag);
  const think=document.createElement('details'); think.className='think oculto';
  const s=document.createElement('summary'); s.textContent='raciocínio';
  const tx=document.createElement('div'); tx.className='txt';
  think.appendChild(s); think.appendChild(tx);
  const body=document.createElement('div'); body.className='blink';
  bd.appendChild(think); bd.appendChild(body);
  container.appendChild(card); scrollDown();

  let txt='', thk='';
  const near=()=>{ const m=$('main'); return m.scrollHeight-m.scrollTop-m.clientHeight < 140; };
  return {
    addText(x){ const k=near(); txt+=x; card.__texto=txt; body.innerHTML=md(txt); if(k) scrollDown(); },
    addThink(x){ const k=near(); thk+=x; think.classList.remove('oculto'); tx.textContent=thk; if(k) scrollDown(); },
    fail(msg){ card.classList.add('err'); nome.textContent=META[role].name+' — erro';
               body.className=''; body.innerHTML=md(msg); txt=msg; card.__texto=msg; },
    done(){ body.className=''; return {text:txt, thinking:thk}; }
  };
}

/* ========================= 4. mensagens para cada API ========================= */

const LBL_C='[Resposta do ChatGPT — outro modelo nesta mesma conversa]';
const LBL_G='[Resposta do Claude — outro modelo nesta mesma conversa]';

function collapse(who){
  const otherLbl = who==='claude' ? LBL_C : LBL_G;
  const turns=[];
  for(const it of conv){
    if(it.error) continue;
    const isSelf = it.role===who;
    const role = isSelf ? 'assistant' : 'user';
    let text = it.text;
    if(!isSelf && it.role!=='user') text = otherLbl+'\n'+text;
    const last = turns[turns.length-1];
    if(last && last.role===role){
      last.text += '\n\n'+text;
      if(it.atts) last.atts=(last.atts||[]).concat(it.atts);
    } else turns.push({role, text, atts:(it.atts||[]).slice()});
  }
  while(turns.length && turns[0].role==='assistant') turns.shift();
  return turns;
}

function withExtra(turns, extra){
  if(!extra) return turns;
  const t=turns.map(x=>({role:x.role,text:x.text,atts:x.atts}));
  const last=t[t.length-1];
  if(last && last.role==='user') last.text += '\n\n---\n'+extra;
  else t.push({role:'user', text:extra, atts:[]});
  return t;
}

function claudeMessages(extra){
  return withExtra(collapse('claude'), extra).map(t=>{
    if(t.role==='assistant') return {role:'assistant', content:t.text};
    const parts=[];
    for(const a of (t.atts||[])){
      if(a.kind==='image') parts.push({type:'image', source:{type:'base64', media_type:a.media_type, data:a.data}});
      else if(a.kind==='pdf') parts.push({type:'document', source:{type:'base64', media_type:'application/pdf', data:a.data}});
    }
    parts.push({type:'text', text:t.text});
    return {role:'user', content:parts};
  });
}

function gptMessages(extra){
  return withExtra(collapse('gpt'), extra).map(t=>{
    if(t.role==='assistant') return {role:'assistant', content:t.text};
    const imgs=(t.atts||[]).filter(a=>a.kind==='image');
    const pdfs=(t.atts||[]).filter(a=>a.kind==='pdf');
    let text=t.text;
    if(pdfs.length) text += '\n\n('+pdfs.length+' PDF(s) foram anexados nesta conversa e enviados apenas ao Claude: '+
      pdfs.map(p=>p.name).join(', ')+'. Se o conteúdo for necessário, peça ao usuário para colar o texto.)';
    if(!imgs.length) return {role:'user', content:text};
    const parts=imgs.map(a=>({type:'image_url', image_url:{url:'data:'+a.media_type+';base64,'+a.data}}));
    parts.push({type:'text', text});
    return {role:'user', content:parts};
  });
}

/* ========================= 5. streaming via processo principal ========================= */

let seq=0;
const live = new Map();
const ativos = new Set();

window.api.onChunk(d => {
  const h = live.get(d.id);
  if(!h) return;
  if(d.type==='text')       h.sink.addText(d.text);
  else if(d.type==='think') h.sink.addThink(d.text);
  else {
    live.delete(d.id); ativos.delete(d.id);
    if(d.type==='done') h.resolve();
    else if(d.type==='aborted'){ const e=new Error('Interrompido'); e.abortado=true; h.reject(e); }
    else h.reject(new Error(d.message || 'erro desconhecido'));
  }
});

function stream(provider, body, sink){
  const id = 'j'+(++seq);
  return new Promise((resolve,reject)=>{
    live.set(id,{sink,resolve,reject}); ativos.add(id);
    window.api.chat({id, provider, body}).catch(e=>{
      live.delete(id); ativos.delete(id); reject(e);
    });
  });
}
function abortarTudo(){ for(const id of ativos) window.api.abort(id); }

function callClaude(sink, extra){
  const body = {
    model: cfg.mClaude,
    max_tokens: 32000,
    system: cfg.sysPrompt || undefined,
    messages: claudeMessages(extra),
    output_config: { effort: cfg.effort }
  };
  body.thinking = cfg.thinking==='disabled' ? {type:'disabled'} : {type:'adaptive', display:cfg.thinking};
  // desligar o raciocínio só é aceito até o esforço "high"
  if (cfg.thinking==='disabled' && (cfg.effort==='xhigh'||cfg.effort==='max')) body.output_config.effort='high';
  return stream('claude', body, sink);
}

function callGPT(sink, extra){
  const model = (cfg.mGptManual||'').trim() || cfg.mGpt;
  if(!model) return Promise.reject(new Error('Nenhum modelo OpenAI selecionado. Abra Configurações e clique em "Buscar".'));
  const messages = gptMessages(extra);
  if(cfg.sysPrompt) messages.unshift({role:'system', content:cfg.sysPrompt});
  return stream('gpt', {model, messages}, sink);
}

const CALL = { claude: callClaude, gpt: callGPT };

/* ========================= 6. orquestração ========================= */

function newTurn(par){
  const t=document.createElement('div'); t.className='turn'+(par?' par':'');
  $('conv').appendChild(t); return t;
}

async function runRound(fn){
  if(busy) return;
  busy=true;
  $('btnSend').disabled=true; $('btnStop').classList.remove('oculto');
  renderFollowup(); setStatus('trabalhando…', true);
  try { await fn(); }
  finally {
    busy=false;
    $('btnSend').disabled=false; $('btnStop').classList.add('oculto');
    setStatus('pronto'); renderFollowup(); scrollDown();
  }
}

async function runOne(container, who, tag, extra){
  const sink=liveCard(container, who, tag);
  try{
    await CALL[who](sink, extra);
    const r=sink.done();
    const item={role:who, text:r.text, tag, thinking:r.thinking||''};
    conv.push(item); salvarConv();
    return item;
  }catch(e){
    if(e.abortado){ sink.fail('_Interrompido._'); sink.done(); return null; }
    const msg=String(e.message||e);
    sink.fail(msg); sink.done();
    conv.push({role:who, text:msg, tag, error:true}); salvarConv();
    return null;
  }
}

async function runPair(container, tag, extraC, extraG){
  const cC=liveCard(container,'claude',tag), cG=liveCard(container,'gpt',tag);
  const one = async (who, sink, extra) => {
    try{
      await CALL[who](sink, extra);
      const r=sink.done();
      return {role:who, text:r.text, tag, thinking:r.thinking||''};
    }catch(e){
      if(e.abortado){ sink.fail('_Interrompido._'); sink.done(); return null; }
      const m=String(e.message||e); sink.fail(m); sink.done();
      return {role:who, text:m, tag, error:true};
    }
  };
  const [rc,rg] = await Promise.all([one('claude',cC,extraC), one('gpt',cG,extraG)]);
  if(rc) conv.push(rc);
  if(rg) conv.push(rg);
  salvarConv();
  return {rc,rg};
}

const EX = {
  cross: other =>
    'A resposta do '+other+' à mesma pergunta está marcada acima no histórico. Analise-a de forma independente:\n\n'+
    '**Onde ele acertou** — em uma linha, sem repetir o conteúdo dele.\n'+
    '**Onde errou, omitiu ou exagerou** — cada ponto com a razão.\n'+
    '**Onde você discorda** — com fundamento, não por preferência de estilo.\n'+
    '**O que você revisa na sua própria resposta** depois de ler a dele. Se não muda nada, diga isso e por quê.\n\n'+
    'Se ele afirmou algo que você não consegue verificar, marque como não verificado em vez de aceitar por educação.',
  gptCritique:
    'O Claude já respondeu acima (marcado no histórico). Antes de dar sua resposta: aponte objetivamente o que ele errou, o que deixou de fora e onde você discorda, com justificativa. Depois apresente sua própria resposta. Não repita o que ele já disse corretamente — apenas confirme em uma linha.',
  claudeReply:
    'O ChatGPT criticou sua resposta anterior (marcada no histórico). Responda ponto a ponto: aceite e corrija o que for procedente, e refute com fundamento o que não for. Ao final, entregue a versão revisada da resposta.',
  synth:
    'Acima estão duas respostas independentes à mesma pergunta — a sua e a do outro modelo. Produza agora uma síntese, nesta estrutura:\n\n**Em que concordam** — os pontos sustentados pelos dois.\n**Em que divergem** — cada divergência, quem sustenta o quê, e qual posição se sustenta melhor e por quê.\n**Resposta final** — a melhor resposta possível combinando as duas, sem repetir o que já foi dito acima.\n\nSe uma das respostas contiver erro claro, diga qual e por quê.'
};

async function send(){
  if(busy) return;
  const text=$('input').value.trim();
  if(!text && !pending.length) return;

  const mode=$('mode').value;
  if(mode!=='gpt'    && !cfg.kAnthropic) return openCfg('Falta a chave da Anthropic.');
  if(mode!=='claude' && !cfg.kOpenai)    return openCfg('Falta a chave da OpenAI.');

  const atts=pending.slice(); pending=[]; renderPending();
  $('input').value='';
  const vazio = !conv.length;
  conv.push({role:'user', text, atts}); salvarConv();
  if(vazio) renderAll(); else $('conv').appendChild(userTurn(conv[conv.length-1]));
  scrollDown();

  await runRound(async () => {
    if(mode==='claude'||mode==='gpt') await runOne(newTurn(), mode);
    else if(mode==='parallel') await runPair(newTurn(true));
    else if(mode==='debate'){
      if(!await runOne(newTurn(),'claude','1ª resposta')) return;
      if(!await runOne(newTurn(),'gpt','crítica + resposta', EX.gptCritique)) return;
      await runOne(newTurn(),'claude','réplica', EX.claudeReply);
    }
    else if(mode==='consensus'){
      const {rc,rg}=await runPair(newTurn(true));
      if((rc&&!rc.error)||(rg&&!rg.error))
        await runOne(newTurn(), $('synth').value, 'síntese', EX.synth);
    }
  });
}

/* ---- ações de acompanhamento ---- */

function lastRound(){
  const out=[];
  for(let i=conv.length-1; i>=0 && conv[i].role!=='user'; i--)
    if(!conv[i].error) out.unshift(conv[i]);
  return out;
}

function renderFollowup(){
  const bar=$('followup'); bar.innerHTML='';
  if(busy) return;
  const round=lastRound();
  if(!round.length) return;
  const has = w => round.some(x=>x.role===w);

  const box=document.createElement('div'); box.className='fu';
  const lbl=document.createElement('span'); lbl.className='lbl'; lbl.textContent='e agora:';
  box.appendChild(lbl);
  const add=(txt,cls,fn)=>{ const b=document.createElement('button'); b.className=cls; b.textContent=txt; b.onclick=fn; box.appendChild(b); };

  if(has('claude') && has('gpt')) add('⇄  cada um analisa o outro','both',crossBoth);
  if(has('gpt'))    add('→  Claude analisa'+(has('claude')?'':' e responde'),'c',()=>crossOne('claude'));
  if(has('claude')) add('→  ChatGPT analisa'+(has('gpt')?'':' e responde'),'g',()=>crossOne('gpt'));
  if(has('claude') && has('gpt')) add('⚖  síntese ('+NAME[$('synth').value]+')','',doSynth);

  bar.appendChild(box);
}

function podeSeguir(){ return !busy && lastRound().length>0; }
function crossOne(who){
  return runRound(async()=>{ await runOne(newTurn(), who, 'analisando '+NAME[OTHER[who]], EX.cross(NAME[OTHER[who]])); });
}
function crossBoth(){
  return runRound(async()=>{ await runPair(newTurn(true), 'análise cruzada', EX.cross('ChatGPT'), EX.cross('Claude')); });
}
function doSynth(){
  return runRound(async()=>{ await runOne(newTurn(), $('synth').value, 'síntese', EX.synth); });
}

/* ========================= 7. anexos ========================= */

function renderPending(){
  const box=$('pend'); box.innerHTML='';
  pending.forEach((a,i)=>{
    const el=document.createElement('span'); el.className='att';
    if(a.kind==='image'){ const im=document.createElement('img'); im.src='data:'+a.media_type+';base64,'+a.data; el.appendChild(im); }
    el.appendChild(document.createTextNode(a.name));
    const x=document.createElement('b'); x.textContent='×'; x.title='remover';
    x.onclick=()=>{ pending.splice(i,1); renderPending(); };
    el.appendChild(x); box.appendChild(el);
  });
  $('hint').textContent = pending.some(a=>a.kind==='pdf')
    ? 'PDF vai só para o Claude — o ChatGPT recebe um aviso, não o arquivo.' : '';
}

function fileToB64(file){
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(String(r.result).split(',')[1]);
    r.onerror=rej; r.readAsDataURL(file);
  });
}

async function addFiles(files, kind){
  for(const f of files){
    if(f.size > 20*1024*1024){ await window.api.avisar('Arquivo grande demais', '"'+f.name+'" passa de 20 MB e não foi anexado.'); continue; }
    pending.push({kind, name:f.name, media_type:f.type||(kind==='pdf'?'application/pdf':'image/png'), data:await fileToB64(f)});
  }
  renderPending();
}

/* ========================= 8. modelos ========================= */

function fillSelect(sel, list, chosen){
  sel.innerHTML='';
  const items=list.slice();
  if(chosen && !items.includes(chosen)) items.unshift(chosen);
  if(!items.length){ const o=document.createElement('option'); o.value=''; o.textContent='— clique em Buscar —'; sel.appendChild(o); return; }
  for(const m of items){ const o=document.createElement('option'); o.value=m; o.textContent=m; sel.appendChild(o); }
  sel.value = chosen && items.includes(chosen) ? chosen : items[0];
}

async function buscarModelos(provider){
  const campo = provider==='claude' ? 'kAnthropic' : 'kOpenai';
  const key = $(campo).value.trim();
  const btn = $(provider==='claude' ? 'btnLoadC' : 'btnLoadG');
  if(!key) return window.api.avisar('Falta a chave', 'Cole a chave antes de buscar os modelos.');
  btn.disabled=true; btn.textContent='…';
  const r = await window.api.models(provider, key);
  btn.disabled=false; btn.textContent='Buscar';
  if(!r.ok) return window.api.avisar('Não deu para buscar os modelos', r.erro);
  if(provider==='claude'){ cfg.modelsC=r.list; fillSelect($('mClaude'), r.list, $('mClaude').value||cfg.mClaude); }
  else { cfg.modelsG=r.list; fillSelect($('mGpt'), r.list, $('mGpt').value||cfg.mGpt); }
}

/* ========================= 9. modal ========================= */

function openCfg(msg){
  $('kAnthropic').value=cfg.kAnthropic;
  $('kOpenai').value=cfg.kOpenai;
  fillSelect($('mClaude'), cfg.modelsC, cfg.mClaude);
  fillSelect($('mGpt'), cfg.modelsG, cfg.mGpt);
  $('mGptManual').value=cfg.mGptManual;
  $('effort').value=cfg.effort;
  $('thinking').value=cfg.thinking;
  $('sysPrompt').value=cfg.sysPrompt;
  $('persist').checked=!!cfg.persist;
  $('segAviso').className = 'warn'+(seguro?' ok':'');
  $('segAviso').innerHTML = seguro
    ? '<b>Chaves protegidas.</b> Ficam gravadas criptografadas pelo Windows, legíveis só pela sua conta de usuário. '+
      'O texto das conversas, porém, é enviado à Anthropic e à OpenAI — não cole dados sigilosos de processos sem estar ciente disso.'
    : '<b>Atenção.</b> A criptografia do Windows não está disponível nesta máquina, então as chaves ficam gravadas em texto puro. '+
      'O texto das conversas é enviado à Anthropic e à OpenAI.';
  $('ov').classList.add('on');
  if(msg) setStatus(msg);
  setTimeout(()=>$( cfg.kAnthropic ? 'sysPrompt' : 'kAnthropic').focus(), 50);
}
function closeCfg(){ $('ov').classList.remove('on'); }

function saveCfg(){
  cfg.kAnthropic=$('kAnthropic').value.trim();
  cfg.kOpenai=$('kOpenai').value.trim();
  cfg.mClaude=$('mClaude').value||DEF.mClaude;
  cfg.mGpt=$('mGpt').value;
  cfg.mGptManual=$('mGptManual').value.trim();
  cfg.effort=$('effort').value;
  cfg.thinking=$('thinking').value;
  cfg.sysPrompt=$('sysPrompt').value;
  cfg.persist=$('persist').checked;
  salvarCfg(); salvarConv(); closeCfg(); setStatus('pronto');
}

/* ========================= 10. exportar, limpar, tema ========================= */

async function exportMd(){
  if(!conv.length) return window.api.avisar('Nada para exportar', 'A conversa está vazia.');
  const nome={user:'Você', claude:'Claude', gpt:'ChatGPT'};
  let out='# Ponte IA — '+new Date().toLocaleString('pt-BR')+'\n\n'+
          '_Claude: '+cfg.mClaude+' · ChatGPT: '+((cfg.mGptManual||cfg.mGpt)||'—')+'_\n\n';
  for(const it of conv){
    out += '## '+nome[it.role]+(it.tag?' ('+it.tag+')':'')+(it.error?' — ERRO':'')+'\n\n'+it.text+'\n\n';
    if(it.atts?.length) out += '_anexos: '+it.atts.map(a=>a.name).join(', ')+'_\n\n';
  }
  const arq='ponte-ia-'+new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')+'.md';
  const r=await window.api.exportMd(out, arq);
  if(r.ok) setStatus('salvo');
}

async function novaConversa(){
  if(!conv.length) return;
  if(!await window.api.confirmar('Nova conversa', 'A conversa atual será apagada. Exporte antes se quiser guardar.')) return;
  conv=[]; salvarConv(); renderAll();
}

function aplicarTema(){ document.documentElement.setAttribute('data-theme', cfg.theme); }
function alternarTema(){ cfg.theme = cfg.theme==='light'?'dark':'light'; aplicarTema(); salvarCfg(); }

/* ========================= 11. ligações ========================= */

$('btnSend').onclick=send;
$('btnStop').onclick=abortarTudo;
$('btnCfg').onclick=()=>openCfg();
$('btnSave').onclick=saveCfg;
$('btnCancel').onclick=closeCfg;
$('btnLoadC').onclick=()=>buscarModelos('claude');
$('btnLoadG').onclick=()=>buscarModelos('gpt');
$('btnExport').onclick=exportMd;
$('btnNova').onclick=novaConversa;
$('btnWipe').onclick=async()=>{
  if(!await window.api.confirmar('Apagar tudo', 'Isso apaga as chaves de API, as configurações e o histórico. Não dá para desfazer.')) return;
  cfg={...DEF}; conv=[];
  salvarCfg(); salvarConv(); aplicarTema(); renderAll(); closeCfg(); setStatus('tudo apagado');
};
$('mode').onchange=()=>{ cfg.mode=$('mode').value; salvarCfg(); };
$('synth').onchange=()=>{ cfg.synth=$('synth').value; salvarCfg(); renderFollowup(); };

$('btnImg').onclick=()=>$('fImg').click();
$('btnPdf').onclick=()=>$('fPdf').click();
$('fImg').onchange=e=>{ addFiles(e.target.files,'image'); e.target.value=''; };
$('fPdf').onchange=e=>{ addFiles(e.target.files,'pdf');   e.target.value=''; };

$('input').addEventListener('keydown', e=>{
  if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); send(); }
});
$('input').addEventListener('paste', e=>{
  const imgs=[...(e.clipboardData?.items||[])].filter(i=>i.type.startsWith('image/'));
  if(imgs.length){ e.preventDefault(); addFiles(imgs.map(i=>i.getAsFile()).filter(Boolean),'image'); }
});

// arrastar e soltar arquivos na janela
document.addEventListener('dragover', e=>e.preventDefault());
document.addEventListener('drop', e=>{
  e.preventDefault();
  const fs=[...(e.dataTransfer?.files||[])];
  const imgs=fs.filter(f=>f.type.startsWith('image/'));
  const pdfs=fs.filter(f=>f.type==='application/pdf');
  if(imgs.length) addFiles(imgs,'image');
  if(pdfs.length) addFiles(pdfs,'pdf');
});

$('ov').addEventListener('click', e=>{ if(e.target===$('ov')) closeCfg(); });
document.addEventListener('keydown', e=>{
  if(e.key==='Escape'){
    if($('ov').classList.contains('on')) closeCfg();
    else if(busy) abortarTudo();
  }
});

window.api.onMenu(acao=>{
  if(acao==='nova') novaConversa();
  else if(acao==='exportar') exportMd();
  else if(acao==='config') openCfg();
  else if(acao==='enviar') send();
  else if(acao==='parar') abortarTudo();
  else if(acao==='tema') alternarTema();
  else if(acao==='cruzar'){ if(podeSeguir()) crossBoth(); }
  else if(acao==='sintese'){
    const r=lastRound();
    if(podeSeguir() && r.some(x=>x.role==='claude') && r.some(x=>x.role==='gpt')) doSynth();
  }
});

/* ========================= 12. arranque ========================= */

(async function init(){
  const r = await window.api.getCfg();
  cfg = { ...DEF, ...(r.cfg||{}) };
  seguro = r.seguro;
  aplicarTema();
  $('mode').value  = cfg.mode  || 'parallel';
  $('synth').value = cfg.synth || 'claude';

  conv = cfg.persist ? (await window.api.loadConv()) : [];
  renderAll();

  const info = await window.api.info();
  $('infoRodape').innerHTML = 'Ponte IA '+info.versao+' · dados em <a id="lnkPasta">'+esc(info.pasta)+'</a>';
  $('lnkPasta').onclick = () => window.api.abrirPasta();

  if(!cfg.kAnthropic && !cfg.kOpenai) openCfg();
  $('input').focus();
})();
