const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('veyraWindow', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close')
});
