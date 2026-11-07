import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProjectStore } from '../src/main/projects'
import { readVaultHeader } from '../src/main/vault-header'

// Run only with both apps closed. Preview is the default and never changes storage.
async function migrate(): Promise<void> {
  if (process.argv.slice(2).some((argument) => argument !== '--apply')) {
    throw new Error('Usage: bun run migrate:fork [--apply]. Close both apps before applying the move.')
  }
  const appData = applicationData()
  const previous = join(appData, '.sct')
  const destination = join(appData, 'global.sct')
  const root = await vaultRoot(previous)
  const sourceVault = join(root, '.sct')
  const destinationVault = join(root, 'global.sct')
  if (!existsSync(sourceVault)) throw new Error('No previous .sct vault exists at the configured location.')
  if (!(await readVaultHeader(join(sourceVault, 'vault.json')))) throw new Error('The previous vault has no header. No files were changed.')
  await new ProjectStore(join(previous, 'projects.json')).list()
  if (existsSync(destinationVault)) throw new Error('The global.sct vault already exists. No files were changed.')
  for (const name of ['projects.json', 'settings.json', 'preferences.json', 'sharing', 'relay', 'cards', 'grant-cleanup.sct']) {
    if (existsSync(join(destination, name))) throw new Error(`The destination already contains ${name}. No files were changed.`)
  }
  console.log(`Vault: ${sourceVault} -> ${destinationVault}`)
  console.log(`App records: ${previous} -> ${destination}`)
  if (!process.argv.includes('--apply')) {
    console.log('Preview only. Close both apps, then run bun run migrate:fork --apply to move the vault.')
    return
  }

  // Stage records before moving the vault. Keep the old app records and any destination cache as backups.
  const staging = join(appData, `global.sct-migration-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  for (const name of ['projects.json', 'preferences.json', 'sharing', 'relay', 'cards', 'grant-cleanup.sct']) {
    if (existsSync(join(previous, name))) {
      await cp(join(previous, name), join(staging, name), { recursive: true, force: false, errorOnExist: true })
    }
  }
  await writeFile(join(staging, 'settings.json'), JSON.stringify({ vaultRoot: root }), { mode: 0o600 })
  if (existsSync(destination)) {
    const backup = `${destination}-before-migration-${randomUUID()}`
    await rename(destination, backup)
    console.log(`Previous destination cache preserved at ${backup}`)
  }
  await rename(sourceVault, destinationVault)
  try {
    await rename(staging, destination)
  } catch (error) {
    await rename(destinationVault, sourceVault)
    throw new Error(`Cannot install app records. The vault returned to ${sourceVault}. Staged records remain at ${staging}.`, { cause: error })
  }
  console.log('Migration complete. Open global.sct and unlock with your existing passphrase. Enable Remember this device again if needed.')
}

async function vaultRoot(previous: string): Promise<string> {
  if (!existsSync(join(previous, 'settings.json'))) return homedir()
  const settings: unknown = JSON.parse(await readFile(join(previous, 'settings.json'), 'utf8'))
  if (typeof settings !== 'object' || settings === null || !('vaultRoot' in settings) ||
    typeof settings.vaultRoot !== 'string' || !isAbsolute(settings.vaultRoot)) {
    throw new Error('The previous storage settings are invalid. No files were changed.')
  }
  return resolve(settings.vaultRoot)
}

function applicationData(): string {
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) throw new Error('APPDATA is missing. Cannot locate the previous app records.')
    return resolve(process.env.APPDATA)
  }
  return process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : resolve(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'))
}

await migrate()
