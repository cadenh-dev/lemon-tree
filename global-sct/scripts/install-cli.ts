import { access, lstat, mkdir, readFile, readlink, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

const marker = '# global.sct command launcher'

// Electron finds its helper apps only from the real executable path. A symbolic link makes it exit before its window opens.
// `exec` replaces the shell, so the caller stays the parent process of global.sct.
export async function installCli(executable: string, destination: string): Promise<void> {
  await access(executable, constants.X_OK)
  const { command, contents } = launcher(executable)
  if (await isInstalled(destination, executable, command)) return
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(`${destination}.tmp`, contents, { mode: 0o755 })
  await rename(`${destination}.tmp`, destination)
}

// Accept a missing command and an earlier global.sct link to the same executable. Reject every other existing command.
async function isInstalled(destination: string, executable: string, command: string): Promise<boolean> {
  try {
    if ((await lstat(destination)).isSymbolicLink()) {
      if (resolve(dirname(destination), await readlink(destination)) === executable) return false
      throw new Error('The sct command points to another application. Remove that link before installing global.sct.')
    }
    const current = await readFile(destination, 'utf8')
    if (!current.includes(marker)) throw new Error('The sct command already exists and is not a global.sct launcher.')
    if (!current.includes(command)) throw new Error('The sct command starts another application. Remove it before installing global.sct.')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function launcher(executable: string): { command: string; contents: string } {
  if (process.platform === 'win32') {
    const command = `"${executable}" %*`
    return { command, contents: `@echo off\nREM ${marker}\n${command}\nexit /b %ERRORLEVEL%\n` }
  }
  const command = `exec '${executable.replaceAll("'", `'\\''`)}' "$@"`
  return { command, contents: `#!/bin/sh\n${marker}\n${command}\n` }
}

if (import.meta.main) {
  const target = cliTarget()
  const destination = resolve(target.destination)
  const executable = resolve(target.executable)
  await installCli(executable, destination)
  if (process.platform === 'win32') {
    // The SDK cannot start a .cmd file without a shell. It reads this file to start the executable directly.
    await writeFile(join(dirname(destination), 'sct.json'), JSON.stringify({ executable }), { mode: 0o600 })
  }
  console.log(`Installed ${destination}`)
  if (!(process.env.PATH ?? '').split(delimiter).includes(dirname(destination))) console.log(target.pathHint)
}

function cliTarget() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (!localAppData) throw new Error('Cannot find LOCALAPPDATA. Set it before you install the sct command.')
    const folder = join(localAppData, 'Programs', 'global.sct', 'bin')
    return {
      destination: join(folder, 'sct.cmd'),
      executable: `dist/global.sct-win32-${process.arch}/sct.exe`,
      pathHint: `Add this folder to PATH, then open a new terminal:\n${folder}`
    }
  }
  const destination = join(homedir(), '.local', 'bin', 'sct')
  return {
    destination,
    executable: process.platform === 'darwin'
      ? `dist/global.sct-darwin-${process.arch}/global.sct.app/Contents/MacOS/sct`
      : `dist/global.sct-linux-${process.arch}/sct`,
    pathHint: `Add this line to ${process.platform === 'darwin' ? '~/.zshrc' : '~/.profile'}, then open a new terminal:\nexport PATH="$HOME/.local/bin:$PATH"`
  }
}
