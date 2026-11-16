import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktreeManager } from '../src/main/worktree-manager.ts'

interface TestRepos {
  repo: string
  worktreesRoot: string
}

test('create with mode isolated makes the worktree directory on branch agent/<jobId> from the base branch', async () => {
  await withRepos(async ({ repo, worktreesRoot }) => {
    const manager = createWorktreeManager({ worktreesRoot })
    const metadata = await manager.create({ jobId: 'job-1', repoRoot: repo, baseBranch: 'main', mode: 'isolated' })
    assert.deepEqual(metadata, {
      repoRoot: repo,
      worktreePath: join(worktreesRoot, 'job-1'),
      branch: 'agent/job-1',
      baseBranch: 'main',
      isIsolatedWorktree: true
    })
    assert.equal(await readFile(join(metadata.worktreePath, 'seed.txt'), 'utf8'), 'seed\n')
    assert.equal((await git(metadata.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'agent/job-1')
    assert.equal(
      (await git(metadata.worktreePath, ['rev-parse', 'HEAD'])).trim(),
      (await git(repo, ['rev-parse', 'main'])).trim()
    )
  })
})

test('create with mode in-place makes no worktree and returns the repository root and its current branch', async () => {
  await withRepos(async ({ repo, worktreesRoot }) => {
    const manager = createWorktreeManager({ worktreesRoot })
    const metadata = await manager.create({ jobId: 'job-2', repoRoot: repo, baseBranch: 'main', mode: 'in-place' })
    assert.deepEqual(metadata, {
      repoRoot: repo,
      worktreePath: repo,
      branch: 'main',
      baseBranch: 'main',
      isIsolatedWorktree: false
    })
    assert.equal(existsSync(worktreesRoot), false)
    assert.deepEqual(lines(await git(repo, ['branch', '--list', 'agent/*'])), [])
    // discard must leave an in-place repository in place.
    await manager.discard(metadata)
    assert.equal(existsSync(join(repo, 'seed.txt')), true)
  })
})

test('create rejects a jobId with a path separator or .. and makes no directory', async () => {
  await withRepos(async ({ repo, worktreesRoot }) => {
    const manager = createWorktreeManager({ worktreesRoot })
    for (const jobId of ['../escape', 'a/b', '..', 'bad id', '']) {
      await assert.rejects(
        () => manager.create({ jobId, repoRoot: repo, baseBranch: 'main', mode: 'isolated' }),
        /Invalid jobId/
      )
    }
    assert.equal(existsSync(worktreesRoot), false)
    assert.deepEqual(lines(await git(repo, ['branch', '--list', 'agent/*'])), [])
  })
})

test('autoCommit commits a new file and a changed file, and a second call with no change returns null', async () => {
  await withRepos(async ({ repo, worktreesRoot }) => {
    const manager = createWorktreeManager({ worktreesRoot })
    const metadata = await manager.create({ jobId: 'commit-job', repoRoot: repo, baseBranch: 'main', mode: 'isolated' })
    await writeFile(join(metadata.worktreePath, 'added.txt'), 'one\ntwo\n')
    await writeFile(join(metadata.worktreePath, 'seed.txt'), 'changed seed\n')
    const committed = await manager.autoCommit(metadata, 'job changes')
    assert.equal(typeof committed.commitHash, 'string')
    assert.equal((await git(metadata.worktreePath, ['rev-parse', 'HEAD'])).trim(), committed.commitHash)
    assert.equal((await git(metadata.worktreePath, ['log', '-1', '--format=%s'])).trim(), 'job changes')
    assert.deepEqual(lines(await git(metadata.worktreePath, ['show', '--name-only', '--format=', 'HEAD'])), ['added.txt', 'seed.txt'])
    assert.deepEqual(await manager.autoCommit(metadata, 'no changes'), { commitHash: null })
  })
})

test('diffSummary reports added, modified, deleted, and binary files with correct lines and totals', async () => {
  await withRepos(async ({ repo, worktreesRoot }) => {
    await writeFile(join(repo, 'gone.txt'), 'a\nb\nc\n')
    await commitAll(repo, 'add gone.txt')
    const manager = createWorktreeManager({ worktreesRoot })
    const metadata = await manager.create({ jobId: 'diff-job', repoRoot: repo, baseBranch: 'main', mode: 'isolated' })
    await writeFile(join(metadata.worktreePath, 'created.txt'), 'one\ntwo\nthree\n')
    await writeFile(join(metadata.worktreePath, 'seed.txt'), 'changed seed\n')
    await writeFile(join(metadata.worktreePath, 'image.bin'), Buffer.from([0, 1, 2, 0, 255]))
    await rm(join(metadata.worktreePath, 'gone.txt'))
    const committed = await manager.autoCommit(metadata, 'diff work')
    const summary = await manager.diffSummary(metadata)
    assert.equal(summary.baseBranch, 'main')
    assert.equal(summary.worktreeBranch, 'agent/diff-job')
    assert.equal(summary.commitHash, committed.commitHash)
    assert.equal(summary.totalAdditions, 4)
    assert.equal(summary.totalDeletions, 4)
    assert.deepEqual(
      summary.files.sort((left, right) => left.filePath.localeCompare(right.filePath)),
      [
        { filePath: 'created.txt', additions: 3, deletions: 0, status: 'added', binary: false },
        { filePath: 'gone.txt', additions: 0, deletions: 3, status: 'deleted', binary: false },
        { filePath: 'image.bin', additions: 0, deletions: 0, status: 'added', binary: true },
        { filePath: 'seed.txt', additions: 1, deletions: 1, status: 'modified', binary: false }
      ]
    )
  })
})

test('merge of a clean change gives merged true and the base branch contains the file', async () => {
  await withRepos(async ({ repo, worktreesRoot }) => {
    const manager = createWorktreeManager({ worktreesRoot })
    const metadata = await manager.create({ jobId: 'merge-job', repoRoot: repo, baseBranch: 'main', mode: 'isolated' })
    await writeFile(join(metadata.worktreePath, 'merged.txt'), 'merged\n')
    await manager.autoCommit(metadata, 'merge work')
    const result = await manager.merge(metadata)
    assert.equal(result.merged, true)
    if (result.merged) assert.equal(result.mergeCommit, (await git(repo, ['rev-parse', 'HEAD'])).trim())
    assert.equal(await readFile(join(repo, 'merged.txt'), 'utf8'), 'merged\n')
    assert.equal((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main')
    // --no-ff makes a merge commit with two parents: the commit itself, then both parents.
    assert.equal((await git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length, 3)
  })
})

test('merge with a conflict gives merged false with the conflicted path, and leaves no merge in progress', async () => {
  await withRepos(async ({ repo, worktreesRoot }) => {
    const manager = createWorktreeManager({ worktreesRoot })
    const metadata = await manager.create({ jobId: 'conflict-job', repoRoot: repo, baseBranch: 'main', mode: 'isolated' })
    await writeFile(join(metadata.worktreePath, 'seed.txt'), 'worktree side\n')
    await manager.autoCommit(metadata, 'worktree change')
    await writeFile(join(repo, 'seed.txt'), 'main side\n')
    await commitAll(repo, 'main change')
    const result = await manager.merge(metadata)
    assert.equal(result.merged, false)
    if (!result.merged) {
      assert.deepEqual(result.conflicts, ['seed.txt'])
      assert.match(result.reason, /conflicts/)
    }
    assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false)
    assert.deepEqual(lines(await git(repo, ['status', '--porcelain'])), [])
    assert.equal(await readFile(join(repo, 'seed.txt'), 'utf8'), 'main side\n')
  })
})

test('merge is refused when the repository root is on another branch', async () => {
  await withRepos(async ({ repo, worktreesRoot }) => {
    const manager = createWorktreeManager({ worktreesRoot })
    const metadata = await manager.create({ jobId: 'branch-job', repoRoot: repo, baseBranch: 'main', mode: 'isolated' })
    await writeFile(join(metadata.worktreePath, 'feature.txt'), 'feature\n')
    await manager.autoCommit(metadata, 'feature work')
    // The temporary repository changes branch only to test the refusal path.
    await git(repo, ['checkout', '-b', 'topic'])
    const result = await manager.merge(metadata)
    assert.equal(result.merged, false)
    if (!result.merged) {
      assert.deepEqual(result.conflicts, [])
      assert.match(result.reason, /main/)
    }
    assert.equal((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'topic')
    assert.equal(existsSync(join(repo, 'feature.txt')), false)
    assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false)
  })
})

test('discard removes the worktree directory and the agent branch', async () => {
  await withRepos(async ({ repo, worktreesRoot }) => {
    const manager = createWorktreeManager({ worktreesRoot })
    const metadata = await manager.create({ jobId: 'discard-job', repoRoot: repo, baseBranch: 'main', mode: 'isolated' })
    await writeFile(join(metadata.worktreePath, 'dirty.txt'), 'uncommitted\n')
    await manager.discard(metadata)
    assert.equal(existsSync(metadata.worktreePath), false)
    assert.deepEqual(lines(await git(repo, ['branch', '--list', 'agent/*'])), [])
    assert.equal(lines(await git(repo, ['worktree', 'list'])).length, 1)
  })
})

test('openInEditor calls the launcher with the editor command and the worktree path', async () => {
  await withRepos(async ({ repo, worktreesRoot }) => {
    const calls: Array<{ command: string; args: string[] }> = []
    const manager = createWorktreeManager({
      worktreesRoot,
      launchEditor: async (command, args) => {
        calls.push({ command, args })
      }
    })
    const metadata = await manager.create({ jobId: 'editor-job', repoRoot: repo, baseBranch: 'main', mode: 'isolated' })
    for (const editor of ['code', 'cursor', 'zed'] as const) await manager.openInEditor(metadata, editor)
    assert.deepEqual(calls, [
      { command: 'code', args: [metadata.worktreePath] },
      { command: 'cursor', args: [metadata.worktreePath] },
      { command: 'zed', args: [metadata.worktreePath] }
    ])
  })
})

// Each test gets a real repository and an empty worktrees root. The base directory is removed after the test.
async function withRepos(body: (repos: TestRepos) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'lemon-worktree-'))
  const repo = join(base, 'repo')
  await mkdir(repo)
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.name', 'Test User'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await writeFile(join(repo, 'seed.txt'), 'seed\n')
  await commitAll(repo, 'seed commit')
  try {
    await body({ repo, worktreesRoot: join(base, 'worktrees') })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', message])
}

function lines(output: string): string[] {
  return output.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}
