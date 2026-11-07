import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ProjectStore } from '../src/main/projects.ts'

test('projects persist without changes to the selected folder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sct-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const folder = join(root, 'My project')
  await mkdir(folder)
  await writeFile(join(folder, 'keep.txt'), 'unchanged')
  const filename = join(root, 'app-data', 'projects.json')
  const store = new ProjectStore(filename)
  assert.deepEqual(await store.list(), [])
  const project = await store.add({ name: '  My project  ', directory: folder })
  assert.equal(project.name, 'My project')
  assert.deepEqual(await new ProjectStore(filename).list(), [project])
  assert.equal(await readFile(join(folder, 'keep.txt'), 'utf8'), 'unchanged')
})

test('invalid paths, files, and duplicate folders do not change saved projects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sct-validation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filename = join(root, 'projects.json')
  const store = new ProjectStore(filename)
  const project = await store.add({ name: 'Example', directory: root })
  for (const input of [null, {}, { name: '', directory: root }, { name: 'x', directory: './relative' },
    { name: 'x', directory: join(root, 'missing') }, { name: 'x', directory: filename }]) {
    await assert.rejects(store.add(input))
  }
  await assert.rejects(store.add({ name: 'Duplicate', directory: root }), /already/)
  await symlink(root, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(store.add({ name: 'Alias', directory: join(root, 'alias') }), /already/)
  assert.deepEqual(await store.list(), [project])
})

test('concurrent additions preserve both projects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sct-concurrent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = join(root, 'first')
  const second = join(root, 'second')
  await mkdir(first)
  await mkdir(second)
  const store = new ProjectStore(join(root, 'projects.json'))
  const projects = await Promise.all([
    store.add({ name: 'First', directory: first }),
    store.add({ name: 'Second', directory: second })
  ])
  assert.deepEqual(await store.list(), projects)
})

test('invalid saved data remains unchanged after a failed addition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sct-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filename = join(root, 'projects.json')
  const store = new ProjectStore(filename)
  for (const contents of ['broken JSON', '{}', '[{"name":"Missing fields"}]']) {
    await writeFile(filename, contents)
    await assert.rejects(store.list(), /invalid/)
    await assert.rejects(store.add({ name: 'Example', directory: root }), /invalid/)
    assert.equal(await readFile(filename, 'utf8'), contents)
  }
})
