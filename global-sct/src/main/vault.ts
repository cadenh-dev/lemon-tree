import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { cp, link, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isProjectName } from './projects.ts'
import type { ProjectStore } from './projects.ts'
import type { Project } from '../shared/projects.ts'
import type { SecretMetadata } from '../shared/secrets.ts'
import type { RelayGrant } from '../shared/envelope.ts'
import type { SealedField, UnlockInput, VaultStatus } from '../shared/vault.ts'
import type { TransferSecret } from './transfer.ts'
import { decodeFile, encodeFile, open, seal } from './seal.ts'
import { createVaultHeader, decodeSealed, deriveMasterKey, encodeSealed, readVaultHeader,
  verifyPassphrase as checkPassphrase, writeVaultHeader } from './vault-header.ts'
import type { SecretStore } from './key-store.ts'

// secrets.sct layout: magic | IV | GCM tag | ciphertext. The ciphertext holds names and individually sealed values.
const magic = Buffer.from('SCT2')
const cleanupMagic = Buffer.from('SCG2')
const internalMagic = Buffer.from('SCI2')
const vaultDirectoryName = 'global.sct'
const secretsFileName = 'secrets.sct'
const headerFileName = 'vault.json'
const cleanupFileName = 'grant-cleanup.sct'
const internalDirectoryName = '.internal'
const cleanupData = Buffer.from('grant-cleanup')
const minimumPassphraseLength = 8

interface StoredSecret {
  id: string
  name: string
  // The value data key, wrapped by the master key.
  wrappedKey: SealedField
  // The value, sealed by the data key.
  value: SealedField
  transferId?: string
  grant?: RelayGrant
}

export interface GrantCleanupOutcome {
  id: string
  transferId: string
  projectId: string
  secretId: string
  expiredAt: number
  cleanedAt: number | null
  status: 'removed' | 'failed'
  error: string | null
}

export class Vault {
  private pending: Promise<void> = Promise.resolve()
  private root = ''
  private masterKey: Buffer | null = null
  private readonly projects: ProjectStore
  private readonly settingsFile: string
  private readonly defaultRoot: string
  private readonly store: SecretStore

  constructor(projects: ProjectStore, settingsFile: string, defaultRoot: string, store: SecretStore) {
    this.projects = projects
    this.settingsFile = settingsFile
    this.defaultRoot = defaultRoot
    this.store = store
  }

  async start(): Promise<void> {
    this.root = await this.readRoot()
    try {
      await mkdir(this.location(), { recursive: true, mode: 0o700 })
      await this.createProjectDirectories()
    } catch (error) {
      throw new Error(`Cannot create the vault folders at ${this.location()}.`, { cause: error })
    }
  }

  location(): string {
    return join(this.root, vaultDirectoryName)
  }

  isLocked(): boolean {
    return this.masterKey === null
  }

  status(): Promise<VaultStatus> {
    return this.serialize(() => this.readStatus())
  }

  unlock(input: unknown): Promise<VaultStatus> {
    return this.serialize(async () => {
      const { passphrase, remember } = requireUnlockInput(input)
      this.root = await this.readRoot()
      const file = this.headerFile()
      const saved = await readVaultHeader(file)
      if (saved) {
        const masterKey = await deriveMasterKey(passphrase, saved.kdf, saved.salt)
        if (!checkPassphrase(masterKey, saved)) {
          masterKey.fill(0)
          throw new Error('The passphrase is not correct. Try again.')
        }
        this.setMasterKey(masterKey)
      } else {
        if (passphrase.length < minimumPassphraseLength) {
          throw new Error(`Use a passphrase of at least ${minimumPassphraseLength} characters.`)
        }
        const { header, masterKey } = await createVaultHeader(passphrase)
        await writeVaultHeader(file, header)
        this.setMasterKey(masterKey)
      }
      if (remember && !(await this.store.available())) {
        this.setMasterKey(null)
        throw new Error('This system has no secret service. Clear "Remember this device" and use the passphrase.')
      }
      if (remember) {
        try {
          await this.store.write(this.masterKey as Buffer)
        } catch (error) {
          this.setMasterKey(null)
          throw new Error('Cannot save the vault key in the system secret store. Clear "Remember this device" and try again.', { cause: error })
        }
      } else {
        await this.store.clear()
      }
      return await this.readStatus()
    })
  }

  // The app calls this at each start. A missing or wrong remembered key falls back to the passphrase.
  unlockWithRememberedKey(): Promise<boolean> {
    return this.serialize(async () => {
      if (this.masterKey) return true
      this.root = await this.readRoot()
      const header = await readVaultHeader(this.headerFile())
      if (!header) return false
      const stored = await this.store.read()
      if (!stored) return false
      if (!checkPassphrase(stored, header)) {
        stored.fill(0)
        await this.store.clear()
        return false
      }
      this.setMasterKey(stored)
      return true
    })
  }

  // A share confirmation checks the passphrase without replacing the active master key.
  verifySharePassphrase(input: unknown): Promise<void> {
    return this.serialize(async () => {
      this.requireKey()
      if (typeof input !== 'string' || input.length === 0 || input.length > 1024) throw new Error('Enter your vault passphrase.')
      const header = await readVaultHeader(this.headerFile())
      if (!header) throw new Error('The vault header is unavailable. Unlock the vault and try again.')
      const masterKey = await deriveMasterKey(input, header.kdf, header.salt)
      try {
        if (!checkPassphrase(masterKey, header)) throw new Error('The passphrase is not correct. Try again.')
      } finally {
        masterKey.fill(0)
      }
    })
  }

  project(id: string): Promise<Project> {
    return this.serialize(async () => {
      this.requireKey()
      return await this.projects.find(id)
    })
  }

  lock(): Promise<VaultStatus> {
    return this.serialize(async () => {
      this.setMasterKey(null)
      return await this.readStatus()
    })
  }

  forget(): Promise<VaultStatus> {
    return this.serialize(async () => {
      await this.store.clear()
      this.setMasterKey(null)
      return await this.readStatus()
    })
  }

  moveTo(root: unknown): Promise<string> {
    return this.serialize(async () => {
      const newRoot = await requireDirectory(root)
      const current = this.location()
      const target = join(newRoot, vaultDirectoryName)
      if (target === current) return current
      if (target.startsWith(`${current}${sep}`)) throw new Error('Select a folder outside the current global.sct folder.')
      if (await exists(target)) throw new Error('The selected folder already contains a global.sct folder. Select a different folder.')

      await moveDirectory(current, target)
      try {
        await writeJson(this.settingsFile, { vaultRoot: newRoot })
      } catch (error) {
        await moveDirectory(target, current)
        throw new Error('Cannot save the new storage location. The vault stays in its previous folder.', { cause: error })
      }
      this.root = newRoot
      return target
    })
  }

  addProject(input: unknown): Promise<Project> {
    return this.serialize(async () => {
      const project = await this.projects.add(input)
      await mkdir(this.projectDirectory(project.name), { recursive: true, mode: 0o700 })
      return project
    })
  }

  renameProject(input: unknown): Promise<Project> {
    return this.serialize(() => this.projects.rename(input, async (project, name) => {
      const from = this.projectDirectory(project.name)
      const to = this.projectDirectory(name)
      if (!(await exists(from))) return
      // macOS ignores letter case, so a rename from "App" to "app" finds its own folder at the new path.
      if (from.toLowerCase() !== to.toLowerCase() && await exists(to)) {
        throw new Error(`The vault already contains a folder named ${name}. Move or remove that folder, then try again.`)
      }
      try {
        await rename(from, to)
      } catch (error) {
        throw new Error(`Cannot rename the vault folder of ${project.name}. Check the folder permissions.`, { cause: error })
      }
    }))
  }

  // Deletes the project's vault directory. The project folder itself stays unchanged.
  deleteProject(id: unknown): Promise<void> {
    return this.serialize(() => this.projects.remove(id, async (project) => {
      await rm(this.projectDirectory(project.name), { recursive: true, force: true })
    }))
  }

  listSecrets(): Promise<SecretMetadata[]> {
    return this.serialize(async () => {
      this.requireKey()
      const secrets: SecretMetadata[] = []
      for (const project of await this.projects.list()) {
        for (const { id, name } of await this.readSecrets(project)) secrets.push({ id, projectId: project.id, name })
      }
      return secrets
    })
  }

  listProjectSecrets(projectId: string): Promise<SecretMetadata[]> {
    return this.serialize(async () => {
      this.root = await this.readRoot()
      const project = await this.projects.find(projectId)
      return (await this.readSecrets(project)).map(({ id, name }) => ({ id, name, projectId: project.id }))
    })
  }

  addSecret(input: unknown): Promise<SecretMetadata> {
    return this.serialize(async () => {
      const { projectId, name, value } = requireSecretInput(input)
      const project = await this.projects.find(projectId)
      const secrets = await this.readSecrets(project)
      if (secrets.some((secret) => secret.name === name)) {
        throw new Error(`${name} already exists in ${project.name}. Delete it first, or update its value.`)
      }

      const id = randomUUID()
      const dataKey = randomBytes(32)
      const plaintext = Buffer.from(value)
      try {
        const sealed = seal(dataKey, plaintext, valueData(project, id))
        const wrappedKey = encodeSealed(seal(this.requireKey(), dataKey, keyData(project, id)))
        await this.writeSecrets(project, [...secrets, { id, name, wrappedKey, value: encodeSealed(sealed) }])
      } finally {
        dataKey.fill(0)
        plaintext.fill(0)
      }
      return { id, projectId: project.id, name }
    })
  }

  updateSecret(input: unknown): Promise<SecretMetadata> {
    return this.serialize(async () => {
      const { projectId, id, value } = requireSecretUpdate(input)
      const project = await this.projects.find(projectId)
      const secrets = await this.readSecrets(project)
      const secret = requireSecret(secrets, id)
      const dataKey = this.unwrapDataKey(project, secret)
      const plaintext = Buffer.from(value)
      try {
        const updated = { ...secret, value: encodeSealed(seal(dataKey, plaintext, valueData(project, secret.id))) }
        await this.writeSecrets(project, secrets.map((saved) => saved.id === secret.id ? updated : saved))
      } finally {
        dataKey.fill(0)
        plaintext.fill(0)
      }
      return { id: secret.id, projectId: project.id, name: secret.name }
    })
  }

  // Main-process consumers must not retain or return plaintext. No IPC handler exposes this method.
  withSecret<T>(input: unknown, use: (value: Buffer) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const { projectId, id } = requireSecretReference(input)
      const project = await this.projects.find(projectId)
      const value = await this.decryptSecret(project, requireSecret(await this.readSecrets(project), id))
      try {
        return await use(value)
      } finally {
        value.fill(0)
      }
    })
  }

  withSelectedSecrets<T>(projectId: unknown, ids: unknown,
    use: (project: Project, secrets: { name: string; value: Buffer }[]) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const selected = requireSecretIds(ids)
      this.root = await this.readRoot()
      const project = await this.projects.find(projectId)
      const stored = await this.readSecrets(project)
      for (const id of selected) requireReshare(requireSecret(stored, id))
      const values: { name: string; value: Buffer }[] = []
      try {
        const reads = await Promise.allSettled(selected.map(async (id) => {
          const secret = requireSecret(stored, id)
          return { name: secret.name, value: await this.decryptSecret(project, secret) }
        }))
        for (const read of reads) if (read.status === 'fulfilled') values.push(read.value)
        for (const read of reads) if (read.status === 'rejected') throw read.reason
        return await use(project, values)
      } finally {
        for (const secret of values) secret.value.fill(0)
      }
    })
  }

  // One encrypted file commit prevents a failed batch from leaving half the transfer in the vault.
  importSecrets(projectId: unknown, input: readonly TransferSecret[], transferId: string,
    beforeWrite: () => Promise<void>, grant?: RelayGrant): Promise<SecretMetadata[]> {
    return this.serialize(async () => {
      const project = await this.projects.find(projectId)
      const incoming = input.map((entry) => requireSecretInput({ ...entry, projectId: project.id }))
      if (!incoming.length || new Set(incoming.map((entry) => entry.name)).size !== incoming.length) {
        throw new Error('The transfer contains no secrets or contains duplicate names.')
      }
      const stored = await this.readSecrets(project)
      const imported = stored.filter((secret) => secret.transferId === transferId)
      if (imported.length) {
        if (imported.length !== incoming.length || incoming.some((entry) => !imported.some((secret) => secret.name === entry.name))) {
          throw new Error('This transfer was already imported and its secrets changed. No secrets were imported again.')
        }
        return imported.map(({ id, name }) => ({ id, name, projectId: project.id }))
      }
      for (const entry of incoming) {
        if (stored.some((secret) => secret.name === entry.name)) {
          throw new Error(`${entry.name} already exists in ${project.name}. Choose another project or resolve the name conflict first.`)
        }
      }
      await beforeWrite()
      const added: StoredSecret[] = []
      for (const entry of incoming) {
        const id = randomUUID()
        const dataKey = randomBytes(32)
        const plaintext = Buffer.from(entry.value)
        try {
          const sealed = seal(dataKey, plaintext, valueData(project, id))
          const wrappedKey = encodeSealed(seal(this.requireKey(), dataKey, keyData(project, id)))
          added.push({ id, name: entry.name, transferId, grant, wrappedKey, value: encodeSealed(sealed) })
        } finally {
          dataKey.fill(0)
          plaintext.fill(0)
        }
      }
      await this.writeSecrets(project, [...stored, ...added])
      return added.map(({ id, name }) => ({ id, name, projectId: project.id }))
    })
  }

  // The callback starts the child before this method removes its environment references.
  withProjectEnvironment<T>(projectId: string, use: (project: Project, environment: NodeJS.ProcessEnv) => T | Promise<T>): Promise<T> {
    return this.withProjectSecrets(projectId, async (project, values) => {
      const environment = { ...process.env, ...values }
      try {
        return await use(project, environment)
      } finally {
        for (const name of Object.keys(environment)) delete environment[name]
      }
    })
  }

  projectRevision(projectId: string): Promise<string> {
    return this.serialize(async () => {
      this.root = await this.readRoot()
      const project = await this.projects.find(projectId)
      const file = await stat(join(this.projectDirectory(project.name), secretsFileName))
      return JSON.stringify([project.name, project.directory, this.root, file.ino, file.mtimeMs, file.ctimeMs, file.size])
    })
  }

  // Trusted local consumers receive only this project's values, never the inherited environment.
  withProjectSecrets<T>(projectId: string, use: (project: Project, values: Record<string, string>) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      this.root = await this.readRoot()
      const project = await this.projects.find(projectId)
      requireExternalVault(project, this.location())
      const environment: Record<string, string> = {}
      try {
        const reads = await Promise.allSettled((await this.readSecrets(project, true)).map(
          (secret) => this.addEnvironmentSecret(project, secret, environment)
        ))
        // Complete all reads before cleanup, including when one key is unavailable.
        for (const read of reads) if (read.status === 'rejected') throw read.reason
        return await use(project, environment)
      } finally {
        for (const name of Object.keys(environment)) delete environment[name]
      }
    })
  }

  // A remote task receives only the secrets of one relay grant. Injection-only grants permit this use.
  withGrantSecrets<T>(projectId: string, grantId: string, use: (project: Project, values: Record<string, string>) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      this.root = await this.readRoot()
      const project = await this.projects.find(projectId)
      requireExternalVault(project, this.location())
      const granted = (await this.readSecrets(project, true)).filter((secret) => secret.transferId?.startsWith(`relay:${grantId}:`))
      if (!granted.length) throw new Error('The secrets of this grant are no longer in the project.')
      const environment: Record<string, string> = {}
      try {
        const reads = await Promise.allSettled(granted.map((secret) => this.addEnvironmentSecret(project, secret, environment)))
        for (const read of reads) if (read.status === 'rejected') throw read.reason
        return await use(project, environment)
      } finally {
        for (const name of Object.keys(environment)) delete environment[name]
      }
    })
  }

  deleteSecret(input: unknown): Promise<void> {
    return this.serialize(async () => {
      const { projectId, id } = requireSecretReference(input)
      const project = await this.projects.find(projectId)
      await this.removeSecret(project, await this.readSecrets(project), id)
    })
  }

  cleanupExpiredGrants(now = Date.now()): Promise<GrantCleanupOutcome[]> {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(now)) throw new Error('The grant cleanup time is invalid.')
      this.root = await this.readRoot()
      const outcomes = await this.readGrantCleanupOutcomes()
      let changed = false
      for (const project of (await this.projects.list()).filter((saved) => isProjectName(saved.name))) {
        let secrets: StoredSecret[]
        try {
          secrets = await this.readSecrets(project)
        } catch {
          // Cleanup cannot identify grants in an unreadable vault. Normal project access reports the storage error.
          continue
        }
        for (const secret of secrets.filter((saved) => saved.grant?.accessExpiresAt !== null &&
          saved.grant?.accessExpiresAt !== undefined && saved.grant.accessExpiresAt <= now)) {
          const previous = outcomes.find((outcome) => outcome.transferId === secret.transferId && outcome.secretId === secret.id)
          try {
            secrets = await this.removeSecret(project, secrets, secret.id)
            replaceCleanupOutcome(outcomes, previous, {
              id: previous?.id ?? randomUUID(), transferId: secret.transferId ?? '', projectId: project.id, secretId: secret.id,
              expiredAt: secret.grant?.accessExpiresAt ?? now, cleanedAt: now, status: 'removed', error: null
            })
          } catch (error) {
            replaceCleanupOutcome(outcomes, previous, {
              id: previous?.id ?? randomUUID(), transferId: secret.transferId ?? '', projectId: project.id, secretId: secret.id,
              expiredAt: secret.grant?.accessExpiresAt ?? now, cleanedAt: null, status: 'failed',
              error: error instanceof Error ? error.message : 'The expired secret could not be removed.'
            })
          }
          changed = true
        }
      }
      if (changed) await this.writeGrantCleanupOutcomes(outcomes)
      return outcomes
    })
  }

  grantCleanupOutcomes(): Promise<GrantCleanupOutcome[]> {
    return this.serialize(() => this.readGrantCleanupOutcomes())
  }

  // Internal values, such as the sharing identity and relay tokens, live under the master key.
  // A system with no OS secret service can still create the sharing identity and store the relay token.
  readInternal(name: string): Promise<Buffer | null> {
    return this.serialize(async () => {
      requireInternalName(name)
      this.requireKey()
      this.root = await this.readRoot()
      let contents: Buffer
      try {
        contents = await readFile(this.internalFile(name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error('Cannot read the encrypted internal secret.', { cause: error })
      }
      const sealed = decodeFile(internalMagic, contents)
      if (!sealed) throw new Error('The internal secret file is invalid.')
      return this.openInternalContents(sealed, name)
    })
  }

  // Creates the value only if no file exists. Returns the existing value when another process won the race.
  writeInternalIfAbsent(name: string, value: Buffer): Promise<Buffer | null> {
    return this.serialize(async () => {
      requireInternalName(name)
      this.requireKey()
      this.root = await this.readRoot()
      const file = this.internalFile(name)
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        await writeFile(temporary, encodeFile(internalMagic, seal(this.requireKey(), value, internalData(name))), { mode: 0o600 })
        try {
          // A hard link exposes only the complete temporary file and fails if the target exists.
          await link(temporary, file)
          return null
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          return await this.readInternalFile(file, name)
        }
      } catch (error) {
        throw new Error('Cannot create the encrypted internal secret.', { cause: error })
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    })
  }

  writeInternal(name: string, value: Buffer): Promise<void> {
    return this.serialize(async () => {
      requireInternalName(name)
      this.requireKey()
      this.root = await this.readRoot()
      const file = this.internalFile(name)
      // Each write uses its own temporary file, so two processes cannot rename a partial file.
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        await writeFile(temporary, encodeFile(internalMagic, seal(this.requireKey(), value, internalData(name))), { mode: 0o600 })
        await rename(temporary, file)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw new Error('Cannot save the encrypted internal secret.', { cause: error })
      }
    })
  }

  private async readInternalFile(file: string, name: string): Promise<Buffer> {
    const contents = await readFile(file)
    const sealed = decodeFile(internalMagic, contents)
    if (!sealed) throw new Error('The internal secret file is invalid.')
    return this.openInternalContents(sealed, name)
  }

  private openInternalContents(sealed: { iv: Buffer; tag: Buffer; ciphertext: Buffer }, name: string): Buffer {
    try {
      return open(this.requireKey(), sealed, internalData(name))
    } catch (error) {
      throw new Error('Cannot open the encrypted internal secret.', { cause: error })
    }
  }

  private requireKey(): Buffer {
    if (!this.masterKey) throw new Error('The vault is locked. Unlock it with your passphrase.')
    return this.masterKey
  }

  private setMasterKey(key: Buffer | null): void {
    this.masterKey?.fill(0)
    this.masterKey = key
  }

  private async readStatus(): Promise<VaultStatus> {
    const [header, rememberAvailable] = await Promise.all([readVaultHeader(this.headerFile()), this.store.available()])
    const remembered = rememberAvailable ? await this.store.read() : null
    return {
      initialized: header !== null,
      locked: this.masterKey === null,
      rememberAvailable,
      rememberEnabled: remembered !== null
    }
  }

  private headerFile(): string {
    return join(this.location(), headerFileName)
  }

  private async decryptSecret(project: Project, secret: StoredSecret): Promise<Buffer> {
    requireActiveGrant(secret)
    const dataKey = this.unwrapDataKey(project, secret)
    try {
      return open(dataKey, decodeSealed(secret.value), valueData(project, secret.id))
    } catch (error) {
      throw new Error('Cannot decrypt this secret. Its encrypted value is invalid.', { cause: error })
    } finally {
      dataKey.fill(0)
    }
  }

  private unwrapDataKey(project: Project, secret: StoredSecret): Buffer {
    try {
      return open(this.requireKey(), decodeSealed(secret.wrappedKey), keyData(project, secret.id))
    } catch (error) {
      throw new Error('Cannot open this secret. The vault key is wrong, or the stored key is damaged.', { cause: error })
    }
  }

  private async addEnvironmentSecret(project: Project, secret: StoredSecret, environment: NodeJS.ProcessEnv): Promise<void> {
    if (!isSecretName(secret.name)) throw new Error('A stored secret name is invalid for the process environment.')
    const value = await this.decryptSecret(project, secret)
    try {
      const plaintext = value.toString('utf8')
      if (!isSecretValue(plaintext)) throw new Error('A stored secret value is invalid for the process environment.')
      // defineProperty also supports valid names such as __proto__.
      Object.defineProperty(environment, secret.name, { value: plaintext, enumerable: true, configurable: true })
    } finally {
      value.fill(0)
    }
  }

  private async removeSecret(project: Project, secrets: StoredSecret[], id: string): Promise<StoredSecret[]> {
    const secret = requireSecret(secrets, id)
    const remaining = secrets.filter((saved) => saved.id !== secret.id)
    await this.writeSecrets(project, remaining)
    return remaining
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  // Projects from earlier versions get their folder here. The Projects screen reports an unreadable list,
  // and an older name that is not a valid folder name stays without a folder until the user renames it.
  private async createProjectDirectories(): Promise<void> {
    let projects: Project[]
    try {
      projects = await this.projects.list()
    } catch {
      return
    }
    for (const project of projects.filter((saved) => isProjectName(saved.name))) {
      await mkdir(this.projectDirectory(project.name), { recursive: true, mode: 0o700 })
    }
  }

  private async readRoot(): Promise<string> {
    let contents: string
    try {
      contents = await readFile(this.settingsFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.defaultRoot
      throw new Error('Cannot read the storage settings.', { cause: error })
    }
    let settings: unknown
    try {
      settings = JSON.parse(contents)
    } catch (error) {
      throw new Error('The storage settings are invalid. global.sct did not change them.', { cause: error })
    }
    if (typeof settings !== 'object' || settings === null || !('vaultRoot' in settings) ||
      typeof settings.vaultRoot !== 'string' || !isAbsolute(settings.vaultRoot)) {
      throw new Error('The storage settings are invalid. global.sct did not change them.')
    }
    return settings.vaultRoot
  }

  // Validates the name again and checks that the result stays one level below the vault folder.
  private projectDirectory(name: string): string {
    const vault = this.location()
    const directory = join(vault, name)
    const path = relative(vault, directory)
    if (!isProjectName(name) || path !== name || path.includes(sep) || path === '..') {
      throw new Error('This project name cannot be used as a vault folder name.')
    }
    return directory
  }

  private async readSecrets(project: Project, required = false): Promise<StoredSecret[]> {
    const key = this.requireKey()
    let contents: Buffer
    try {
      contents = await readFile(join(this.projectDirectory(project.name), secretsFileName))
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`Cannot read the secrets of ${project.name}.`, { cause: error })
    }

    const invalid = `The secrets file of ${project.name} is invalid or belongs to a different project. global.sct did not change it.`
    const sealed = decodeFile(magic, contents)
    if (!sealed) throw new Error(invalid)
    let secrets: unknown
    try {
      secrets = JSON.parse(open(key, sealed, fileData(project)).toString('utf8'))
    } catch (error) {
      throw new Error(invalid, { cause: error })
    }
    if (!Array.isArray(secrets) || !secrets.every(isStoredSecret)) throw new Error(invalid)
    return secrets
  }

  private async writeSecrets(project: Project, secrets: StoredSecret[]): Promise<void> {
    await this.writeSecretsFile(project, encodeFile(magic, seal(this.requireKey(), Buffer.from(JSON.stringify(secrets)), fileData(project))))
  }

  private async writeSecretsFile(project: Project, contents: Buffer): Promise<void> {
    const directory = this.projectDirectory(project.name)
    const filename = join(directory, secretsFileName)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(`${filename}.tmp`, contents, { mode: 0o600 })
      await rename(`${filename}.tmp`, filename)
    } catch (error) {
      throw new Error(`Cannot save the secrets of ${project.name}. Check your local storage permissions.`, { cause: error })
    }
  }

  private internalFile(name: string): string {
    return join(this.location(), internalDirectoryName, `${createHash('sha256').update(name).digest('hex')}.sct`)
  }

  private async readGrantCleanupOutcomes(): Promise<GrantCleanupOutcome[]> {
    try {
      const contents = await readFile(this.cleanupFile())
      const sealed = decodeFile(cleanupMagic, contents)
      if (!sealed) throw new Error('The cleanup history is invalid.')
      let plaintext: Buffer | undefined
      try {
        plaintext = open(this.requireKey(), sealed, cleanupData)
        const parsed: unknown = JSON.parse(plaintext.toString('utf8'))
        if (!Array.isArray(parsed) || !parsed.every(isGrantCleanupOutcome)) throw new Error('The cleanup history is invalid.')
        return parsed
      } finally {
        plaintext?.fill(0)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('Cannot read the encrypted grant cleanup history.', { cause: error })
    }
  }

  private async writeGrantCleanupOutcomes(outcomes: GrantCleanupOutcome[]): Promise<void> {
    const file = this.cleanupFile()
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(`${file}.tmp`,
        encodeFile(cleanupMagic, seal(this.requireKey(), Buffer.from(JSON.stringify(outcomes)), cleanupData)), { mode: 0o600 })
      await rename(`${file}.tmp`, file)
    } catch (error) {
      throw new Error('Cannot save the encrypted grant cleanup history.', { cause: error })
    }
  }

  private cleanupFile(): string {
    return join(dirname(this.settingsFile), cleanupFileName)
  }
}

// Additional authenticated data binds each ciphertext to its project and secret, so a copied file or entry fails to open.
function fileData(project: Project): Buffer {
  return Buffer.from(`${project.id}/file`)
}

function valueData(project: Project, id: string): Buffer {
  return Buffer.from(`${project.id}/${id}`)
}

function keyData(project: Project, id: string): Buffer {
  return Buffer.from(`${project.id}/${id}/data-key`)
}

export function requireExternalVault(project: Project, location: string): void {
  const storage = relative(project.directory, location)
  if (!isAbsolute(storage) && storage !== '..' && !storage.startsWith(`..${sep}`)) {
    throw new Error('Move vault storage outside the project folder before launch.')
  }
}

function internalData(name: string): Buffer {
  return Buffer.from(`internal/${name}`)
}

function requireInternalName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9/_-]{0,200}$/.test(name)) {
    throw new Error('The internal secret name is invalid.')
  }
}

function isStoredSecret(value: unknown): value is StoredSecret {
  if (typeof value !== 'object' || value === null) return false
  const secret = value as Record<string, unknown>
  return typeof secret.id === 'string' && typeof secret.name === 'string' &&
    isSealedField(secret.wrappedKey) && isSealedField(secret.value) &&
    (secret.transferId === undefined || typeof secret.transferId === 'string') &&
    (secret.grant === undefined || isRelayGrant(secret.grant))
}

function isSealedField(value: unknown): value is SealedField {
  if (typeof value !== 'object' || value === null) return false
  const field = value as Record<string, unknown>
  return typeof field.iv === 'string' && typeof field.tag === 'string' && typeof field.ciphertext === 'string'
}

function isRelayGrant(value: unknown): value is RelayGrant {
  if (typeof value !== 'object' || value === null) return false
  const grant = value as Record<string, unknown>
  return (grant.accessExpiresAt === null || Number.isSafeInteger(grant.accessExpiresAt)) &&
    typeof grant.injectionOnly === 'boolean'
}

function isGrantCleanupOutcome(value: unknown): value is GrantCleanupOutcome {
  if (typeof value !== 'object' || value === null) return false
  const outcome = value as Record<string, unknown>
  return ['id', 'transferId', 'projectId', 'secretId'].every((field) => typeof outcome[field] === 'string') &&
    Number.isSafeInteger(outcome.expiredAt) && (outcome.cleanedAt === null || Number.isSafeInteger(outcome.cleanedAt)) &&
    (outcome.status === 'removed' || outcome.status === 'failed') && (outcome.error === null || typeof outcome.error === 'string')
}

function replaceCleanupOutcome(outcomes: GrantCleanupOutcome[], previous: GrantCleanupOutcome | undefined,
  outcome: GrantCleanupOutcome): void {
  if (!previous) outcomes.push(outcome)
  else outcomes[outcomes.indexOf(previous)] = outcome
}

function requireActiveGrant(secret: StoredSecret, now = Date.now()): void {
  if (secret.grant?.accessExpiresAt !== null && secret.grant?.accessExpiresAt !== undefined && secret.grant.accessExpiresAt <= now) {
    throw new Error(`${secret.name} has an expired access grant.`)
  }
}

function requireReshare(secret: StoredSecret): void {
  requireActiveGrant(secret)
  if (secret.grant?.injectionOnly) throw new Error(`${secret.name} has an injection-only grant and cannot be shared again.`)
}

function requireSecretIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 1000 ||
    !input.every((id): id is string => typeof id === 'string' && id.length > 0) || new Set(input).size !== input.length) {
    throw new Error('Select between 1 and 1000 different secrets from one project.')
  }
  return input
}

// Secret names follow environment variable rules, because approved processes receive secrets as environment variables.
function isSecretName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name)
}

function isSecretValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 65536 && !value.includes('\0')
}

function requireUnlockInput(input: unknown): UnlockInput {
  if (typeof input !== 'object' || input === null) throw new Error('Enter your vault passphrase.')
  const { passphrase, remember } = input as Record<string, unknown>
  if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > 1024) {
    throw new Error('Enter your vault passphrase.')
  }
  if (typeof remember !== 'boolean') throw new Error('Choose whether to remember this device.')
  return { passphrase, remember }
}

function requireSecretInput(input: unknown): { projectId: string; name: string; value: string } {
  if (typeof input !== 'object' || input === null) throw new Error('Enter a secret name and value.')
  const { projectId, name, value } = input as Record<string, unknown>
  if (typeof projectId !== 'string') throw new Error('Select a project.')
  if (!isSecretName(name)) {
    throw new Error('Enter a name of 1 to 100 letters, digits, or underscores. Do not start it with a digit.')
  }
  if (!isSecretValue(value)) throw new Error('Enter at most 65,536 characters without a null character. Empty values are allowed.')
  return { projectId, name, value }
}

function requireSecretUpdate(input: unknown): { projectId: string; id: string; value: string } {
  const { projectId, id } = requireSecretReference(input)
  const { value } = input as Record<string, unknown>
  if (!isSecretValue(value)) throw new Error('Enter at most 65,536 characters without a null character. Empty values are allowed.')
  return { projectId, id, value }
}

function requireSecretReference(input: unknown): { projectId: string; id: string } {
  if (typeof input !== 'object' || input === null) throw new Error('Select a secret.')
  const { projectId, id } = input as Record<string, unknown>
  if (typeof projectId !== 'string' || typeof id !== 'string') throw new Error('Select a secret.')
  return { projectId, id }
}

function requireSecret(secrets: StoredSecret[], id: string): StoredSecret {
  const secret = secrets.find((saved) => saved.id === id)
  if (!secret) throw new Error('This secret does not exist. Refresh the list and try again.')
  return secret
}

async function requireDirectory(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Select an existing folder.')
  try {
    const directory = await realpath(path)
    if (!(await stat(directory)).isDirectory()) throw new Error('Not a directory.')
    return directory
  } catch (error) {
    throw new Error('Select an existing folder that global.sct can access.', { cause: error })
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

// rename cannot cross volumes, so a move to another disk copies the vault and then removes the original.
async function moveDirectory(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw new Error('Cannot move the vault folder. Check the folder permissions.', { cause: error })
    }
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    await rm(from, { recursive: true, force: true })
  }
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await mkdir(dirname(filename), { recursive: true })
  await writeFile(`${filename}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(`${filename}.tmp`, filename)
}
