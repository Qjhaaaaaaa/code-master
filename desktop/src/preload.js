const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  on: (channel, callback) => {
    const handler = (_, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    // Store handler reference for cleanup
    if (!window._ccHandlers) window._ccHandlers = {};
    if (!window._ccHandlers[channel]) window._ccHandlers[channel] = [];
    window._ccHandlers[channel].push({ callback, handler });
  },
  off: (channel, callback) => {
    if (window._ccHandlers && window._ccHandlers[channel]) {
      const idx = window._ccHandlers[channel].findIndex(h => h.callback === callback);
      if (idx !== -1) {
        ipcRenderer.removeListener(channel, window._ccHandlers[channel][idx].handler);
        window._ccHandlers[channel].splice(idx, 1);
      }
    }
  }
});
