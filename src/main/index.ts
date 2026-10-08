import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from 'electron'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import type { ChatRequest, ChatResult, StreamEvent } from '@shared/llm'
import { runBenchmark, type ChatFn } from '@shared/benchmark'
import type { AppSettings } from '@shared/ipc'
import { abortChat, listModels, runChat } from './llm'
import * as store from './storage'

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    title: 'Smith Chart Tutor',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1419' : '#f4f6f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  if (process.env.SMITH_CAPTURE) devCapture(win, process.env.SMITH_CAPTURE)
}

/**
 * Dev aid: SMITH_CAPTURE=out.png [SMITH_SCRIPT="js"] runs optional JS in the page,
 * saves a screenshot, prints renderer console output and quits.
 */
function devCapture(w: BrowserWindow, file: string) {
  w.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`))
  w.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500))
    if (process.env.SMITH_SCRIPT) {
      try {
        console.log('[script]', await w.webContents.executeJavaScript(process.env.SMITH_SCRIPT))
      } catch (err) {
        console.log('[script error]', err)
      }
      await new Promise((r) => setTimeout(r, Number(process.env.SMITH_WAIT ?? 1200)))
    }
    const img = await w.webContents.capturePage()
    await fs.writeFile(file, img.toPNG())
    app.quit()
  })
}

function registerIpc() {
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:save', (_e, s: AppSettings) => store.saveSettings(s))
  ipcMain.handle('keys:set', (_e, id: string, key: string | null) => store.setKey(id, key))

  ipcMain.handle('llm:chat', async (e, requestId: string, req: ChatRequest) => {
    const cfg = await store.getProvider(req.providerId)
    // Stream events go out as they happen; the terminal event (done/error) is also
    // returned from the invoke, because IPC sends and invoke replies aren't ordered.
    let final: StreamEvent | undefined
    const send = (ev: StreamEvent) => {
      if (ev.type === 'done' || ev.type === 'error') final = ev
      if (!e.sender.isDestroyed()) e.sender.send('llm:event', requestId, ev)
    }
    if (!cfg) {
      send({ type: 'error', message: 'No model selected. Add one under Models.' })
      return final
    }
    await runChat(cfg, await store.getKey(cfg.connectionId ?? cfg.id), req, requestId, send)
    return final
  })
  ipcMain.handle('llm:abort', (_e, requestId: string) => abortChat(requestId))
  ipcMain.handle('llm:models', async (_e, connectionId: string) => {
    const c = await store.getConnection(connectionId)
    if (!c) throw new Error('Unknown connection')
    return listModels({ id: c.id, label: c.label, kind: c.kind, baseUrl: c.baseUrl, model: '' }, await store.getKey(c.id))
  })

  ipcMain.handle('profiles:list', () => store.listProfiles())
  ipcMain.handle('profiles:save', (_e, p: { id: string }) => store.saveProfile(p))
  ipcMain.handle('profiles:delete', (_e, id: string) => store.deleteProfile(id))
  ipcMain.handle('profiles:export', async (_e, json: string, suggestedName: string) => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export profile',
      defaultPath: suggestedName,
      filters: [{ name: 'Smith Tutor profile', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return false
    await fs.writeFile(r.filePath, json, 'utf8')
    return true
  })
  ipcMain.handle('profiles:import', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import profile',
      properties: ['openFile'],
      filters: [{ name: 'Smith Tutor profile', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    return fs.readFile(r.filePaths[0], 'utf8')
  })

  ipcMain.handle('workspace:get', (_e, id: string) => store.getWorkspace(id))
  ipcMain.handle('workspace:save', (_e, id: string, ws: unknown) => store.saveWorkspace(id, ws))
  ipcMain.handle('conversation:get', (_e, id: string) => store.getConversation(id))
  ipcMain.handle('conversation:save', (_e, id: string, c: unknown) => store.saveConversation(id, c))

  ipcMain.handle('files:openData', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import S-parameter / impedance data',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Touchstone & CST exports', extensions: ['s1p', 's2p', 's3p', 's4p', 'txt', 'dat', 'csv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (r.canceled) return []
    return Promise.all(r.filePaths.map(async (p) => ({ name: basename(p), text: await fs.readFile(p, 'utf8') })))
  })
  ipcMain.handle('files:openDataFolder', () => shell.openPath(store.dataFolder()))
}

// Dev aids (scripted runs, benchmarks, a throwaway data folder) are for development only.
if (app.isPackaged) for (const k of Object.keys(process.env)) if (k.startsWith('SMITH_')) delete process.env[k]

// Dev aid: run against a throwaway data folder.
if (process.env.SMITH_USERDATA) app.setPath('userData', process.env.SMITH_USERDATA)

/**
 * Headless benchmark: SMITH_BENCH=all (or comma-separated provider ids/labels)
 * runs the suite for configured models, saves results like the UI does, prints
 * them as JSON lines and quits. Keys are read and decrypted here, never printed.
 */
async function cliBench(which: string) {
  const s = await store.getSettings()
  const wanted = which.split(',').map((x) => x.trim())
  const targets = which === 'all' ? s.providers : s.providers.filter((p) => wanted.includes(p.id) || wanted.includes(p.label))
  for (const p of targets) {
    const key = await store.getKey(p.connectionId ?? p.id)
    const chat: ChatFn = (req) =>
      new Promise<ChatResult>((resolve, reject) => {
        runChat(p, key, { ...req, providerId: p.id }, `cli_${Date.now()}`, (ev) => {
          if (ev.type === 'done') resolve(ev.result)
          else if (ev.type === 'error') reject(new Error(ev.message))
        })
      })
    console.log(`[bench] ${p.label} (${p.model})`)
    const local = /localhost|127\.0\.0\.1/.test(p.baseUrl ?? '')
    const r = await runBenchmark(chat, { providerId: p.id, providerLabel: p.label, model: p.model, kind: p.kind, machine: local ? process.env.SMITH_MACHINE ?? 'local' : undefined }, (msg) => {
      if (process.env.SMITH_VERBOSE) console.log('   ', msg)
    })
    const cur = await store.getSettings()
    await store.saveSettings({ ...cur, benchmarks: { ...cur.benchmarks, [p.id]: r }, benchmarkHistory: [...(cur.benchmarkHistory ?? []), r].slice(-300) })
    console.log('[result] ' + JSON.stringify(r))
  }
}

app.whenReady().then(async () => {
  // SMITH_LIST_MODELS=1: print the models each connection's key can use, then quit.
  if (process.env.SMITH_LIST_MODELS) {
    try {
      for (const c of (await store.getSettings()).connections) {
        try {
          const ids = await listModels({ id: c.id, label: c.label, kind: c.kind, baseUrl: c.baseUrl, model: '' }, await store.getKey(c.id))
          console.log(`[models] ${c.preset}: ${ids.join(', ')}`)
        } catch (e) {
          console.log(`[models] ${c.preset}: ERROR ${(e as Error).message}`)
        }
      }
    } finally {
      app.quit()
    }
    return
  }
  // SMITH_PROBE=<model label> SMITH_PROMPT=... : one request, print the full result (debugging adapters).
  if (process.env.SMITH_PROBE) {
    try {
      const p = (await store.getSettings()).providers.find((x) => x.label === process.env.SMITH_PROBE)
      if (!p) throw new Error('No model with that label')
      await runChat(p, await store.getKey(p.connectionId ?? p.id), {
        providerId: p.id,
        system: { stable: process.env.SMITH_SYSTEM ?? 'You are a helpful assistant.' },
        messages: [{ role: 'user', parts: [{ type: 'text', text: process.env.SMITH_PROMPT ?? 'Say hi.' }] }],
        maxTokens: Number(process.env.SMITH_MAXTOK ?? 2000)
      }, 'probe', (ev) => { if (ev.type !== 'text') console.log('[event]', JSON.stringify(ev).slice(0, 1500)) })
    } catch (e) {
      console.log('[probe error]', (e as Error).message)
    } finally {
      app.quit()
    }
    return
  }
  if (process.env.SMITH_BENCH) {
    try {
      await cliBench(process.env.SMITH_BENCH)
    } finally {
      app.quit()
    }
    return
  }
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
