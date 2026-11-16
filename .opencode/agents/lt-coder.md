---
description: Bounded Lemon Tree coding worker. One FEAT ticket, one worktree.
mode: primary
model: opencode-go/deepseek-v4.1-flash#high
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: "read"
    resource: "*"
    effect: allow
  - action: "read"
    resource: "*.env"
    effect: deny
  - action: "read"
    resource: "*.env.*"
    effect: deny
  - action: "glob"
    resource: "*"
    effect: allow
  - action: "grep"
    resource: "*"
    effect: allow
  - action: "edit"
    resource: "*"
    effect: allow
  - action: "edit"
    resource: "global-sct/src/shared/contracts.ts"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/src/shared/contracts.ts"
    effect: deny
  - action: "edit"
    resource: "global-sct/src/shared/acp-types.ts"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/src/shared/acp-types.ts"
    effect: deny
  - action: "edit"
    resource: "global-sct/src/shared/ipc-channels.ts"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/src/shared/ipc-channels.ts"
    effect: deny
  - action: "edit"
    resource: "global-sct/src/shared/harness-manifest.ts"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/src/shared/harness-manifest.ts"
    effect: deny
  - action: "edit"
    resource: "global-sct/harnesses.json"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/harnesses.json"
    effect: deny
  - action: "edit"
    resource: "global-sct/package.json"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/package.json"
    effect: deny
  - action: "edit"
    resource: "global-sct/bun.lock"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/bun.lock"
    effect: deny
  - action: "edit"
    resource: "global-sct/tsconfig*.json"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/tsconfig*.json"
    effect: deny
  - action: "edit"
    resource: "global-sct/src/main/agtop-type-check.ts"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/src/main/agtop-type-check.ts"
    effect: deny
  - action: "edit"
    resource: "global-sct/src/shared/boundary.ts"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/src/shared/boundary.ts"
    effect: deny
  - action: "edit"
    resource: "global-sct/src/shared/boundary-schemas.ts"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/src/shared/boundary-schemas.ts"
    effect: deny
  - action: "edit"
    resource: "global-sct/eslint.config.mjs"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/eslint.config.mjs"
    effect: deny
  - action: "edit"
    resource: "global-sct/AGENTS.md"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/AGENTS.md"
    effect: deny
  - action: "edit"
    resource: "AGENTS.md"
    effect: deny
  - action: "edit"
    resource: "*/AGENTS.md"
    effect: deny
  - action: "edit"
    resource: "pins.json"
    effect: deny
  - action: "edit"
    resource: "*/pins.json"
    effect: deny
  - action: "edit"
    resource: "pins.lock.json"
    effect: deny
  - action: "edit"
    resource: "*/pins.lock.json"
    effect: deny
  - action: "edit"
    resource: "scripts/*"
    effect: deny
  - action: "edit"
    resource: "*/scripts/*"
    effect: deny
  - action: "edit"
    resource: "package.json"
    effect: deny
  - action: "edit"
    resource: "*/package.json"
    effect: deny
  - action: "edit"
    resource: "agtop/*"
    effect: deny
  - action: "edit"
    resource: "*/agtop/*"
    effect: deny
  - action: "edit"
    resource: "subagentclassifiertoolkit/*"
    effect: deny
  - action: "edit"
    resource: "*/subagentclassifiertoolkit/*"
    effect: deny
  - action: "edit"
    resource: "global-sct/.agents/*"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/.agents/*"
    effect: deny
  - action: "edit"
    resource: ".github/*"
    effect: deny
  - action: "edit"
    resource: "*/.github/*"
    effect: deny
  - action: "edit"
    resource: "global-sct/.github/*"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/.github/*"
    effect: deny
  - action: "edit"
    resource: "global-sct/.opencode/*"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/.opencode/*"
    effect: deny
  - action: "edit"
    resource: "global-sct/opencode.json"
    effect: deny
  - action: "edit"
    resource: "*/global-sct/opencode.json"
    effect: deny
  - action: "edit"
    resource: "docs/*"
    effect: deny
  - action: "edit"
    resource: "*/docs/*"
    effect: deny
  - action: "edit"
    resource: ".opencode/*"
    effect: deny
  - action: "edit"
    resource: "*/.opencode/*"
    effect: deny
  - action: "edit"
    resource: "opencode.json"
    effect: deny
  - action: "edit"
    resource: "*/opencode.json"
    effect: deny
  - action: "shell"
    resource: "bun run typecheck *"
    effect: allow
  - action: "shell"
    resource: "bun run typecheck:tsc *"
    effect: allow
  - action: "shell"
    resource: "bun run lint *"
    effect: allow
  - action: "shell"
    resource: "bun run check *"
    effect: allow
  - action: "shell"
    resource: "bun run test *"
    effect: allow
  - action: "shell"
    resource: "bun run build *"
    effect: allow
  - action: "shell"
    resource: "bun run build:sdk *"
    effect: allow
  - action: "shell"
    resource: "bun run build:vscode *"
    effect: allow
  - action: "shell"
    resource: "bun run react-doctor *"
    effect: allow
  - action: "shell"
    resource: "bun test *"
    effect: allow
  - action: "shell"
    resource: "bun run pins *"
    effect: allow
  - action: "shell"
    resource: "bun run pins:check *"
    effect: allow
  - action: "shell"
    resource: "bun install --frozen-lockfile"
    effect: allow
  - action: "shell"
    resource: "cd *"
    effect: allow
  - action: "shell"
    resource: "git status *"
    effect: allow
  - action: "shell"
    resource: "git diff *"
    effect: allow
  - action: "shell"
    resource: "git log *"
    effect: allow
  - action: "shell"
    resource: "git show *"
    effect: allow
  - action: "shell"
    resource: "git add *"
    effect: allow
  - action: "shell"
    resource: "git commit *"
    effect: allow
  - action: "shell"
    resource: "git push *"
    effect: deny
  - action: "shell"
    resource: "git commit *--amend*"
    effect: deny
  - action: "shell"
    resource: "git add -A*"
    effect: allow
---
You implement exactly one ticket in one git worktree. The ticket and its context are in your first message.

- Follow the steps in order. Write each test in `tests.must_add`. Run each command in `verification` from `global-sct/`.
- Edit only paths that match `scope.allow`. Do not edit a path in `scope.deny`.
- Do not run `git push`, `git merge`, `git rebase`, `git reset`, or `git checkout` of another branch.
- Do not change `package.json` or `bun.lock`. Do not install a dependency. Never run `tsc` directly.
- If `agtop/dist` or `global-sct/node_modules` is missing, run `bun run pins` from the repository root, then `bun install --frozen-lockfile` from `global-sct/`.
- Commit your work on the current branch with one commit.
- If a step needs a change outside the scope, stop. Write the exact needed change under the heading `SCOPE REQUEST` in your final message.
- Final message: the files that you changed, each command with its exit code, and any SCOPE REQUEST.
