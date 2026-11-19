# Lemon Tree pivot: an add-on to T3 Code

Date: 2026-11-18. Branch: `wave/1` at `3aab9f5`. Role: planner.
This document changes no product code. It replaces the Wave plan in
[completion-plan.md](completion-plan.md) and [orchestration-spec.md](orchestration-spec.md).
Those two files and the restart prompts stay as history.

T3 Code reference: `pingdotgg/t3code` `origin/main` at `0226239a41` (fetched on 2026-11-18).

---

## 1. Decision

Lemon Tree stops being a fork of the global.sct Electron app with its own agent control plane.
Lemon Tree becomes an add-on to T3 Code.

T3 Code already supplies most of the control plane that Waves 1 to 3 were going to build:

| Lemon Tree plan | T3 Code feature that covers it |
|---|---|
| Harness selection, `harnesses.json`, the ACP runner | Providers: Codex, Claude, Cursor, Grok, OpenCode, Pi, Antigravity, Kiro, the ACP Registry, and local ACP commands (`docs/user/providers-acp.md`) |
| Cross-harness context bridge | Portable handoffs and provider switching (`docs/user/portable-handoffs.md`, `docs/internals/context-handoffs.md`) |
| Worktree manager and the worktree diff pane | Built-in worktrees, branch naming, diff, and checkpoints |
| Remote dispatcher, peer mesh, daemon | Environments, linked environments, T3 Connect, `t3 up` background service, `delegate_task` to other environments (`docs/user/remote-access.md`, `docs/user/background-service.md`) |
| Job store (`db.ts`) | Orchestration V2 thread and task state in the T3 server |
| Subagent dispatch and waits | The `t3-code` orchestrator MCP server: `delegate_task`, `t3_thread_*`, `schedule_task` (`docs/orchestration-v2/orchestrator-mcp-server.md`) |
| Permission modal | Permission modes and approval cards (`docs/user/permission-modes.md`) |
| Project history sidebar | The T3 thread sidebar (`docs/user/thread-sidebar.md`) |
| Per-job scoped secrets (partly) | Secret providers (1Password) and the `request_secret` card (`docs/user/secrets.md`) |
| Process telemetry (partly) | The native resource monitor in diagnostics (`docs/internals/resource-telemetry.md`) |

## 2. The update rule

**T3 Code stays an unmodified upstream.** Lemon Tree never edits a T3 Code source file in its
normal path. T3 Code updates through its own updater (`docs/user/updating.md`), or through
`git pull` in a source checkout, without a merge conflict with Lemon Tree.

T3 Code has no plugin API. Lemon Tree therefore uses only the extension surfaces that T3 Code
already reads at run time. They are in order of upgrade safety:

| Rank | Surface | How Lemon Tree uses it | Upgrade risk |
|---|---|---|---|
| 1 | MCP servers that providers load | agtop's MCP server (`agtop/src/mcp.ts`: `list`, `status`, `run`, `wait`, `kill`, `cleanup`, `lemonade`, `accelerators`). Optionally the `sct mcp` vault server | None. A standard protocol |
| 2 | Skills (`~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`) | `subagent-orchestrator`, `agtop`, `session-kickoff`, `offpeak-scheduler`, and the other toolkit skills. T3 Code lists them with `$` and `/` | None |
| 3 | T3 Code's own MCP endpoint as a client (`/mcp`, "outside agents") | Lemon Tree scripts and the orchestrator skills call `delegate_task`, `t3_thread_*`, and `schedule_task` | Low. Tool names can change. Pin a capability check, as `pins.json` does for agtop |
| 4 | Provider settings | Local ACP commands and OpenCode configuration for local models (for example Lemonade or DeepSeek Harness) | Low. Configuration only |
| 5 | Project files: `t3.json` scripts, `AGENTS.md`, `opencode.json` | Project scripts such as "Run gate" and "Pins check" | Low |
| 6 | HTML renders and preview tools | Status pages such as a gate report or an agent tree, rendered in the thread | Low |
| 7 | A patch to T3 Code source | Only when a needed UI cannot exist in ranks 1 to 6 | **High.** See section 2.1 |

### 2.1 If a T3 Code source change is necessary

Do not keep a long-lived fork branch. Use this order:

1. Open an upstream pull request on `pingdotgg/t3code`. This is the preferred path.
2. If upstream does not accept it, keep it as a small patch file in this repository
   (`t3code-patches/NNNN-name.patch`). Pin the T3 Code commit in `pins.json` and apply the
   patches with a script after each update. A patch that fails to apply stops the update and
   shows which patch to rebase. Upgrades stay one `git pull` plus one script.

Evidence that this rule matters: the local T3 Code clone at `~/Documents/GitHub/t3code` is on
branch `backup-local-changes` with about 2,160 lines of staged, uncommitted UI changes
(`DraftProjectHistory.tsx`, `SidebarProjectAccordionToolbar.tsx`, sidebar logic, Labs settings).
That branch is 425 commits behind `origin/main`. Lemon Tree did not touch it. Decide whether to
send it upstream, convert it into a patch, or drop it (decision P4).

## 3. Target shape of this repository

```
lemon-tree/
  pins.json            agtop, toolkit, and t3code (track only, never edited)
  scripts/pins.ts      materialize pins; add a T3 Code capability check
  addon/               new: install script that registers MCP servers, skills, and
                       provider settings with T3 Code on this machine
  t3code-patches/      only if section 2.1 step 2 is needed; empty by default
  docs/
  global-sct/          reduced, or moved out (decision P1)
```

## 4. Keep, remove, or decide

Paths are relative to `global-sct/` unless they start with `/`.

### 4.1 Keep

| Item | Why | New role |
|---|---|---|
| `/pins.json`, `/pins.lock.json`, `/scripts/pins.ts`, `/package.json` scripts | The pin and capability-check method protects against upstream drift. It applies to T3 Code too | Add a `t3code` entry with `track: main` and a list of required T3 MCP tools |
| `/agtop` pin | Its MCP server covers the process bridge, kill, contained spawn, Lemonade probe, and accelerators | Register `agtop mcp` with each T3 provider |
| `/subagentclassifiertoolkit` pin | `select_target.py`, `verify_unit.py`, plan schema, and routing policy already drive delegation in T3 Code through the `subagent-orchestrator` skill | Unchanged |
| `/.githooks`, `/.github`, `/opencode.json`, `/.opencode` | Repository hygiene and the OpenCode worker setup | Unchanged |
| `.agents/orchestration/**` method (gates, verification records, decisions) | The verification discipline still applies to add-on work | Keep the method. Close the old Wave queue |
| `/docs/completion-plan.md`, `/docs/orchestration-spec.md`, restart prompts | History of the earlier plan | Mark as superseded by this file |

### 4.2 Remove (T3 Code covers it)

| Item | State today | Covered by |
|---|---|---|
| `harnesses.json`, `src/shared/harness-manifest.ts`, `src/main/harness-template.ts`, `tests/harnesses.test.ts`, `tests/harness-template.test.ts` | W2A-1, merged (`4426e0b`) | T3 providers. The user confirmed harness selection is not needed |
| `src/shared/acp-types.ts`, the `@agentclientprotocol/sdk` dependency | Types only | T3 provider ACP integration |
| `src/main/worktree-manager.ts`, `tests/worktree-manager.test.ts` | W1B-1, merged (`c4bfc02`) | T3 worktrees |
| `src/main/process-bridge/agtop-adapter.ts`, `capabilities.ts`, `src/main/agtop-type-check.ts`, `tests/agtop-adapter.test.ts`, the `agtop` file dependency | W1A-1, merged (`0653f76`) | agtop's own MCP server. The capability idea moves to `scripts/pins.ts` |
| `src/shared/contracts.ts` (service interfaces), `src/shared/ipc-channels.ts` | Types, no implementer | Nothing. The Electron IPC layer goes away |
| Unstarted Wave files: `acp-runner.ts`, `context-bridge.ts`, `lemonade-service.ts`, `remote-dispatcher.ts`, `db.ts`, `daemon-entry.ts`, `mesh/**` | Not written | Section 1 table |
| Unstarted Wave 3 panes: `HarnessStudioPane`, `ProjectHistorySidebar`, `WorktreeDiffPane`, `SubagentProcessDrawer`, `PermissionModal`, `PeerMeshDrawer` | Not written | T3 UI. `VaultDrawer` depends on decision P1 |
| Open tickets W1A-3, W1A-4, W1C-*, W1D-1, W2A-2, W2A-3, W2B-*, W3-* | Queued | Closed by this pivot |
| `agent/task-1a-process-bridge/FEAT-002` (`classifyPrompt`, W1A-2) | Passed Gate C, **not merged** | `select_target.py` in the toolkit already classifies a task. Do not merge. Keep the branch as an archive |

The removal is a later ticket. This document only records the decision.

### 4.3 Decide (the global.sct product itself)

These files are the original global.sct app: an encrypted local vault and encrypted handoffs
between devices. T3 Code does not cover them. Section 5 asks what happens to them.

| Item | What it is |
|---|---|
| `src/main/vault.ts`, `vault-header.ts`, `key-store.ts`, `seal.ts`, `runtime.ts`, `launch.ts`, `packages/env` | The vault and the `@sct/env` SDK that injects secrets into a process |
| `src/main/mcp.ts`, `agent.ts`, `agent-access.ts`, `caller.ts`, `skills/sct-*` | The `sct mcp` server and 10 agent skills for the vault |
| `envelope.ts`, `sharing.ts`, `share-gate.ts`, `transfer.ts`, `transport-*.ts`, `direct-frame.ts`, `webrtc-*.ts`, `relay-connection.ts`, `relay/**`, `packages/relay` | Device-to-device encrypted sharing (Hyperswarm, WebRTC, link, SpacetimeDB relay) |
| `src/renderer/**`, `src/preload/**`, `index.ts`, `protocol*.ts`, Electron build and package scripts, `native/airdrop.swift` | The Electron app shell |
| `packages/vscode` | A VS Code extension for the vault |

## 5. Open decisions

| ID | Question | Recommendation |
|---|---|---|
| P1 | What happens to the global.sct vault and sharing code? (a) Move it back to its own repository (`cadenh-dev/global.sct`) as a companion app. Lemon Tree uses only `sct mcp` and the `sct-*` skills. (b) Keep it inside Lemon Tree. (c) Drop it and use T3 secret providers only. | **(a).** It is a separate product with its own release cycle. Lemon Tree registers `sct mcp` like agtop. T3 Code does not need to change |
| P2 | Does Lemon Tree need a secret provider inside T3 Code (Settings → Secrets) backed by the sct vault? | Not now. T3 Code supports only 1Password, and a new provider needs a T3 source change (rank 7). Use `sct mcp` and `request_secret` first. Open an upstream request if a gap stays |
| P3 | Should `main` move forward to the finished Wave 1 work before the removal ticket? | Yes. Fast-forward `main` to `wave/1` and do the pivot on a new `pivot/t3-addon` branch. Not done in this change, because decision S2 forbids a push to `main` |
| P4 | The local T3 Code branch `backup-local-changes` (section 2.1) | Send the project-history sidebar work upstream as a pull request. Otherwise convert it into the first patch file |
| P5 | Keep the `.agents/` ticket and Gate C system for add-on work? | Keep it, but at a smaller size. Most add-on work is configuration and scripts |

## 6. Next tickets (after the decisions)

1. **PV-1 (lead):** add a `t3code` entry to `pins.json`. `pins:check` verifies that the T3 MCP
   tools Lemon Tree uses exist (`delegate_task`, `t3_thread_read`, `schedule_task`, `request_secret`).
2. **PV-2:** `addon/install.ts`: register `agtop mcp` (and `sct mcp` if P1 is (a) or (b)) for the
   Claude, Codex, and OpenCode providers. Link the toolkit skills. The script must be idempotent and
   have an `--uninstall`. Tests: a dry run writes nothing, a second run changes nothing.
3. **PV-3:** removal ticket for section 4.2. Gate: `bun run typecheck:tsc`, `bun run lint`, and the
   remaining unit tests pass.
4. **PV-4:** carry out decision P1.
5. **PV-5:** `t3.json` project scripts for the gates (`pins:check`, typecheck, lint, test).

## 7. Branch state after the 2026-11-18 cleanup

| Branch | Action | Reason |
|---|---|---|
| `wave/1` | Pushed with this document and the planning docs | The current line. It contains all merged work |
| `main` | Not changed | Decision S2 and P3 |
| `agent/task-1a-process-bridge/FEAT-002` | Kept on the remote | Unmerged W1A-2. Archive only (section 4.2) |
| `origin/1c/env-sdk-diagnostics` | Kept on the remote | Unmerged `@sct/env` change. It belongs to decision P1 |
| `wave/0`, `wave/T`, `origin/wave-0`, `origin/wave/T` | Deleted | Fully contained in `wave/1` |
| `agent/task-1a-process-bridge/FEAT-001`, `agent/task-1b-worktree/FEAT-001`, `agent/task-2a-runner/FEAT-001`, `agent/task-transport-tests/FEAT-001`, `agent/task-transport-tests/FEAT-002` | Deleted locally and on the remote | Fully merged into `wave/1` |
| `t3/implement-process-bridge` | Kept locally, not pushed | A T3 Code worktree branch at the same commit as the FEAT-002 branch |
