import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { ProjectStore } from '../src/main/projects.ts'
import { Vault } from '../src/main/vault.ts'
import { InMemorySecretStore } from '../src/main/key-store.ts'
import { launchProject, runProject } from '../src/main/launch.ts'

const passphrase = 'test passphrase for the vault'

// Each test uses a fresh vault folder and an in-memory key store. No OS secret service is necessary.
async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sct-vault-')))
  const store = new InMemorySecretStore()
  const open = async () => {
    const projects = new ProjectStore(join(root, 'app-data', 'projects.json'))
    const vault = new Vault(projects, join(root, 'app-data', 'settings.json'), root, store)
    await vault.start()
    if (vault.isLocked()) await vault.unlock({ passphrase, remember: false })
    // The app runs this after each unlock. It removes secrets whose grant expired while the app was closed.
    await vault.cleanupExpiredGrants()
    return vault
  }
  const folder = async (name: string) => {
    const directory = join(root, 'folders', name)
    await mkdir(directory, { recursive: true })
    return directory
  }
  t.after(async () => {
    const vault = await open()
    for (const project of await new ProjectStore(join(root, 'app-data', 'projects.json')).list()) {
      await vault.deleteProject(project.id).catch(() => undefined)
    }
    await rm(root, { recursive: true, force: true })
  })
  return { root, store, open, folder }
}

test('secrets stay encrypted at rest and renderer operations return only metadata', async (t) => {
  const { root, open, folder } = await setup(t)
  const vault = await open()
  assert.equal(vault.location(), join(root, 'global.sct'))
  const project = await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  assert.ok((await stat(join(root, 'global.sct', 'Demo'))).isDirectory())

  const value = `sk-${randomUUID()}`
  const secret = await vault.addSecret({ projectId: project.id, name: 'OPENAI_API_KEY', value })
  assert.deepEqual(Object.keys(secret).sort(), ['id', 'name', 'projectId'])
  const file = await readFile(join(root, 'global.sct', 'Demo', 'secrets.sct'))
  assert.equal(file.subarray(0, 4).toString(), 'SCT2')
  assert.ok(!file.includes(value) && !file.includes('OPENAI_API_KEY'))

  const header = JSON.parse(await readFile(join(root, 'global.sct', 'vault.json'), 'utf8')) as Record<string, unknown>
  assert.equal(header.version, 1)
  assert.ok(!JSON.stringify(header).includes(passphrase))

  assert.deepEqual(await (await open()).listSecrets(), [secret])
  await (await open()).withSecret(secret, (plaintext) => assert.equal(plaintext.toString('utf8'), value))
  await vault.updateSecret({ projectId: project.id, id: secret.id, value: `${value}-new` })
  assert.notDeepEqual(await readFile(join(root, 'global.sct', 'Demo', 'secrets.sct')), file)
  assert.deepEqual(await vault.listSecrets(), [secret])
  await (await open()).withSecret(secret, (plaintext) => assert.equal(plaintext.toString('utf8'), `${value}-new`))

  await vault.deleteSecret({ projectId: project.id, id: secret.id })
  assert.deepEqual(await vault.listSecrets(), [])
  await assert.rejects(vault.withSecret(secret, () => assert.fail('A deleted secret must not reach the consumer.')), /does not exist/)
})

test('a locked vault refuses every secret operation', async (t) => {
  const { root, store, folder } = await setup(t)
  const unlocked = await (async () => {
    const projects = new ProjectStore(join(root, 'app-data', 'projects.json'))
    const vault = new Vault(projects, join(root, 'app-data', 'settings.json'), root, store)
    await vault.start()
    await vault.unlock({ passphrase, remember: false })
    return vault
  })()
  const project = await unlocked.addProject({ name: 'Demo', directory: await folder('demo') })
  await unlocked.addSecret({ projectId: project.id, name: 'TOKEN', value: 'value' })

  const locked = new Vault(new ProjectStore(join(root, 'app-data', 'projects.json')),
    join(root, 'app-data', 'settings.json'), root, new InMemorySecretStore())
  await locked.start()
  assert.equal(locked.isLocked(), true)
  await assert.rejects(locked.listSecrets(), /locked/)
  await assert.rejects(locked.addSecret({ projectId: project.id, name: 'OTHER', value: 'x' }), /locked/)
})

test('internal values survive concurrent writes from two vault processes', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sct-internal-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new InMemorySecretStore()
  const open = async () => {
    const vault = new Vault(new ProjectStore(join(root, 'app-data', 'projects.json')),
      join(root, 'app-data', 'settings.json'), root, store)
    await vault.start()
    if (vault.isLocked()) await vault.unlock({ passphrase, remember: false })
    return vault
  }
  const left = await open()
  const right = await open()
  for (let index = 0; index < 25; index += 1) {
    await Promise.all([
      left.writeInternal('sharing/identity', Buffer.from(`identity-${index}`)),
      right.writeInternal('relay/token/abc', Buffer.from(`token-${index}`))
    ])
  }
  assert.equal((await left.readInternal('sharing/identity'))?.toString(), 'identity-24')
  assert.equal((await right.readInternal('sharing/identity'))?.toString(), 'identity-24')
  assert.equal((await left.readInternal('relay/token/abc'))?.toString(), 'token-24')
  assert.equal((await right.readInternal('relay/token/abc'))?.toString(), 'token-24')

  const [first, second] = await Promise.all([
    left.writeInternalIfAbsent('sharing/first', Buffer.from('left')),
    right.writeInternalIfAbsent('sharing/first', Buffer.from('right'))
  ])
  assert.equal([first, second].filter((value) => value === null).length, 1)
  const existing = first ?? second
  assert.ok(existing)
  try { assert.ok(['left', 'right'].includes(existing.toString())) } finally { existing.fill(0) }

  const files = await readdir(join(root, 'global.sct', '.internal'))
  assert.equal(files.length, 3)
  assert.ok(files.every((name) => /^[0-9a-f]{64}\.sct$/.test(name)))
  for (const name of files) {
    const contents = await readFile(join(root, 'global.sct', '.internal', name))
    assert.equal(contents.subarray(0, 4).toString(), 'SCI2')
    assert.ok(!contents.includes('identity-') && !contents.includes('token-'))
  }

  const identityFile = join(root, 'global.sct', '.internal',
    `${createHash('sha256').update('sharing/identity').digest('hex')}.sct`)
  await writeFile(identityFile, 'broken')
  await assert.rejects(left.readInternal('sharing/identity'), /internal secret file is invalid/)
})

test('a wrong passphrase does not open the vault', async (t) => {
  const { root, store } = await setup(t)
  const first = new Vault(new ProjectStore(join(root, 'app-data', 'projects.json')),
    join(root, 'app-data', 'settings.json'), root, store)
  await first.start()
  await first.unlock({ passphrase, remember: false })

  const second = new Vault(new ProjectStore(join(root, 'app-data', 'projects.json')),
    join(root, 'app-data', 'settings.json'), root, new InMemorySecretStore())
  await second.start()
  await assert.rejects(second.unlock({ passphrase: 'this is not the passphrase', remember: false }), /not correct/)
  assert.equal(second.isLocked(), true)
  await second.unlock({ passphrase, remember: false })
  assert.equal(second.isLocked(), false)
})

test('remember this device unlocks without the passphrase when the store keeps the key', async (t) => {
  const { root, store } = await setup(t)
  const first = new Vault(new ProjectStore(join(root, 'app-data', 'projects.json')),
    join(root, 'app-data', 'settings.json'), root, store)
  await first.start()
  const status = await first.unlock({ passphrase, remember: true })
  assert.equal(status.rememberEnabled, true)

  const second = new Vault(new ProjectStore(join(root, 'app-data', 'projects.json')),
    join(root, 'app-data', 'settings.json'), root, store)
  await second.start()
  assert.equal(await second.unlockWithRememberedKey(), true)
  assert.equal(second.isLocked(), false)

  await second.forget()
  const third = new Vault(new ProjectStore(join(root, 'app-data', 'projects.json')),
    join(root, 'app-data', 'settings.json'), root, store)
  await third.start()
  assert.equal(await third.unlockWithRememberedKey(), false)
})

test('internal reads clear plaintext after asynchronous success and failure', async (t) => {
  const { open, folder } = await setup(t)
  const vault = await open()
  const project = await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  const value = ' spaces "quotes" $dollars = equals\nnext line 🔑'
  const secret = await vault.addSecret({ projectId: project.id, name: 'TOKEN', value })
  let plaintext: Buffer | undefined

  assert.equal(await vault.withSecret(secret, async (buffer) => {
    plaintext = buffer
    await Promise.resolve()
    assert.equal(buffer.toString('utf8'), value)
    return 'consumed'
  }), 'consumed')
  assert.ok(plaintext)
  assert.deepEqual(plaintext, Buffer.alloc(Buffer.byteLength(value)))

  await assert.rejects(vault.withSecret(secret, async (buffer) => {
    plaintext = buffer
    await Promise.resolve()
    assert.equal(buffer.toString('utf8'), value)
    throw new Error('Consumer failed.')
  }), /Consumer failed/)
  assert.deepEqual(plaintext, Buffer.alloc(Buffer.byteLength(value)))
  await assert.rejects(vault.withSecret(secret, (buffer) => {
    plaintext = buffer
    throw new Error('Synchronous consumer failed.')
  }), /Synchronous consumer failed/)
  assert.deepEqual(plaintext, Buffer.alloc(Buffer.byteLength(value)))
  await vault.withSecret(secret, (buffer) => assert.equal(buffer.toString('utf8'), value))
})

test('an expired received grant blocks new secret access and cleanup forgets the secret', async (t) => {
  const { root, open, folder } = await setup(t)
  const vault = await open()
  const project = await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  const [secret] = await vault.importSecrets(project.id, [{ name: 'TOKEN', value: 'received value' }],
    'relay:expired', async () => undefined, { accessExpiresAt: Date.now() - 1, injectionOnly: true })
  assert.ok(secret)
  await assert.rejects(vault.withSecret(secret, () => assert.fail('An expired value must not reach the consumer.')), /expired access grant/)
  await assert.rejects(vault.withSelectedSecrets(project.id, [secret.id], () => undefined), /expired access grant/)
  await assert.rejects(vault.withProjectEnvironment(project.id, () => undefined), /expired access grant/)
  const outcomes = await vault.cleanupExpiredGrants()
  assert.deepEqual(outcomes.map(({ transferId, status }) => ({ transferId, status })),
    [{ transferId: 'relay:expired', status: 'removed' }])
  assert.deepEqual(await vault.listSecrets(), [])
  const history = await readFile(join(root, 'app-data', 'grant-cleanup.sct'))
  assert.equal(history.subarray(0, 4).toString(), 'SCG2')
  assert.ok(!history.includes('TOKEN') && !history.includes('received value') && !history.includes('relay:expired'))
  assert.deepEqual(await (await open()).grantCleanupOutcomes(), outcomes)
  const [restartSecret] = await vault.importSecrets(project.id, [{ name: 'RESTART_TOKEN', value: 'restart value' }],
    'relay:restart', async () => undefined, { accessExpiresAt: Date.now() - 1, injectionOnly: true })
  assert.ok(restartSecret)
  assert.deepEqual(await (await open()).listSecrets(), [])
})

test('internal reads reject invalid references and other projects', async (t) => {
  const { root, open, folder } = await setup(t)
  const vault = await open()
  const project = await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  const other = await vault.addProject({ name: 'Other', directory: await folder('other') })
  const secret = await vault.addSecret({ projectId: project.id, name: 'TOKEN', value: 'private value' })
  const contents = await readFile(join(root, 'global.sct', project.name, 'secrets.sct'))
  const rejectConsumer = () => assert.fail('An invalid read must not reach the consumer.')
  for (const input of [null, {}, { projectId: project.id }, { ...secret, projectId: 'missing' },
    { ...secret, projectId: other.id }, { ...secret, id: 'missing' }]) {
    await assert.rejects(vault.withSecret(input, rejectConsumer))
  }
  await vault.withSecret(secret, (buffer) => assert.equal(buffer.toString('utf8'), 'private value'))
  assert.deepEqual(await readFile(join(root, 'global.sct', project.name, 'secrets.sct')), contents)
})

test('invalid secrets and duplicate names do not change the vault', async (t) => {
  const { open, folder } = await setup(t)
  const vault = await open()
  const project = await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  const secret = await vault.addSecret({ projectId: project.id, name: 'TOKEN', value: 'one' })
  await assert.rejects(vault.addSecret({ projectId: project.id, name: 'TOKEN', value: 'two' }), /already exists/)
  for (const input of [null, {}, { projectId: project.id, name: '1TOKEN', value: 'x' },
    { projectId: project.id, name: 'BAD-NAME', value: 'x' }, { projectId: project.id, name: 'NULL', value: 'bad\0value' },
    { projectId: 'missing', name: 'OTHER', value: 'x' }]) {
    await assert.rejects(vault.addSecret(input))
  }
  await assert.rejects(vault.updateSecret({ projectId: project.id, id: 'missing', value: 'x' }), /does not exist/)
  assert.deepEqual(await vault.listSecrets(), [secret])
})

test('project launches preserve literal values before imports and keep the parent environment unchanged', async (t) => {
  const { open, folder } = await setup(t)
  const vault = await open()
  const project = await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  const other = await vault.addProject({ name: 'Other', directory: await folder('other') })
  const value = ` spaces "quotes" $dollars = equals\nnext line 🔑 ${randomUUID()}`
  await vault.addSecret({ projectId: project.id, name: 'SCT_TOKEN', value })
  await vault.addSecret({ projectId: project.id, name: 'SHELL', value: 'project-shell' })
  await vault.addSecret({ projectId: project.id, name: 'EMPTY', value: '' })
  await vault.addSecret({ projectId: other.id, name: 'SCT_OTHER_PROJECT', value: randomUUID() })
  await writeFile(join(project.directory, 'preload.cjs'), `
    const assert = require('node:assert/strict')
    assert.equal(require('node:crypto').createHash('sha256').update(process.env.SCT_TOKEN).digest('hex'), process.argv[2])
    assert.equal(process.env.EMPTY, '')
    assert.equal(process.env.SHELL, 'project-shell')
    assert.equal(process.env.SCT_OTHER_PROJECT, undefined)
    assert.equal(process.env.PATH, process.argv[3])
    assert.equal(process.cwd(), process.argv[4])
    assert.deepEqual(require('node:fs').readdirSync('.').sort(), ['check.cjs', 'preload.cjs'])
  `)
  await writeFile(join(project.directory, 'check.cjs'), `
    process.stdin.on('data', (data) => { process.stdout.write(data); process.stderr.write('stderr-ok') })
  `)
  const parent = { ...process.env }
  const child = await launchProject(vault, project.id, 'node', ['-r', './preload.cjs', './check.cjs',
    createHash('sha256').update(value).digest('hex'), process.env.PATH ?? '', project.directory], 'pipe')
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', (data: Buffer) => stdout.push(data))
  child.stderr?.on('data', (data: Buffer) => stderr.push(data))
  child.stdin?.end('stdin-ok')
  assert.equal(await new Promise((resolve) => child.once('close', resolve)), 0, Buffer.concat(stderr).toString())
  assert.equal(Buffer.concat(stdout).toString(), 'stdin-ok')
  assert.equal(Buffer.concat(stderr).toString(), 'stderr-ok')
  assert.ok(!child.spawnargs.join(' ').includes(value))
  assert.deepEqual(process.env, parent)
  assert.deepEqual((await readdir(project.directory)).sort(), ['check.cjs', 'preload.cjs'])
})

test('launches resolve renamed projects and moved storage, and preserve command exit status', async (t) => {
  const { root, open, folder } = await setup(t)
  const vault = await open()
  const project = await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  await vault.addSecret({ projectId: project.id, name: 'EMPTY', value: '' })
  await vault.renameProject({ id: project.id, name: 'Renamed' })
  await vault.moveTo(await folder('new-root'))
  const projects = new ProjectStore(join(root, 'app-data', 'projects.json'))
  assert.equal(await runProject(projects, await open(), ['run', 'Renamed', '--', 'node', '-e',
    "require('node:assert/strict').equal(process.env.EMPTY, ''); process.exit(23)"]), 23)
  assert.equal(await runProject(projects, await open(), ['run', 'Renamed', '--', 'node', '-e',
    "process.kill(process.pid, 'SIGTERM')"]), process.platform === 'win32' ? 1 : 143)
  await assert.rejects(runProject(projects, vault, ['run', 'Demo', '--', 'node']), /not in your project list/)
  await assert.rejects(runProject(projects, vault, ['run', 'Renamed']), /Usage:/)
})

test('launches fail before execution when the vault, command, or source folder is missing', async (t) => {
  const { root, open, folder } = await setup(t)
  const vault = await open()
  const project = await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  const marker = join(root, 'must-not-exist')
  const commandArgs = ['-e', "require('node:fs').writeFileSync(process.argv[1], 'launched')", marker]
  await assert.rejects(launchProject(vault, project.id, 'node', commandArgs), /Cannot read the secrets/)
  await assert.rejects(launchProject(vault, 'missing', 'node', commandArgs), /not in your project list/)
  await vault.addSecret({ projectId: project.id, name: 'TOKEN', value: randomUUID() })
  await assert.rejects(launchProject(vault, project.id, 'sct-command-that-does-not-exist', []), /Cannot start the command/)
  await rm(project.directory, { recursive: true })
  await assert.rejects(launchProject(vault, project.id, 'node', commandArgs), /Cannot start the command/)
  await assert.rejects(stat(marker), { code: 'ENOENT' })
})

test('the terminal entrypoint forwards interruption and termination to the command', { timeout: 15_000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows cannot forward POSIX signals to a child process.')
    return
  }
  const { root, open, folder } = await setup(t)
  const vault = await open()
  const project = await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  await vault.addSecret({ projectId: project.id, name: 'TOKEN', value: randomUUID() })
  await writeFile(join(root, 'terminal.ts'), `
    import { ProjectStore } from ${JSON.stringify(join(__dirname, '../src/main/projects.ts'))}
    import { Vault } from ${JSON.stringify(join(__dirname, '../src/main/vault.ts'))}
    import { InMemorySecretStore } from ${JSON.stringify(join(__dirname, '../src/main/key-store.ts'))}
    import { runProject } from ${JSON.stringify(join(__dirname, '../src/main/launch.ts'))}
    import { join } from 'node:path'
    const projects = new ProjectStore(join(process.argv[2], 'app-data', 'projects.json'))
    const vault = new Vault(projects, join(process.argv[2], 'app-data', 'settings.json'), process.argv[2], new InMemorySecretStore())
    await vault.start()
    await vault.unlock({ passphrase: ${JSON.stringify(passphrase)}, remember: false })
    process.exit(await runProject(projects, vault, ['run', 'Demo', '--', 'node', '-e',
      "process.on(process.argv[1], () => process.exit(37)); console.log('ready'); setInterval(() => {}, 1000)", process.argv[3]]))
  `)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const terminal = spawn(process.execPath, [join(root, 'terminal.ts'), root, signal], { stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { terminal.kill('SIGKILL') })
    const exit = new Promise((resolve, reject) => { terminal.once('close', resolve); terminal.once('error', reject) })
    await new Promise<void>((resolve, reject) => {
      terminal.stdout.once('data', () => resolve())
      terminal.once('error', reject)
      terminal.once('close', () => reject(new Error('The command exited before readiness.')))
    })
    terminal.kill(signal)
    assert.equal(await exit, 37)
  }
})

test('project names cannot leave the vault folder or repeat', async (t) => {
  const { root, open, folder } = await setup(t)
  const vault = await open()
  for (const name of ['..', '.', '.hidden', '../outside', 'a/b', 'a\\b', 'a:b']) {
    await assert.rejects(vault.addProject({ name, directory: await folder('traversal') }))
  }
  await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  await assert.rejects(vault.addProject({ name: 'demo', directory: await folder('other') }), /already exists/)
  assert.deepEqual((await readdir(join(root, 'global.sct'))).sort(), ['Demo', 'vault.json'])
  assert.deepEqual((await readdir(root)).sort(), ['app-data', 'folders', 'global.sct'])
})

test('renaming a project moves its secrets, and deleting it removes its files', async (t) => {
  const { root, open, folder } = await setup(t)
  const vault = await open()
  const directory = await folder('demo')
  const project = await vault.addProject({ name: 'Demo', directory })
  const secret = await vault.addSecret({ projectId: project.id, name: 'TOKEN', value: 'value' })

  await vault.renameProject({ id: project.id, name: 'Renamed' })
  assert.deepEqual((await readdir(join(root, 'global.sct'))).sort(), ['Renamed', 'vault.json'])
  assert.deepEqual(await vault.listSecrets(), [secret])
  await (await open()).withSecret(secret, (buffer) => assert.equal(buffer.toString('utf8'), 'value'))

  await mkdir(join(root, 'global.sct', 'Taken', 'unrelated'), { recursive: true })
  await assert.rejects(vault.renameProject({ id: project.id, name: 'Taken' }), /already contains a folder named Taken/)
  await rm(join(root, 'global.sct', 'Taken'), { recursive: true })
  await vault.renameProject({ id: project.id, name: 'renamed' })
  assert.deepEqual((await readdir(join(root, 'global.sct'))).sort(), ['renamed', 'vault.json'])
  assert.deepEqual(await vault.listSecrets(), [secret])

  await vault.deleteProject(project.id)
  assert.deepEqual((await readdir(join(root, 'global.sct'))).sort(), ['vault.json'])
  assert.ok((await stat(directory)).isDirectory())
})

test('startup creates folders for existing projects and skips names that are not valid folder names', async (t) => {
  const { root, open, folder } = await setup(t)
  await mkdir(join(root, 'app-data'))
  await writeFile(join(root, 'app-data', 'projects.json'), JSON.stringify([
    { id: 'existing', name: 'Existing', directory: await folder('existing') },
    { id: 'older', name: 'older/name', directory: await folder('older') }
  ]))
  await open()
  assert.deepEqual((await readdir(join(root, 'global.sct'))).sort(), ['Existing', 'vault.json'])
})

test('a secrets file copied into a different project does not open', async (t) => {
  const { root, open, folder } = await setup(t)
  const vault = await open()
  const first = await vault.addProject({ name: 'First', directory: await folder('first') })
  const second = await vault.addProject({ name: 'Second', directory: await folder('second') })
  await vault.addSecret({ projectId: first.id, name: 'TOKEN', value: 'value' })
  const other = await vault.addSecret({ projectId: second.id, name: 'OTHER', value: 'value' })
  await copyFile(join(root, 'global.sct', 'First', 'secrets.sct'), join(root, 'global.sct', 'Second', 'secrets.sct'))
  await assert.rejects(vault.listSecrets(), /different project/)
  await assert.rejects(vault.withSecret(other, () => assert.fail('A copied vault must not open.')), /different project/)
})

test('moving the storage location moves the vault and persists after restart', async (t) => {
  const { root, open, folder } = await setup(t)
  const vault = await open()
  const project = await vault.addProject({ name: 'Demo', directory: await folder('demo') })
  const secret = await vault.addSecret({ projectId: project.id, name: 'TOKEN', value: 'value' })
  const target = await folder('new-root')

  assert.equal(await vault.moveTo(target), join(target, 'global.sct'))
  await assert.rejects(stat(join(root, 'global.sct')))
  const restarted = await open()
  assert.equal(restarted.location(), join(target, 'global.sct'))
  assert.deepEqual(await restarted.listSecrets(), [secret])
  await restarted.withSecret(secret, (buffer) => assert.equal(buffer.toString('utf8'), 'value'))

  await mkdir(join(root, 'occupied', 'global.sct'), { recursive: true })
  await assert.rejects(restarted.moveTo(join(root, 'occupied')), /already contains/)
  await assert.rejects(restarted.moveTo(join(target, 'global.sct', 'Demo')), /outside/)
  assert.equal(restarted.location(), join(target, 'global.sct'))
})
