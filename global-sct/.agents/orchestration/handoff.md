# Lemon Tree orchestration handoff

Updated: 2026-11-15. Lead: `claudeAgent/claude-fable-5-2`. Read `decisions.json` and `routing.json` in this folder first.

## State

| Item | Value |
|---|---|
| Branches (local, not pushed) | `main` at `4a7e537` (equal to `origin/main`). `wave/0` holds Stage 0 and the trust base. `wave/T` is the Track T integration branch, on top of `wave/0` |
| Pins | agtop `d516dcb` (track `master`), toolkit `6190c31` (track `main`). Fingerprint `940287e3…4047` in `pins.lock.json`. Both pins are ancestors of their tracks |
| Base gate on `wave/0` (this machine, before decision S4) | `check` 0, `typecheck:tsc` 0, 84 tests in 8 files, `build` 0, React Doctor 100 / 100, 22 orchestration tests |
| Full gate on `wave/T` at `b927e77` (t3-ubuntu, Bun 1.4.4) | `pins:check` 0, `test:orc` 22 pass, `orc:validate` 0, `check` 0, `typecheck:tsc` 0, `test` 98 pass in 10 files, `build` 0, React Doctor 100 / 100. The VM has a display, `xvfb-run`, and Playwright; the UI tests did not run yet |
| Phase 0 and Phase 1 | Complete: LT-0.1 to LT-0.10 and ORC-1 to ORC-6 |
| Phase 2 (pilot) | Complete. T-3 merged at `578eb9f`, T-10 merged at `972b285`, 1 attempt each |
| Phase 3 | Integration branch `wave/1` (for 1A to 1D), on top of `wave/T`. `task-1b-worktree` FEAT-001 (W1B-1) and `task-1a-process-bridge` FEAT-001 (W1A-1) are dispatched to T3 subagents. W2B-1 waits for a check that `node:sqlite` works under Bun and Electron 45 |

## How to run one ticket (decision S4)

Tests run only in the linked machines. This machine does coding (T3 subagents) and git-level checks.

1. `bun run orc:validate`. Write the ticket and commit it on `wave/<wave>`.
2. Dispatch the coding worker with T3 `delegate_task` on this machine: `isolation: "worktree"`, `runtimeMode: "full-access"`, the brief from the ticket. Default target `opencode` / `opencode-go/deepseek-v4.1-flash`. Codex `gpt-6-astra` or `gpt-6-luna`, and `claudePersonal` / `claude-fable-5-2`, are permitted as needed. The brief tells the worker not to run tests, because tests run in the VM.
3. When the worker stops, push its branch and `wave/<wave>` to origin.
4. Run Gate C on t3-ubuntu with a `delegate_task` there (codex `gpt-6-luna`): fetch, add a worktree for the agent branch, and run `bun scripts/orc/verify-ticket.ts <task> <feat> --worktree <path> --report <file>`. The runner returns the report JSON verbatim. Windows checks run on WIN11 in the same way.
5. On a pass: read the full diff and each test, merge `--no-ff` into `wave/<wave>`, add each new test file to the `test` script, push, and run the full gate in the VM. Write `findings` and set `completed`.
6. On a failure: a new `delegate_task` with the failed check and the output tail. Attempt 3 is the last.

## Open items

- WIN11 baseline on `wave/T` at `b927e77`: `pins` 0, `pins:check` 0 (same fingerprint), `lint` 0, `typecheck:tsc` 0, `test` 95 pass and 3 skip in 10 files, `build` 0. Open: `bun install --frozen-lockfile` exits 1 in the `install-electron` postinstall ("Cannot find native binding" in `@electron-internal/extract-zip`), so the Electron binary is not installed there and UI tests and packaging cannot run on WIN11 yet. The winget installers for Git and Python need an administrator prompt; Git is the portable MinGit, and Python is absent, so the `toolkit.select-target` capability is missing on WIN11.
- `origin/1c/env-sdk-diagnostics` is not merged. Keep `packages/env` tickets away from `packages/env/src/index.ts` and `tests/env-sdk.test.ts` until the user merges it.
- Gate C does not call the toolkit outcome ledger (`verify_unit.py`, `record_verification.py`). The gate report has `ledger: "not-recorded"`.
- A harness with an id outside `HARNESS_IDS` still needs a change to the `HarnessId` type.
- The research sandbox cannot remove write permission before a run. The post-run check (`route-research.ts check`) is the control.
- `harnesses.json` records OpenCode 2.2.6 with 1.x config keys. The installed version is 2.3.0 (D13).
- `docs/` at the workspace root is not committed. It holds the plan, the specification, and the execution prompt.
- No branch is pushed. The user approved pushes of `wave/*` and `agent/*` only.

## Next command

`bun run orc:validate && bun scripts/orc/impact.ts status`, then read `global-sct/.agents/tasks/task-transport-tests/features/*.json`.
