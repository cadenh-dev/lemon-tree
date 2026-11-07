import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, powerMonitor } from 'electron'
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron'
import { execFile } from 'node:child_process'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync, rmSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { ProjectStore } from './projects'
import { Vault } from './vault'
import { createSecretStore } from './key-store'
import { demoOutcome, runProject, startFixedDemo } from './launch'
import { runAgent, writeCliOutput } from './agent'
import { AgentAccess } from './agent-access'
import { identifyCaller } from './caller'
import { streamEnvironment } from './runtime'
import { Sharing } from './sharing'
import { encodePairingLink } from './transfer'
import { linkLimit } from '../shared/transport'
import type { PendingLink } from '../shared/transport'
import { Cards } from './cards'
import type { Relay } from './relay-connection'
import { readThemePreference, writeThemePreference } from './preferences'
import { getProtocolStatus, registerProtocol, removeProtocol } from './protocol-registration'
import { protocolLinksFromArguments, readProtocolLink } from './protocol'
import { HyperswarmTransport } from './transport-hyperswarm'
import { WebRtcTransport } from './transport-webrtc'
import { WebRtcConfig } from './webrtc-config'
import { ShareGate } from './share-gate'
import type { Reply, ThemePreference, ThemeVariant } from '../shared/api'
import type { DirectState } from '../shared/direct'
import type { WebRtcState } from '../shared/webrtc'
import type { InvokeChannels } from '../shared/ipc-channels'

let mainWindow: BrowserWindow | null = null
app.setName('global.sct')
if (process.platform === 'win32') app.setAppUserModelId('app.global-sct.desktop')
const launchArguments = process.argv.slice(process.defaultApp ? 2 : 1)
const cliLaunch = ['run', '_env', 'agent', 'mcp', 'skills', '--version'].includes(launchArguments[0])
const desktopMode = !cliLaunch
const initialProtocolLinks = desktopMode ? protocolLinksFromArguments(launchArguments) : []
const primaryInstance = !desktopMode || app.requestSingleInstanceLock()
const incomingFiles: string[] = []
let sharing: Sharing | undefined
let direct: HyperswarmTransport | undefined
let webrtc: WebRtcTransport | undefined
let shareGate: ShareGate | undefined
let openingFiles = false
let pendingUnlock: (() => void) | undefined
let desktopStarted: Promise<void> | undefined
let themePreference: Promise<ThemePreference> | undefined
let desktopReady = false
let pendingLink: PendingLink | null = null

if (!primaryInstance) app.exit(0)

// macOS can deliver a document before the app and its renderer are ready.
app.on('open-file', (event, path) => {
  event.preventDefault()
  incomingFiles.push(path)
  if (sharing && !mainWindow) void createWindow().catch(reportStartupError)
  else void openIncomingFiles()
})

// macOS delivers links through open-url. Windows and Linux deliver them through the second-instance arguments.
app.on('open-url', (event, url) => {
  event.preventDefault()
  acceptProtocolLink(url)
})

if (desktopMode && primaryInstance) {
  app.on('second-instance', (_event, argv) => {
    const links = protocolLinksFromArguments(argv)
    if (links.length === 0) {
      showMainWindow()
      return
    }
    for (const link of links) acceptProtocolLink(link)
  })
}

function acceptProtocolLink(value: string): void {
  let link: PendingLink
  try {
    link = readProtocolLink(value)
  } catch (error) {
    reportLinkError(error)
    return
  }
  if (pendingLink) {
    if (pendingLink.link === link.link) {
      showMainWindow()
      return
    }
    const choose = () => offerPendingLink(link)
    if (app.isReady()) void choose()
    else void app.whenReady().then(choose)
    return
  }
  pendingLink = link
  pendingLinkChanged()
  showMainWindow()
}

async function offerPendingLink(next: PendingLink): Promise<void> {
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Keep current', 'Use new link'],
    defaultId: 0,
    cancelId: 0,
    title: 'Another link is waiting',
    message: 'A link is already waiting.',
    detail: 'Finish or dismiss the current link before you open another one.'
  })
  if (result.response !== 1) return
  pendingLink = next
  pendingLinkChanged()
  showMainWindow()
}

function pendingLinkChanged(): void {
  mainWindow?.webContents.send('protocol:pending-link')
}

function showMainWindow(): void {
  if (!desktopReady) return
  if (!mainWindow) {
    if (app.isReady()) void createWindow().catch(reportStartupError)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function reportLinkError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'The link could not be opened.'
  if (app.isReady()) dialog.showErrorBox('Cannot open this link', message)
  else void app.whenReady().then(() => dialog.showErrorBox('Cannot open this link', message))
}

function handle<K extends keyof InvokeChannels>(channel: K, operation: (...args: InvokeChannels[K]['args']) => InvokeChannels[K]['result'] | Promise<InvokeChannels[K]['result']>): void
function handle(channel: string, operation: (...args: unknown[]) => unknown): void
function handle(channel: string, operation: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<Reply<unknown>> => {
    if (!isAppRequest(event)) return { ok: false, error: 'global.sct rejected this request.' }
    try {
      return { ok: true, value: await operation(...args) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'The operation failed.' }
    }
  })
}

// Requests come only from the app page in the top frame of the main window. The page check stays if a navigation is not blocked.
function isAppRequest(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (event.sender !== mainWindow?.webContents || !frame || frame !== event.sender.mainFrame || !URL.canParse(frame.url)) return false
  const page = new URL(frame.url)
  return !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? page.origin === URL.parse(process.env.ELECTRON_RENDERER_URL)?.origin
    : page.protocol === 'file:' && page.pathname === pathToFileURL(rendererPage()).pathname
}

function rendererPage(): string {
  return join(__dirname, '../renderer/index.html')
}

// The window shows this color before the renderer paints. Each value is the --color-paper token of its variant in styles.css.
const windowBackground: Record<ThemeVariant, string> = { terminal: '#040805', cream: '#f3ead9' }

// themeSource also sets the native dialogs, the scrollbars, and prefers-color-scheme.
function loadTheme(): Promise<ThemePreference> {
  themePreference ??= readThemePreference(preferencesFile()).then((preference) => {
    nativeTheme.themeSource = preference
    return preference
  })
  return themePreference
}

// For `system`, Electron resolves the OS setting into shouldUseDarkColors.
function themeVariant(): ThemeVariant {
  return nativeTheme.shouldUseDarkColors ? 'terminal' : 'cream'
}

function preferencesFile(): string {
  return join(app.getPath('userData'), 'preferences.json')
}

function registerThemeHandlers(): void {
  handle('preferences:get-theme', () => loadTheme())
  handle('preferences:set-theme', async (input) => {
    const preference = await writeThemePreference(preferencesFile(), input)
    themePreference = Promise.resolve(preference)
    nativeTheme.themeSource = preference
    themeChanged()
    return themeVariant()
  })
  // The OS setting can change while the app is open. Only `system` follows it, because themeSource fixes the other values.
  nativeTheme.on('updated', themeChanged)
}

function themeChanged(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const variant = themeVariant()
  mainWindow.setBackgroundColor(windowBackground[variant])
  mainWindow.webContents.send('theme:changed', variant)
}

async function createWindow(hash = incomingFiles.length ? '/sharing' : undefined): Promise<BrowserWindow> {
  await loadTheme()
  const variant = themeVariant()
  const window = new BrowserWindow({
    title: 'global.sct',
    width: 1000,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    backgroundColor: windowBackground[variant],
    show: false,
    webPreferences: {
      additionalArguments: [`--sct-theme=${variant}`],
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  mainWindow = window
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
  window.webContents.on('did-finish-load', () => { void openIncomingFiles() })
  window.on('closed', () => { mainWindow = null })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)

  let closing = false
  window.once('close', () => { closing = true })
  try {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash ? `#${hash}` : ''}`)
    } else {
      await window.loadFile(rendererPage(), { hash })
    }
  } catch (error) {
    // Closing a window during its first load cancels loading without a startup failure.
    if (!closing) throw error
  }
  return window
}

async function pickDirectory(options: OpenDialogOptions): Promise<string | null> {
  if (!mainWindow) throw new Error('The global.sct window is unavailable.')
  const result = await dialog.showOpenDialog(mainWindow, options)
  return result.canceled ? null : result.filePaths[0] ?? null
}

function reportStartupError(error: unknown): void {
  console.error('global.sct could not start.', error)
  dialog.showErrorBox('global.sct could not start', error instanceof Error ? error.message : 'The application window could not load. Check the development terminal for details.')
  app.quit()
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  if (launchArguments[0] === '--version') {
    if (launchArguments.length !== 1) throw new Error('Usage: sct --version. Return the global.sct version.')
    await writeCliOutput(app.getVersion())
    app.exit(0)
    return
  }
  if (launchArguments[0] === 'skills') {
    if (launchArguments.length !== 1) throw new Error('Usage: sct skills. Return the bundled skill directory and names.')
    await writeCliOutput(JSON.stringify({ directory: skillsDirectory(), skills: (await readdir(skillsDirectory())).filter((name) => name.startsWith('sct-')) }))
    app.exit(0)
    return
  }
  requireForkStorage()
  registerThemeHandlers()
  const projects = new ProjectStore(join(app.getPath('userData'), 'projects.json'))
  const store = await createSecretStore('global.sct')
  const vault = new Vault(projects, join(app.getPath('userData'), 'settings.json'), homedir(), store)
  await vault.start()
  registerVaultHandlers(vault, projects)
  if (launchArguments[0] === 'agent' || launchArguments[0] === 'mcp') {
    app.dock?.hide()
    await unlockVault(vault)
    shareGate = new ShareGate((passphrase) => vault.verifySharePassphrase(passphrase),
      () => mainWindow?.webContents.send('share:changed'))
    registerShareGate(shareGate)
    app.exit(await runAgentSession(projects, vault))
    return
  }
  if (launchArguments[0] === 'run' || launchArguments[0] === '_env') {
    app.dock?.hide()
    await unlockVault(vault)
    if (launchArguments[0] === '_env') {
      await streamEnvironment(projects, vault, launchArguments[1])
      app.exit(0)
    } else {
      app.exit(await runProject(projects, vault, launchArguments))
    }
    return
  }
  if (await vault.unlockWithRememberedKey()) {
    await startDesktop(vault, projects)
  } else {
    await createWindow('/unlock')
  }
  desktopReady = true
  for (const link of initialProtocolLinks) acceptProtocolLink(link)
}).catch((error: unknown) => {
  if (['run', '_env', 'agent', 'mcp', 'skills', '--version'].includes(launchArguments[0])) {
    console.error(error instanceof Error ? error.message : 'The project command could not start.')
    app.exit(1)
  } else {
    reportStartupError(error)
  }
})

function requireForkStorage(): void {
  if (['settings.json', 'projects.json'].some((name) => existsSync(join(app.getPath('userData'), name))) ||
    existsSync(join(homedir(), 'global.sct', 'vault.json'))) return
  if (existsSync(join(app.getPath('appData'), '.sct', 'projects.json')) || existsSync(join(homedir(), '.sct', 'vault.json'))) {
    throw new Error('Existing .sct storage needs an explicit move. Close both apps and run bun run migrate:fork from the global.sct repository. See docs/fork-storage-migration.md.')
  }
}

function registerVaultHandlers(vault: Vault, projects: ProjectStore): void {
  handle('protocol:status', () => getProtocolStatus())
  handle('protocol:register', (replace) => registerProtocol(replace === true))
  handle('protocol:remove', () => removeProtocol())
  handle('protocol:pending-link', () => pendingLink)
  handle('protocol:dismiss-link', (id) => {
    if (typeof id !== 'string' || pendingLink?.id !== id) return
    pendingLink = null
    pendingLinkChanged()
  })
  handle('vault:status', () => vault.status())
  handle('vault:unlock', async (input) => {
    const status = await vault.unlock(input)
    if (pendingUnlock) {
      const resume = pendingUnlock
      pendingUnlock = undefined
      resume()
    } else {
      await startDesktop(vault, projects)
      await direct?.start()
      await webrtc?.start()
    }
    return status
  })
  handle('vault:lock', async () => {
    shareGate?.clear()
    await direct?.stop()
    webrtc?.stop()
    return vault.lock()
  })
  handle('vault:forget', () => {
    shareGate?.clear()
    return vault.forget()
  })
  handle('vault:location', () => vault.location())
}

// A CLI launch has no terminal for the passphrase. The same signed executable opens one window for it.
async function unlockVault(vault: Vault): Promise<void> {
  if (!(await vault.unlockWithRememberedKey())) {
    await new Promise<void>((resolve, reject) => {
      pendingUnlock = resolve
      createWindow('/unlock').then((window) => {
        window.once('closed', () => {
          if (!pendingUnlock) return
          pendingUnlock = undefined
          reject(new Error('The unlock window closed before the vault opened.'))
        })
      }).catch(reject)
    })
    mainWindow?.close()
  }
  try {
    await vault.cleanupExpiredGrants()
  } catch (error) {
    console.error('Startup grant cleanup failed.', error)
  }
}

function startDesktop(vault: Vault, projects: ProjectStore): Promise<void> {
  desktopStarted ??= startDesktopOnce(vault, projects)
  return desktopStarted
}

async function startDesktopOnce(vault: Vault, projects: ProjectStore): Promise<void> {
  try {
    await vault.cleanupExpiredGrants()
  } catch (error) {
    console.error('Startup grant cleanup failed.', error)
  }
  const service = new Sharing(join(app.getPath('userData'), 'sharing'), vault, hostname().slice(0, 100))
  sharing = service
  shareGate = new ShareGate((passphrase) => vault.verifySharePassphrase(passphrase),
    () => mainWindow?.webContents.send('share:changed'))
  registerShareGate(shareGate)
  await service.cleanOutbox()
  direct = new HyperswarmTransport(service, join(app.getPath('userData'), 'direct'),
    () => mainWindow?.webContents.send('direct:changed'))
  try {
    await direct.start()
  } catch (error) {
    console.error('The Direct transport could not start.', error)
  }
  const ice = new WebRtcConfig(vault)
  webrtc = new WebRtcTransport(service, ice, join(app.getPath('userData'), 'webrtc'),
    () => mainWindow?.webContents.send('webrtc:changed'))
  try {
    await webrtc.start()
  } catch (error) {
    console.error('The WebRTC transport could not start.', error)
  }
  const { Relay, relayServer } = await import('./relay-connection')
  // Only this process writes relay files and runs remote tasks. Agent sessions open a passive relay.
  const relay = new Relay(relayServer(), join(app.getPath('userData'), 'relay'), async () => service,
    () => mainWindow?.webContents.send('relay:changed'), vault, {
      runTask: async (projectId, grantId) => demoOutcome(await vault.withGrantSecrets(projectId, grantId,
        (project, values) => startFixedDemo(project, values, process.execPath, demoFile()))),
      cleanupGrants: () => vault.cleanupExpiredGrants()
    })
  await relay.start()
  await relay.queueGrantExpiryNotifications(await vault.grantCleanupOutcomes())
  const cleanExpiredGrants = async () => {
    await relay.queueGrantExpiryNotifications(await vault.cleanupExpiredGrants())
  }
  const cleanupTimer = setInterval(() => {
    void cleanExpiredGrants().catch((error: unknown) => console.error('Scheduled grant cleanup failed.', error))
  }, 60_000)
  powerMonitor.on('resume', () => {
    void cleanExpiredGrants().catch((error: unknown) => console.error('Resume grant cleanup failed.', error))
  })
  app.on('will-quit', () => {
    clearInterval(cleanupTimer)
    relay.stop()
    void direct?.stop()
    webrtc?.stop()
  })
  handle('relay:state', () => relay.state())
  handle('relay:request-pair', (identity) => relay.requestPair(identity))
  handle('relay:confirm-pair', (input) => relay.confirmPair(input))
  handle('relay:remove-pair', (pairId) => relay.removePair(pairId))
  handle('relay:queue-transfer', async (input) =>
    requireShareGate().run(await relay.describeTransfer(input), () => relay.queueTransfer(input)))
  handle('relay:accept-transfer', (input) => relay.acceptRelayTransfer(input))
  handle('relay:queue-task', (grantId) => relay.queueTask(grantId))
  handle('relay:respond-task', (input) => relay.respondTask(input))
  handle('relay:hide-activity', (input) => relay.hideActivity(input))
  handle('relay:hide-all-activity', () => relay.hideAllActivity())
  handle('direct:state', () => direct?.state() ?? emptyDirect())
  handle('direct:send', async (input) =>
    requireShareGate().run(await service.describeSend(input, 'direct'), () => requireDirect().send(input)))
  handle('direct:import', (input) => requireDirect().import(input))
  handle('direct:verify-receipt', (input) => requireDirect().verifyReceipt(input))
  handle('webrtc:state', () => webrtc?.state() ?? emptyWebRtc())
  handle('webrtc:ice', () => ice.get())
  handle('webrtc:save-ice', (input) => ice.save(input))
  handle('webrtc:preview-link', (link) => requireWebRtc().previewLink(link))
  handle('webrtc:create-offer', (peerId) => requireWebRtc().createOffer(peerId))
  handle('webrtc:accept-offer', (link) => requireWebRtc().acceptOffer(link))
  handle('webrtc:accept-answer', (link) => requireWebRtc().acceptAnswer(link))
  handle('webrtc:close', () => requireWebRtc().close())
  handle('webrtc:send', async (input) =>
    requireShareGate().run(await service.describeSend(input, 'webrtc'), () => requireWebRtc().send(input)))
  handle('webrtc:import', (input) => requireWebRtc().import(input))
  handle('webrtc:verify-receipt', (input) => requireWebRtc().verifyReceipt(input))
  handle('projects:list', () => projects.list())
  handle('projects:add', (input) => vault.addProject(input))
  handle('projects:rename', (input) => vault.renameProject(input))
  handle('projects:delete', (id) => vault.deleteProject(id))
  handle('projects:pick-directory', () => pickDirectory({
    title: 'Add a project',
    buttonLabel: 'Select folder',
    properties: ['openDirectory']
  }))
  handle('secrets:list', () => vault.listSecrets())
  handle('secrets:add', (input) => vault.addSecret(input))
  handle('secrets:update', (input) => vault.updateSecret(input))
  handle('secrets:delete', (input) => vault.deleteSecret(input))
  handle('vault:choose-location', async () => {
    const root = await pickDirectory({
      title: 'Choose a storage location',
      buttonLabel: 'Move vault here',
      properties: ['openDirectory', 'createDirectory']
    })
    return root ? vault.moveTo(root) : null
  })
  registerSharing(service)
  registerCards(new Cards(join(app.getPath('userData'), 'cards')))
  if (!mainWindow) await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(reportStartupError)
  })
}

async function runAgentSession(projects: ProjectStore, vault: Vault): Promise<number> {
  let access: AgentAccess | undefined
  let loading: Promise<AgentAccess> | undefined
  let sessionSharing: Sharing | undefined
  let sharingReady: Promise<void> | undefined
  let relay: Promise<Relay> | undefined
  const caller = identifyCaller()
  // The agent session relay is passive. It reads relay rows and files, and writes only new task requests.
  const getRelay = () => relay ??= (async () => {
    const { Relay, relayServer } = await import('./relay-connection')
    const service = new Relay(relayServer(), join(app.getPath('userData'), 'relay'), getSharing, () => undefined, vault)
    await service.start()
    return service
  })()
  const getSharing = async () => {
    await getAccess()
    if (!sessionSharing) throw new Error('The local sharing service is unavailable.')
    await (sharingReady ??= sessionSharing.cleanOutbox())
    return sessionSharing
  }
  const getAccess = async (): Promise<AgentAccess> => {
    loading ??= (async () => {
      sessionSharing = new Sharing(join(app.getPath('userData'), 'sharing'), vault, hostname().slice(0, 100))
      access = new AgentAccess(projects, vault, {
        review: async () => {
          if (!mainWindow) await createWindow('/agent')
          mainWindow?.show()
          mainWindow?.focus()
        },
        changed: () => mainWindow?.webContents.send('agent:changed'),
        sharing: getSharing,
        shareFile: sendToNearbyMac,
        approveShare: (summary, execute) => requireShareGate().run(summary, execute),
        caller,
        relayState: async () => (await getRelay()).state(),
        requestRemoteDemo: async (grantId) => (await getRelay()).requestTask(grantId),
        executable: process.execPath,
        demo: demoFile()
      })
      return access
    })().catch((error: unknown) => { loading = undefined; throw error })
    return loading
  }
  handle('agent:requests', () => access?.views() ?? [])
  handle('agent:respond', async (input) => {
    if (!access) throw new Error('No agent request is awaiting approval.')
    await access.respond(input)
  })
  app.on('window-all-closed', () => access?.cancelAll())
  try {
    const submit = async (input: unknown, signal?: AbortSignal) => (await getAccess()).submit(input, signal)
    if (launchArguments[0] === 'agent') return await runAgent(launchArguments, submit)
    await (await import('./mcp')).runMcp(launchArguments, submit, skillsDirectory())
    return 0
  } finally {
    access?.disconnect()
    if (relay) (await relay.catch(() => undefined))?.stop()
    mainWindow?.destroy()
  }
}

function demoFile(): string {
  return app.isPackaged ? join(process.resourcesPath, 'demo', 'index.cjs') : join(__dirname, '../demo/index.cjs')
}

function skillsDirectory(): string {
  return app.isPackaged ? join(process.resourcesPath, 'skills') : join(__dirname, '../../skills')
}

app.on('window-all-closed', () => {
  // A CLI session closes its unlock window and must keep running. Only the desktop window ends the app.
  if (process.platform !== 'darwin' && desktopMode) app.quit()
})

function registerSharing(service: Sharing): void {
  handle('sharing:create-link', async (input) =>
    requireShareGate().run(await service.describeSend(input, 'link'), () => service.createLink(input)))
  handle('sharing:preview-link', (link) => service.previewLink(link))
  handle('sharing:import-link', (input) => service.importLink(input))
  handle('sharing:verify-link-receipt', (input) => service.verifyLinkReceipt(input))
  handle('sharing:link-state', () => service.getLinkState())
  handle('sharing:copy-text', (text) => {
    if (typeof text !== 'string' || text.length > linkLimit) throw new Error('Copy text must contain at most 16,384 characters.')
    clipboard.writeText(text)
  })
  handle('sharing:state', () => service.state())
  handle('sharing:device-card', async () => sendToNearbyMac(await service.deviceCardFile()))
  handle('sharing:copy-pairing-link', async () => clipboard.writeText(encodePairingLink(await service.deviceCard())))
  handle('sharing:save-device-card', async () => {
    if (!mainWindow) throw new Error('The global.sct window is unavailable.')
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save your device card',
      defaultPath: join(app.getPath('downloads'), 'device.sct-device'),
      filters: [{ name: 'global.sct device card', extensions: ['sct-device'] }]
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, JSON.stringify(await service.deviceCard()), { mode: 0o600 })
    return true
  })
  handle('sharing:preview-pairing-link', (link) => service.previewPeer({ link }))
  handle('sharing:pick-peer', async () => {
    const path = await pickDirectory({ title: 'Verify a recipient device', properties: ['openFile'], defaultPath: app.getPath('downloads'),
      filters: [{ name: 'global.sct device card', extensions: ['sct-device'] }] })
    return path ? service.previewPeer(path) : null
  })
  handle('sharing:confirm-peer', async (token) => {
    const peer = await service.confirmPeer(token)
    sharingChanged()
    await direct?.refresh()
    return peer
  })
  handle('sharing:send', async (input) => {
    if (process.platform !== 'darwin') throw new Error('Sending to a nearby Mac requires macOS.')
    return requireShareGate().run(await service.describeExport(input), async () =>
      sendToNearbyMac(await service.exportSecrets(input)))
  })
  handle('sharing:pick-transfer', async () => {
    const path = await pickDirectory({ title: 'Choose a received global.sct transfer', properties: ['openFile'], defaultPath: app.getPath('downloads'),
      filters: [{ name: 'global.sct transfer', extensions: ['sct-transfer'] }] })
    if (!path) return null
    const preview = await service.openTransfer(path)
    sharingChanged()
    return preview
  })
  handle('sharing:import', async (input) => {
    const metadata = await service.importTransfer(input)
    sharingChanged()
    return metadata
  })
  handle('sharing:dismiss', async (id) => {
    await service.dismissTransfer(id)
    sharingChanged()
  })
  app.on('will-quit', () => {
    rmSync(join(app.getPath('userData'), 'sharing', 'outbox'), { recursive: true, force: true })
  })
}

function registerCards(cards: Cards): void {
  // The AirDrop picker reports no delivery. Signed passes stay in the outbox until the app quits or starts again.
  const outbox = join(app.getPath('userData'), 'cards', 'outbox')
  rmSync(outbox, { recursive: true, force: true })
  app.on('will-quit', () => rmSync(outbox, { recursive: true, force: true }))
  handle('cards:create', (input) => cards.create(input))
  handle('cards:share', async (id) => sendToNearbyMac(await cards.passFile(id)))
}

function sendToNearbyMac(path: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Sending to a nearby Mac requires macOS.'))
  return new Promise((resolve, reject) => {
    // The helper opens only the AirDrop picker and exits when it closes. macOS reports no delivery or cancel state.
    execFile(app.isPackaged ? join(process.resourcesPath, 'airdrop') : join(__dirname, '../airdrop'), [path], (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || 'Cannot open the nearby Mac picker.'))
      else resolve()
    })
  })
}

function sharingChanged(): void {
  mainWindow?.webContents.send('sharing:changed')
}

function requireShareGate(): ShareGate {
  if (!shareGate) throw new Error('The share confirmation is not ready.')
  return shareGate
}

function registerShareGate(gate: ShareGate): void {
  handle('share:current', () => gate.current())
  handle('share:confirm', (input) => gate.confirm(input))
  handle('share:cancel', () => gate.cancel())
}

function requireDirect(): HyperswarmTransport {
  if (!direct) throw new Error('Direct sharing is not ready.')
  return direct
}

function emptyDirect(): DirectState {
  return { connection: 'off', peers: [], incoming: [], sent: [], receipts: [], error: null }
}

function requireWebRtc(): WebRtcTransport {
  if (!webrtc) throw new Error('WebRTC sharing is not ready.')
  return webrtc
}

function emptyWebRtc(): WebRtcState {
  return { connection: 'off', peers: [], peerId: null, offerLink: null, answerLink: null, route: null,
    incoming: [], sent: [], receipts: [], error: null }
}

async function openIncomingFiles(): Promise<void> {
  if (openingFiles || !sharing || !mainWindow || mainWindow.webContents.isLoading()) return
  const path = incomingFiles.shift()
  if (!path) return
  openingFiles = true
  try {
    await sharing.openTransfer(path)
    mainWindow?.show()
    sharingChanged()
  } catch (error) {
    dialog.showErrorBox('Cannot open this global.sct transfer', error instanceof Error ? error.message : 'The transfer could not be opened.')
  } finally {
    openingFiles = false
    if (incomingFiles.length) void openIncomingFiles()
  }
}
