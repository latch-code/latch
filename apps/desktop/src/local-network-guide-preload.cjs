'use strict'
// The Local Network guide's preload (local-network-guide.cjs): the page gets close() and nothing else. Main accepts
// the message only from the guide's own window.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld(
  'latchGuide',
  Object.freeze({
    close: () => ipcRenderer.send('latch:local-network-guide:close'),
  }),
)
