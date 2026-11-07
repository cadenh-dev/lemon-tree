import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { ProtocolStatus } from '../shared/api'

const scheme = 'global-sct'
const desktopFile = 'app.global-sct.desktop'
const managedMarker = 'X-Sct-Managed=true'
const run = promisify(execFile)

export async function getProtocolStatus(): Promise<ProtocolStatus> {
  if (!app.isPackaged) return unsupported('Use the packaged app to register global-sct links.')
  if (process.platform === 'linux') return linuxStatus()
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return unsupported('Link registration is not supported on this platform.')
  }
  const registered = app.isDefaultProtocolClient(scheme, process.execPath, [])
  const owner = await currentOwner()
  return {
    supported: true,
    registered,
    owner,
    conflict: !registered && owner !== null && owner !== process.execPath,
    detail: detail(registered, owner)
  }
}

export async function registerProtocol(replace: boolean): Promise<ProtocolStatus> {
  requirePackaged()
  const current = await getProtocolStatus()
  if (!current.supported) throw new Error(current.detail)
  if (current.registered) return current
  if (current.conflict && !replace) {
    throw new Error('Another app owns global-sct links. Select Replace handler to take them.')
  }
  if (process.platform === 'linux') return registerLinux()
  if (!app.setAsDefaultProtocolClient(scheme, process.execPath, [])) {
    throw new Error('The operating system did not accept the global-sct link registration.')
  }
  const next = await getProtocolStatus()
  if (!next.registered) throw new Error('The operating system did not make global.sct the global-sct handler.')
  return next
}

export async function removeProtocol(): Promise<ProtocolStatus> {
  requirePackaged()
  if (process.platform === 'linux') return removeLinux()
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('Link registration is not supported on this platform.')
  }
  if (!app.isDefaultProtocolClient(scheme, process.execPath, [])) return getProtocolStatus()
  if (!app.removeAsDefaultProtocolClient(scheme, process.execPath, [])) {
    throw new Error('The operating system did not remove the global-sct link registration.')
  }
  const next = await getProtocolStatus()
  if (next.registered) throw new Error('The operating system still uses global.sct for global-sct links.')
  return next
}

function requirePackaged(): void {
  if (!app.isPackaged) throw new Error('Use the packaged app to change global-sct links.')
}

async function currentOwner(): Promise<string | null> {
  try {
    const info = await app.getApplicationInfoForProtocol(`${scheme}://`)
    return info.path || info.name || null
  } catch {
    return null
  }
}

function detail(registered: boolean, owner: string | null): string {
  if (registered) return 'global-sct links open global.sct.'
  if (owner) return `Another app owns global-sct links: ${owner}.`
  return 'No app is registered for global-sct links.'
}

function unsupported(message: string): ProtocolStatus {
  return { supported: false, registered: false, owner: null, conflict: false, detail: message }
}

function desktopPath(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(data, 'applications', desktopFile)
}

function desktopContents(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=global.sct',
    `Exec="${escapedExecutable()}" %u`,
    'Terminal=false',
    'Categories=Development;',
    'MimeType=x-scheme-handler/global-sct;',
    managedMarker,
    ''
  ].join('\n')
}

function escapedExecutable(): string {
  if (process.execPath.includes('=')) throw new Error('The executable path contains "=". Move the app to another folder.')
  return process.execPath.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

async function linuxStatus(): Promise<ProtocolStatus> {
  let installed = false
  try {
    const contents = await readFile(desktopPath(), 'utf8')
    installed = contents.includes(managedMarker) && contents.includes(`"${escapedExecutable()}"`)
  } catch {
    // A missing desktop entry means that this app is not installed as a handler.
  }
  let owner: string | null
  try {
    owner = (await run('xdg-mime', ['query', 'default', 'x-scheme-handler/global-sct'])).stdout.trim() || null
  } catch {
    return { supported: false, registered: false, owner: null, conflict: false, detail: 'xdg-mime is unavailable, so link registration is not supported.' }
  }
  const registered = installed && owner === desktopFile
  const stale = !installed && owner === desktopFile
  return {
    supported: true,
    registered,
    owner,
    conflict: !registered && owner !== null && owner !== desktopFile,
    detail: stale
      ? 'The desktop still lists global.sct, but the desktop entry is missing. Register again or repair the association.'
      : detail(registered, owner)
  }
}

async function registerLinux(): Promise<ProtocolStatus> {
  const path = desktopPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, desktopContents(), { mode: 0o644 })
  await run('xdg-mime', ['default', desktopFile, 'x-scheme-handler/global-sct'])
  try {
    await run('update-desktop-database', [dirname(path)])
  } catch {
    // The desktop database helper is optional. The mimeapps association is enough.
  }
  const status = await linuxStatus()
  if (!status.registered) throw new Error('The desktop did not accept the global-sct link registration.')
  return status
}

async function removeLinux(): Promise<ProtocolStatus> {
  const path = desktopPath()
  try {
    const contents = await readFile(path, 'utf8')
    if (contents.includes(managedMarker) && contents.includes(`"${escapedExecutable()}"`)) await rm(path, { force: true })
  } catch {
    // A missing file means that this app owns no desktop entry.
  }
  const status = await linuxStatus()
  if (status.registered) throw new Error('The desktop still uses global.sct for global-sct links.')
  return status
}
