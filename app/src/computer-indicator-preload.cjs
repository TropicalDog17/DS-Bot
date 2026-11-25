const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('computerIndicator', {
  act: (kind, botId) => ipcRenderer.send('ds-bot:computer-indicator:act', kind, botId),
})
