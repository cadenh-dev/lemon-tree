# Lemon Tree workspace instructions

The control plane lives in `global-sct/`. `agtop/` and `subagentclassifiertoolkit/` are pinned source clones; `global-sct/` is the committed fork archive. Pin URLs, SHAs, and paths are in `pins.json`; use `bun run pins` to materialize and build agtop, and `bun run pins:check` to verify without changing checkouts.

Follow [global-sct/AGENTS.md](global-sct/AGENTS.md). Its ownership matrix is the section 6 wave ownership matrix.

## Section 6: Ownership matrix

Paths are relative to `global-sct/`.

| Wave | Ownership |
|---|---|
| Wave 0 (lead) | `package.json`, `harnesses.json`, `src/shared/contracts.ts`, `acp-types.ts`, `ipc-channels.ts`, `harness-manifest.ts`, `tsconfig*.json`, `src/main/agtop-type-check.ts` |
| 1A Process & classifier bridge | `src/main/process-bridge.ts`, `src/main/process-bridge/**` (adapter over `../agtop` for trees, roles, kill, spawn and accelerators; TypeScript prompt→PromptIntent mapping; `select_target.py` subprocess). No process-role classifier. May read pinned clones, never edit them. |
| 1B Worktree | `src/main/worktree-manager.ts` |
| 1C Vault & MCP | `src/main/vault-mcp.ts`, `packages/env/**` (existing @sct/env SDK; extend it) |
| 1D Lemonade | `src/main/lemonade-service.ts` |
| 2A ACP runner & context | `src/main/acp-runner.ts`, `src/main/context-bridge.ts` |
| 2B Mesh, daemon & store | `src/main/remote-dispatcher.ts`, `src/main/db.ts`, `src/main/daemon-entry.ts`, `src/main/mesh/**` (packages/relay is existing SpacetimeDB module; extend only for new reducers) |
| 3 IPC & UI | `src/main/index.ts` handlers, `src/preload/**`, `src/renderer/src/**` (ProjectHistorySidebar, HarnessStudioPane, WorktreeDiffPane, SubagentProcessDrawer, PermissionModal, VaultDrawer, PeerMeshDrawer) |
| Each wave | Owns its new test files under `tests/` |
