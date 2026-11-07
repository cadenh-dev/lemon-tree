import { execFile } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentCaller } from '../shared/agent'

const run = promisify(execFile)
// Resolve the system programs from an absolute path. A project-local file must not shadow them.
const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

interface AgentIdentity {
  name: string
  requirement: string
  publisher: string
  product: string
}

const vscodeIdentity: AgentIdentity = {
  name: 'Visual Studio Code',
  requirement: 'identifier "com.microsoft.VSCode" and anchor apple generic and certificate leaf[subject.OU] = "UBF8T346G9"',
  publisher: 'Microsoft Corporation',
  product: 'Visual Studio Code'
}

// Each entry maps an agent's executable name to its signing identifiers.
// Verify the Windows product text with the real Claude Code build before release.
const signedAgents = new Map<string, AgentIdentity>([['claude', {
  name: 'Claude Code',
  requirement: 'identifier "com.anthropic.claude-code" and anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW"',
  publisher: 'Anthropic',
  product: 'Claude Code'
}], ['code', vscodeIdentity]])

// The macOS app executable is capitalized. The Windows reader converts names to lowercase.
if (process.platform === 'darwin') signedAgents.set('Code', vscodeIdentity)
// Do not add Code Helper (Plugin) until its requested signing identifier is confirmed.
// The official 1.145.0 package uses com.microsoft.VSCode.helper, without the .plugin suffix.

interface CallerProcess {
  parent: number
  name: string
  path?: string
}

// Walk up the parent processes to the first listed agent name and check its running code signature.
// MCP clients start `sct mcp` directly. Shell tools start `sct agent` through a shell, so the agent can be an ancestor.
// Return null when a process uses a listed agent name but fails that agent's signature check.
export async function identifyCaller(): Promise<AgentCaller | null> {
  let pid = process.ppid
  while (pid > 1) {
    const ancestor = await readProcess(pid)
    if (!ancestor) break
    const agent = signedAgents.get(ancestor.name)
    if (agent) return verifyCaller(pid, ancestor, agent)
    pid = ancestor.parent
  }
  return { name: 'Unverified caller', verified: false }
}

function readProcess(pid: number): Promise<CallerProcess | null> {
  if (process.platform === 'win32') return readWindowsProcess(pid)
  if (process.platform === 'linux') return readLinuxProcess(pid)
  return readMacProcess(pid)
}

async function verifyCaller(pid: number, ancestor: CallerProcess, agent: AgentIdentity): Promise<AgentCaller | null> {
  if (process.platform === 'win32') {
    if (!ancestor.path) return { name: agent.name, verified: false }
    return await satisfiesWindows(ancestor.path, agent.publisher, agent.product)
      ? { name: agent.name, verified: true }
      : null
  }
  // Linux has no code signature. A name match is unverified, so the approval window asks for the extra confirmation (Q6).
  if (process.platform === 'linux') return { name: agent.name, verified: false }
  return await satisfiesMac(pid, agent.requirement) ? { name: agent.name, verified: true } : null
}

// macOS reports the parent and executable with ps. The live process is checked against its Apple requirement.
async function readMacProcess(pid: number): Promise<CallerProcess | null> {
  try {
    const match = /^\s*(\d+)\s+(.+)$/.exec((await run('/bin/ps', ['-ww', '-o', 'ppid=,comm=', '-p', String(pid)])).stdout.trim())
    if (!match) return null
    const executable = match[2]?.startsWith('/') ? match[2] : await readMacExecutable(pid)
    return { parent: Number(match[1]), name: executable ? basename(executable) : '', path: executable }
  } catch {
    // The process exited before the check. Its identity is unknown.
    return null
  }
}

// ps can report a short argv[0]. Read the first mapped executable path without parsing its spaces.
async function readMacExecutable(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { timeout: 5000 })
    return stdout.split('\n').find((line) => line.startsWith('n/'))?.slice(1)
  } catch {
    return undefined
  }
}

// Linux reports the parent in /proc/<pid>/stat and the executable target in /proc/<pid>/exe.
async function readLinuxProcess(pid: number): Promise<CallerProcess | null> {
  try {
    const parent = readLinuxParent(await readFile(`/proc/${pid}/stat`, 'utf8'))
    if (parent === null) return null
    const executable = (await readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '')
    return { parent, name: basename(executable) }
  } catch {
    // The process exited before the check. Its identity is unknown.
    return null
  }
}

// The command name can contain spaces and parentheses, so the state and parent PID are the fields after the last ")".
function readLinuxParent(stat: string): number | null {
  const end = stat.lastIndexOf(')')
  if (end < 0) return null
  const parent = Number(stat.slice(end + 1).trim().split(/\s+/)[1])
  return Number.isInteger(parent) && parent >= 0 ? parent : null
}

// Windows has no /proc. A fixed CIM query returns one process for a numeric PID, and no user input enters the command.
async function readWindowsProcess(pid: number): Promise<CallerProcess | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const query = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ParentProcessId, ExecutablePath, Name | ConvertTo-Json -Compress`
  try {
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', query],
      { windowsHide: true, timeout: 5000 })
    return readWindowsProcessJson(JSON.parse(stdout.trim()))
  } catch {
    // The process exited before the check, or PowerShell is unavailable. Its identity is unknown.
    return null
  }
}

function readWindowsProcessJson(value: unknown): CallerProcess | null {
  if (!isRecord(value)) return null
  const { ParentProcessId, ExecutablePath, Name } = value
  if (typeof ParentProcessId !== 'number' || !Number.isInteger(ParentProcessId)) return null
  if (typeof Name !== 'string') return null
  return {
    parent: ParentProcessId,
    // The Windows map uses bare agent names, so drop the extension and compare without case.
    name: Name.replace(/\.exe$/i, '').toLowerCase(),
    path: typeof ExecutablePath === 'string' ? ExecutablePath : undefined
  }
}

// Authenticode is the Windows signature check. The status must be Valid, the subject must name the publisher,
// and the file metadata must name the product. This rejects another signed product that uses the same name.
async function satisfiesWindows(executable: string, publisher: string, product: string): Promise<boolean> {
  // A PowerShell single-quoted string represents a literal quote as two quotes.
  const path = `'${executable.replaceAll("'", "''")}'`
  const query = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $signature = Get-AuthenticodeSignature -LiteralPath ${path}; $info = (Get-Item -LiteralPath ${path}).VersionInfo; [pscustomobject]@{ Status = $signature.Status.ToString(); Subject = $signature.SignerCertificate.Subject; ProductName = $info.ProductName; FileDescription = $info.FileDescription; OriginalFilename = $info.OriginalFilename } | ConvertTo-Json -Compress`
  try {
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', query],
      { windowsHide: true, timeout: 5000 })
    const signature: unknown = JSON.parse(stdout.trim())
    return isRecord(signature) && signature.Status === 'Valid'
      && typeof signature.Subject === 'string' && signature.Subject.includes(publisher)
      && namesProduct(signature, product)
  } catch {
    return false
  }
}

function namesProduct(signature: Record<string, unknown>, product: string): boolean {
  const text = [signature.ProductName, signature.FileDescription, signature.OriginalFilename]
    .filter((value): value is string => typeof value === 'string').join(' ').toLowerCase()
  return text.includes(product.toLowerCase())
}

async function satisfiesMac(pid: number, requirement: string): Promise<boolean> {
  try {
    await run('/usr/bin/codesign', ['--verify', `-R=${requirement}`, String(pid)])
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
