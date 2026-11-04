const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  list: () => ipcRenderer.invoke('picker:list'),
  choose: (id, audio) => ipcRenderer.send('picker:choose', id ? { id: String(id), audio: !!audio } : null),
});
