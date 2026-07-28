/* Única ponte entre a interface e o processo principal.
   A interface não tem acesso a Node, a arquivos nem à rede — só a estas funções. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getCfg:    ()        => ipcRenderer.invoke('cfg:get'),
  setCfg:    (cfg)     => ipcRenderer.invoke('cfg:set', cfg),
  loadConv:  ()        => ipcRenderer.invoke('conv:load'),
  saveConv:  (conv)    => ipcRenderer.invoke('conv:save', conv),
  models:    (p, k)    => ipcRenderer.invoke('models:list', { provider: p, key: k }),
  chat:      (payload) => ipcRenderer.invoke('chat:start', payload),
  abort:     (id)      => ipcRenderer.send('chat:abort', id),
  exportMd:  (t, n)    => ipcRenderer.invoke('export:md', { texto: t, nome: n }),
  confirmar: (t, d)    => ipcRenderer.invoke('confirmar', { titulo: t, texto: d }),
  avisar:    (t, d)    => ipcRenderer.invoke('avisar',    { titulo: t, texto: d }),
  info:      ()        => ipcRenderer.invoke('app:info'),
  abrirPasta:()        => ipcRenderer.invoke('pasta:abrir'),

  onChunk: (fn) => ipcRenderer.on('chat', (_e, d) => fn(d)),
  onMenu:  (fn) => ipcRenderer.on('menu', (_e, d) => fn(d))
});
