const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayAPI', {
  action: (name) => ipcRenderer.send('tray-action', name),
  getState: () => ipcRenderer.invoke('tray-state'),
  onPinChanged: (cb) => ipcRenderer.on('pin-changed', (e, v) => cb(v)),
});
