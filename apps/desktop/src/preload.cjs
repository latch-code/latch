'use strict'
// The only thing the renderer learns about the shell. Keys and credentials stay in the main process.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('latchShell', Object.freeze({ kind: 'electron', devMode: true, platform: process.platform }))
