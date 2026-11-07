import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess, StdioOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import type { ProjectStore } from './projects'
import type { Vault } from './vault'
import type { Project } from '../shared/projects'
import { resolveProject, watchProject } from './runtime'

const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
const taskkill = join(systemRoot, 'System32', 'taskkill.exe')

export function launchProject(vault: Vault, projectId: string, executable: string, args: string[], stdio: StdioOptions = 'inherit', detached = false): Promise<ChildProcess> {
  return vault.withProjectEnvironment(projectId, (project, environment) => launchCommand(project, environment, executable, args, stdio, detached))
}

export function launchCommand(project: Project, environment: NodeJS.ProcessEnv, executable: string, args: string[],
  stdio: StdioOptions = 'inherit', detached = false, signal?: AbortSignal): Promise<ChildProcess> {
  return new Promise<ChildProcess>((resolve, reject) => {
    try {
      const child = spawn(executable, args, { cwd: project.directory, env: environment, stdio, shell: false, detached, signal })
      child.once('error', () => reject(new Error('Cannot start the command. Check the executable and project folder.')))
      child.once('spawn', () => resolve(child))
    } catch {
      reject(new Error('Cannot start the command. Check the executable and project folder.'))
    }
  })
}

// The fixed demo is the only program that local Agent Access and remote tasks can start. It returns no process output.
export async function startFixedDemo(project: Project, values: Record<string, string>, executable: string, demo: string,
  signal?: AbortSignal): Promise<ChildProcess> {
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...values }
  try {
    return await launchCommand(project, environment, executable, [demo], 'ignore', false, signal)
  } finally {
    for (const name of Object.keys(environment)) delete environment[name]
  }
}

export async function demoOutcome(child: ChildProcess): Promise<{ exitCode: number; secretPresent: boolean }> {
  const exitCode = await new Promise<number>((resolve) => child.once('close', (code) => resolve(code ?? 1)))
  return { exitCode, secretPresent: exitCode === 0 }
}

export async function runProject(projects: ProjectStore, vault: Vault, args: string[]): Promise<number> {
  const { interactive, projectName, executable, commandArgs } = requireRunArguments(args)
  const project = await resolveProject(projects, projectName)
  if (interactive) return runInteractive(vault, project, executable, commandArgs)
  let child: ChildProcess | undefined
  let restarting = false
  let closing = false
  let forwardedSignal: NodeJS.Signals | undefined
  let forceStop: NodeJS.Timeout | undefined
  let finish: (code: number) => void = () => undefined
  const exited = new Promise<number>((resolve) => { finish = resolve })
  const forward = (signal: NodeJS.Signals) => {
    closing = true
    forwardedSignal = signal
    if (child) {
      signalCommand(child, signal)
      if (process.platform === 'win32') {
        clearTimeout(forceStop)
        forceStop = setTimeout(() => { if (child) signalCommand(child, 'SIGKILL') }, 2000)
      }
    } else finish(128 + constants.signals[signal])
  }
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)
  process.on('SIGHUP', forward)
  let stop: (() => Promise<void>) | undefined
  try {
    stop = await watchProject(vault, project.id, async () => {
      restarting = true
      if (child) await stopCommand(child)
      if (closing) return
      child = await launchProject(vault, project.id, executable, commandArgs, 'inherit', true)
      restarting = false
      const launched = child
      child.once('close', (code, signal) => {
        clearTimeout(forceStop)
        signalCommand(launched, 'SIGKILL')
        child = undefined
        if (!restarting || closing) {
          finish(closing && forwardedSignal && code === null ? 128 + constants.signals[forwardedSignal]
            : code ?? (signal ? 128 + constants.signals[signal] : 1))
        }
      })
    }, async () => {
      restarting = true
      if (child) await stopCommand(child)
      console.error('Cannot refresh global.sct secrets. The command is stopped until the vault is available.')
    })
    return await exited
  } finally {
    closing = true
    clearTimeout(forceStop)
    await stop?.()
    if (child) await stopCommand(child)
    process.off('SIGINT', forward)
    process.off('SIGTERM', forward)
    process.off('SIGHUP', forward)
  }
}

// An interactive command, such as a shell, owns the terminal. It stays attached to the terminal of sct:
// on POSIX it is not in a new session, and on Windows it uses the same console.
// The terminal sends Ctrl+C and hang-up to the shell itself, so sct ignores them and forwards nothing.
// A restart would end the shell session, so a secret change only prints a notice.
async function runInteractive(vault: Vault, project: Project, executable: string, args: string[]): Promise<number> {
  let child: ChildProcess | undefined
  let exited: Promise<number> | undefined
  let started = false
  let notified = false
  let terminating = false
  const ignore = () => undefined
  // SIGTERM does not come from the terminal. It stops the shell, so no shell with secrets stays after sct exits.
  const terminate = () => {
    if (!child || terminating) return
    terminating = true
    void stopInteractive(child)
  }
  process.on('SIGINT', ignore)
  process.on('SIGHUP', ignore)
  process.on('SIGTERM', terminate)
  let stop: (() => Promise<void>) | undefined
  try {
    stop = await watchProject(vault, project.id, async () => {
      if (!started) {
        started = true
        const launched = await launchProject(vault, project.id, executable, args)
        child = launched
        // Listen at once. A short command can exit before the watcher returns.
        exited = new Promise<number>((resolve) => {
          launched.once('close', (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)))
        })
        return
      }
      if (notified) return
      notified = true
      console.error('Secrets changed. Open a new terminal.')
    }, async () => {
      console.error('Cannot read the global.sct secrets. This terminal keeps its current values. Open a new terminal after you fix the vault.')
    })
    if (!exited) throw new Error('Cannot start the command. Check the executable and project folder.')
    return await exited
  } finally {
    await stop?.()
    process.off('SIGINT', ignore)
    process.off('SIGHUP', ignore)
    process.off('SIGTERM', terminate)
  }
}

export function requireRunArguments(args: string[]) {
  const interactive = args[1] === '--interactive'
  const rest = interactive ? args.slice(2) : args.slice(1)
  const separator = rest[0] === '--' ? 0 : 1
  if (args[0] !== 'run' || rest[separator] !== '--' || !rest[separator + 1]) {
    throw new Error('Usage: sct run [--interactive] ["Project name"] -- <executable> [arguments]')
  }
  return { interactive, projectName: separator === 0 ? undefined : rest[0], executable: rest[separator + 1], commandArgs: rest.slice(separator + 2) }
}

function signalCommand(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // A reused PID must never receive a stop signal after this child exits.
    if (child.exitCode !== null || child.signalCode !== null) return
    stopWindowsTree(child.pid, signal === 'SIGKILL')
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    // macOS returns EPERM for a group with only zombies. Live processes must still produce an error.
    if (process.platform === 'darwin' && (error as NodeJS.ErrnoException).code === 'EPERM' && commandGroupExited(child.pid)) return
    throw error
  }
}

// Windows has no process groups. Try a normal stop first, then force the child tree after the grace period.
function stopWindowsTree(pid: number, force: boolean): void {
  const result = spawnSync(taskkill, force ? ['/T', '/F', '/PID', String(pid)] : ['/T', '/PID', String(pid)],
    { stdio: 'ignore', windowsHide: true, timeout: 2000 })
  // taskkill uses exit code 128 when the process is already gone. A failed normal stop waits for the force step.
  if (force && (result.error || (result.status !== 0 && result.status !== 128))) {
    console.error(result.error?.message ?? `taskkill exited with code ${result.status}.`)
  }
}

function commandGroupExited(pid: number): boolean {
  const ps = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path))
  if (!ps) return false
  const result = spawnSync(ps, ['-axo', 'pgid=,stat='], { encoding: 'utf8' })
  if (result.status !== 0) return false
  return result.stdout.split('\n').every((line) => {
    const [group, state] = line.trim().split(/\s+/)
    return group !== String(pid) || state?.startsWith('Z') === true
  })
}

async function stopCommand(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    signalCommand(child, 'SIGKILL')
    return
  }
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  signalCommand(child, 'SIGTERM')
  const force = setTimeout(() => signalCommand(child, 'SIGKILL'), 2000)
  try {
    await exited
  } finally {
    clearTimeout(force)
    signalCommand(child, 'SIGKILL')
  }
}

// The interactive child is not its own process-group leader. Signal the child directly, not a negative PID.
async function stopInteractive(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const force = setTimeout(() => {
    if (process.platform === 'win32') {
      if (child.pid) stopWindowsTree(child.pid, true)
    } else {
      child.kill('SIGKILL')
    }
  }, 2000)
  try {
    if (process.platform === 'win32') {
      if (child.pid) stopWindowsTree(child.pid, true)
    } else {
      child.kill('SIGTERM')
    }
    await exited
  } finally {
    clearTimeout(force)
  }
}
