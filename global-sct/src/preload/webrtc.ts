import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('sctWebRtc', {
  onCommand: (listener: (command: unknown) => void) => {
    ipcRenderer.on('webrtc:command', (_event: IpcRendererEvent, command: unknown) => listener(command))
  },
  send: (event: unknown) => { ipcRenderer.send('webrtc:event', event) }
})
