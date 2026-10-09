import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type { DesktopApi } from '@shared/ipc'
import type { StreamEvent } from '@shared/llm'
import type { SetupProgress } from '@shared/localModels'

let seq = 0

const api: DesktopApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (s) => ipcRenderer.invoke('settings:save', s)
  },
  keys: {
    set: (id, key) => ipcRenderer.invoke('keys:set', id, key)
  },
  llm: {
    chat(req, onEvent) {
      const requestId = `r${Date.now().toString(36)}_${seq++}`
      const listener = (_e: IpcRendererEvent, id: string, ev: StreamEvent) => {
        if (id === requestId) onEvent(ev)
      }
      ipcRenderer.on('llm:event', listener)
      const done = ipcRenderer
        .invoke('llm:chat', requestId, req)
        .finally(() => ipcRenderer.removeListener('llm:event', listener))
      return { requestId, done }
    },
    abort: (id) => ipcRenderer.invoke('llm:abort', id),
    models: (id) => ipcRenderer.invoke('llm:models', id)
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (p) => ipcRenderer.invoke('profiles:save', p),
    delete: (id) => ipcRenderer.invoke('profiles:delete', id),
    exportToFile: (json, name) => ipcRenderer.invoke('profiles:export', json, name),
    importFromFile: () => ipcRenderer.invoke('profiles:import')
  },
  workspace: {
    get: (id) => ipcRenderer.invoke('workspace:get', id),
    save: (id, ws) => ipcRenderer.invoke('workspace:save', id, ws)
  },
  conversation: {
    get: (id) => ipcRenderer.invoke('conversation:get', id),
    save: (id, c) => ipcRenderer.invoke('conversation:save', id, c)
  },
  design: {
    get: (id, part) => ipcRenderer.invoke('design:get', id, part),
    save: (id, part, data) => ipcRenderer.invoke('design:save', id, part, data)
  },
  reports: {
    save: (report) => ipcRenderer.invoke('reports:save', report),
    openFolder: () => ipcRenderer.invoke('reports:openFolder')
  },
  issues: {
    append: (entries) => ipcRenderer.invoke('issues:append', entries)
  },
  files: {
    openData: () => ipcRenderer.invoke('files:openData'),
    openDataFolder: () => ipcRenderer.invoke('files:openDataFolder')
  },
  local: {
    probe: () => ipcRenderer.invoke('local:probe'),
    setup(model, onProgress) {
      const id = `ls${Date.now().toString(36)}_${seq++}`
      const listener = (_e: IpcRendererEvent, sid: string, p: SetupProgress) => {
        if (sid === id) onProgress(p)
      }
      ipcRenderer.on('local:progress', listener)
      const done = ipcRenderer.invoke('local:setup', id, model).finally(() => ipcRenderer.removeListener('local:progress', listener))
      return { id, done }
    },
    cancel: (id) => ipcRenderer.invoke('local:cancel', id)
  }
}

contextBridge.exposeInMainWorld('api', api)

// Test harness only (SMITH_CAPTURE): lets a capture script drive the app as a learner would.
if (process.env.SMITH_CAPTURE) contextBridge.exposeInMainWorld('smithDevHooks', true)
