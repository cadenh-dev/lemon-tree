import { deepStrictEqual, ok } from 'node:assert'
import { test } from 'node:test'
import { listAgentTrees, resolveGitWorktree, ROLE_ORDER, roleCatalog } from 'agtop'

test('agtop resolves worktree metadata and process role catalog', async () => {
  ok(resolveGitWorktree(process.cwd()))
  const trees = await listAgentTrees()
  ok(Array.isArray(trees))
  ok(trees.every(tree => tree.processes.every(process => ROLE_ORDER.includes(process.role))))
  deepStrictEqual(roleCatalog().map(entry => entry.role), [...ROLE_ORDER])
})
