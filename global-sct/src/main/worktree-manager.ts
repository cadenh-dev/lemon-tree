import { execFile, spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AutoCommitResult, DiffFileStat, DiffSummary, EditorId, GitWorktreeMetadata, MergeResult, WorktreeManager, WorktreeRequest
} from '../shared/contracts'

export interface WorktreeManagerOptions {
  worktreesRoot?: string
  launchEditor?: (command: string, args: string[]) => Promise<void>
}

// One path segment and one branch segment. A leading dot or a separator would escape the worktrees root.
const jobIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function createWorktreeManager(options: WorktreeManagerOptions = {}): WorktreeManager {
  const worktreesRoot = options.worktreesRoot ?? join(homedir(), '.global-sct', 'worktrees')
  const launchEditor = options.launchEditor ?? startEditor

  return {
    async create(request: WorktreeRequest): Promise<GitWorktreeMetadata> {
      if (!jobIdPattern.test(request.jobId)) {
        throw new Error(`Invalid jobId "${request.jobId}". Use 1 to 64 letters, digits, dots, underscores, or hyphens, and start with a letter or digit.`)
      }
      if (request.mode === 'in-place') {
        return {
          repoRoot: request.repoRoot,
          worktreePath: request.repoRoot,
          branch: (await runGit(request.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
          baseBranch: request.baseBranch,
          isIsolatedWorktree: false
        }
      }
      const worktreePath = join(worktreesRoot, request.jobId)
      const branch = `agent/${request.jobId}`
      await mkdir(worktreesRoot, { recursive: true })
      await runGit(request.repoRoot, ['worktree', 'add', '-b', branch, worktreePath, request.baseBranch])
      return { repoRoot: request.repoRoot, worktreePath, branch, baseBranch: request.baseBranch, isIsolatedWorktree: true }
    },

    async autoCommit(worktree: GitWorktreeMetadata, message: string): Promise<AutoCommitResult> {
      await runGit(worktree.worktreePath, ['add', '-A'])
      if ((await runGit(worktree.worktreePath, ['status', '--porcelain'])).trim() === '') return { commitHash: null }
      await runGit(worktree.worktreePath, [...(await identityArguments(worktree.worktreePath)), 'commit', '-m', message])
      return { commitHash: (await runGit(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim() }
    },

    async diffSummary(worktree: GitWorktreeMetadata): Promise<DiffSummary> {
      const range = `${worktree.baseBranch}...${worktree.branch}`
      const stats = parseNumstat(await runGit(worktree.worktreePath, ['diff', '--numstat', '-z', range]))
      const files = parseNameStatus(await runGit(worktree.worktreePath, ['diff', '--name-status', '-z', range])).map((entry) => {
        const stat = stats.get(entry.filePath)
        return {
          filePath: entry.filePath,
          additions: stat?.additions ?? 0,
          deletions: stat?.deletions ?? 0,
          status: entry.status,
          binary: stat?.binary ?? false
        }
      })
      return {
        baseBranch: worktree.baseBranch,
        worktreeBranch: worktree.branch,
        commitHash: (await tryGit(worktree.worktreePath, ['rev-parse', '--verify', worktree.branch]))?.trim(),
        totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
        totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
        files
      }
    },

    async merge(worktree: GitWorktreeMetadata): Promise<MergeResult> {
      if (!worktree.isIsolatedWorktree) return { merged: false, conflicts: [], reason: 'Only an isolated worktree can merge.' }
      const currentBranch = (await runGit(worktree.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      if (currentBranch !== worktree.baseBranch) {
        return { merged: false, conflicts: [], reason: `The repository is on ${currentBranch}. Switch it to ${worktree.baseBranch} before the merge.` }
      }
      if ((await runGit(worktree.repoRoot, ['status', '--porcelain'])).trim() !== '') {
        return { merged: false, conflicts: [], reason: 'The repository has uncommitted changes.' }
      }
      try {
        await runGit(worktree.repoRoot, ['merge', '--no-ff', '--no-edit', worktree.branch])
      } catch (error) {
        const conflicts = (await runGit(worktree.repoRoot, ['diff', '--name-only', '--diff-filter=U']))
          .split('\n').map((line) => line.trim()).filter((line) => line !== '')
        // A failed merge can stop before it writes a merge state. Abort only when the state exists.
        if ((await tryGit(worktree.repoRoot, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) !== null) {
          await runGit(worktree.repoRoot, ['merge', '--abort'])
        }
        return { merged: false, conflicts, reason: conflicts.length > 0 ? 'The merge has conflicts.' : `git merge failed: ${errorMessage(error)}` }
      }
      return { merged: true, mergeCommit: (await runGit(worktree.repoRoot, ['rev-parse', 'HEAD'])).trim() }
    },

    async discard(worktree: GitWorktreeMetadata): Promise<void> {
      if (!worktree.isIsolatedWorktree) return
      await runGit(worktree.repoRoot, ['worktree', 'remove', '--force', worktree.worktreePath])
      await runGit(worktree.repoRoot, ['branch', '-D', worktree.branch])
    },

    async openInEditor(worktree: GitWorktreeMetadata, editor: EditorId): Promise<void> {
      await launchEditor(editor, [worktree.worktreePath])
    }
  }
}

// No shell: git receives one argument array element for each value.
function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args)
  } catch {
    return null
  }
}

async function identityArguments(cwd: string): Promise<string[]> {
  const name = await tryGit(cwd, ['config', 'user.name'])
  if (name !== null && name.trim() !== '') return []
  return ['-c', 'user.name=Lemon Tree', '-c', 'user.email=lemon-tree@localhost']
}

function startEditor(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

interface NumstatEntry {
  additions: number
  deletions: number
  binary: boolean
}

interface NameStatusEntry {
  filePath: string
  status: DiffFileStat['status']
}

// -z output: "added TAB deleted TAB path NUL". A rename writes an empty path, then the old and new names.
function parseNumstat(output: string): Map<string, NumstatEntry> {
  const stats = new Map<string, NumstatEntry>()
  const tokens = output.split('\0')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '') continue
    const [added, deleted, inlinePath] = token.split('\t')
    const renamed = inlinePath === ''
    const filePath = renamed ? tokens[index + 2] : inlinePath
    if (renamed) index += 2
    stats.set(filePath, {
      additions: added === '-' ? 0 : Number(added),
      deletions: deleted === '-' ? 0 : Number(deleted),
      binary: added === '-' || deleted === '-'
    })
  }
  return stats
}

// -z output: "code NUL path NUL". A rename writes the code, then the old and new names.
function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = []
  const tokens = output.split('\0')
  for (let index = 0; index < tokens.length; index += 1) {
    const code = tokens[index]
    if (code === '') continue
    const renamed = code.startsWith('R') || code.startsWith('C')
    entries.push({ filePath: renamed ? tokens[index + 2] : tokens[index + 1], status: statusOf(code) })
    index += renamed ? 2 : 1
  }
  return entries
}

function statusOf(code: string): DiffFileStat['status'] {
  if (code.startsWith('A') || code.startsWith('C')) return 'added'
  if (code.startsWith('D')) return 'deleted'
  if (code.startsWith('R')) return 'renamed'
  return 'modified'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
