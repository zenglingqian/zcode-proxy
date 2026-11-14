// desktop/preload.js — 渲染进程安全桥（contextBridge）
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zc', {
  getState: () => ipcRenderer.invoke('state'),
  toggleProxy: (on) => ipcRenderer.invoke('toggle', on),
  addAccount: (family) => ipcRenderer.invoke('account:add', family),
  cancelLogin: () => ipcRenderer.invoke('account:cancelLogin'),
  removeAccount: (family) => ipcRenderer.invoke('account:remove', family),
  testAccount: (family) => ipcRenderer.invoke('account:test', family),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  onUpdate: (channel, cb) => {
    const valid = ['state', 'log'];
    if (!valid.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
