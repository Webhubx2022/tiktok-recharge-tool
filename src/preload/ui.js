const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'auth:state', 'auth:setup', 'auth:unlock', 'auth:lock', 'auth:change',
  'customers:list', 'customers:create', 'customers:update', 'customers:remove',
  'tabs:open', 'tabs:close', 'tabs:activate', 'tabs:state',
  'view:overlay', 'view:nav',
  'qr:copy', 'qr:whatsapp', 'qr:relogin',
  'capture:now',
  'tx:list', 'tx:copy', 'tx:open', 'tx:whatsapp',
  'receipts:folder',
  'cards:list', 'cards:add', 'cards:remove', 'cards:default', 'cards:fill',
  'settings:get', 'settings:set',
]);

const EVENTS = new Set(['tabs', 'customers', 'toast', 'purchase', 'locked']);

contextBridge.exposeInMainWorld('api', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) return;
    ipcRenderer.on(channel, (_e, data) => fn(data));
  },
  setBounds(rect) {
    ipcRenderer.send('view:bounds', rect);
  },
});
