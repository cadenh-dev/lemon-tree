# Lemon Tree orchestration handoff

Updated: 2026-11-15. Lead: `claudeAgent/claude-fable-5-2` stopped at the Fable 5.2 usage limit. Read `decisions.json` and `routing.json` first, then `reports/restart-2026-11-15.md`.

## State

| Item | Value |
|---|---|
| Active branch | `wave/1`. The last work commit is `6848970`, equal to `origin/wave/1`. One local state commit follows it and is not pushed |
| Other branches | `main` at `4a7e537` (equal to `origin/main`). `wave/0` holds Stage 0 and the trust base. `wave/T` holds the Track T integration branch |
| Pins | agtop `d516dcb` (track `master`), toolkit `6190c31` (track `main`). Fingerprint `940287e3…4047`. `impact.ts status` gives `pinsCurrent: true`, `frozen: null` |
| Phase 0 and Phase 1 | Complete: LT-0.1 to LT-0.10 and ORC-1 to ORC-6 |
| Phase 2 (pilot) | Complete. T-3 merged at `578eb9f`, T-10 merged at `972b285`, 1 attempt each |
| Phase 3 merged | W1B-1 at `c4bfc02`, W1A-1 at `0653f76`, W2A-1 at `4426e0b` (completion `6848970`) |
| Phase 3 in flight | W1A-2 (`task-1a-process-bridge/FEAT-002`). Gate C passed at `b05a61f`. **Not merged** |
| Last full gate on `wave/1` | t3-ubuntu at `00f2cec`: `test:orc` 22 pass, `check` 0, `typecheck:tsc` 0, `test` 119 pass in 12 files, `build` 0, React Doctor 100 / 100 |
| Last WIN11 gate | at `6394505`: `pins` leaves the lock file unchanged, `lint` 0, `typecheck:tsc` 0, `test` 115 pass and 4 skip in 12 files |

## Stop point

The lead merged W2A-1, added its test to the script, set it `completed`, pushed `6848970`, and then hit the usage limit. The next command was the W1A-2 merge. It did not run.

W1A-2 facts: branch `agent/task-1a-process-bridge/FEAT-002` at `b05a61f` (pushed). Worktree `/home/cadenh/.t3/worktrees/lemon-tree/t3-2d5f5298` (clean). Gate report `t3-ubuntu:/home/caden/lt-wt/W1A-2.gate.json`: `result: pass`, exit 0, checks 0-7 and 9 pass, 8 `ui` skipped. The record is `verifying`. The test is not in the `test` script. The record has a stale `findings` line and a local `attempts[0].report` path that does not exist.

## How to run one ticket (decision S4)

Tests run only in the linked machines. This machine does coding (T3 subagents) and git-level checks. A worker runs typecheck and lint only (decision S5).

1. `bun run orc:validate`. Write the ticket and commit it on `wave/1`.
2. Dispatch the coding worker with T3 `delegate_task` on this machine: `isolation: "worktree"`, `runtimeMode: "full-access"`, target `opencode` / `opencode-go/deepseek-v4.1-flash` with `variant: high`. You may use codex `gpt-6-astra` or `gpt-6-luna`, and `claudePersonal` / `claude-fable-5-2`. The brief tells the worker not to run tests.
3. When the worker stops, push its branch and `wave/1` to origin.
4. Run Gate C on t3-ubuntu with a `delegate_task` there (codex `gpt-6-luna`): fetch, add a worktree for the agent branch, and run `bun scripts/orc/verify-ticket.ts <task> <feat> --worktree <path> --report <file>` from the repository root. The Windows unit tests of each wave run on WIN11 after a merge.
5. On a pass, read the full diff and each test. Merge `--no-ff` into `wave/1`, add each new test file to the `test` script, push, and run the full gate in the VM. Write `findings` and set `completed`.
6. On a failure: a new `delegate_task` with the failed check and the output tail. Attempt 3 is the last.

## Open items

- **Finish W1A-2 first.** Read the gate report, review, merge, add `classify-prompt.test.ts` to the `test` script, push, run the full gate, write `findings`, set the feature and task to `completed`. Steps and commands: `reports/restart-2026-11-15.md` section 3.
- Ready to write and dispatch: W1D-1 (`lemonade-service.ts`), W1C-1 (`vault-mcp.ts`). W1A-3 needs a user decision on how a toolkit target maps to a `HarnessId`. W2B-1 needs a `node:sqlite` check under Bun 1.4.4 and Electron 45 on t3-ubuntu.
- WIN11: Gate C cannot run there. The mutation probe makes symbolic links and Windows refuses them without elevation or developer mode (`EPERM`). `bun install --frozen-lockfile` exits 1 in `install-electron` ("Cannot find native binding" in `@electron-internal/extract-zip`), so no UI test and no packaging there.
- WIN11 has no Python. `pins:check` passed there, so the toolkit capability probe is not explained.
- Gate C does not call the toolkit outcome ledger. Each report has `ledger: "not-recorded"`.
- `origin/1c/env-sdk-diagnostics` is not merged. Keep `packages/env/src/index.ts` and `tests/env-sdk.test.ts` unchanged.
- `harnesses.json` records OpenCode 2.2.6 and the installed version is 2.3.0 (D13).
- W1A-1 follow-ups for W1A-4: `agtop-adapter.ts` holds the two pin SHAs as a constant, and `containmentMode` is a closed set of 5 values.
- `docs/` at the workspace root is not committed. It holds the plan, the specification, the execution prompt, and the restart prompt.
- The `test` script names each file. A new test file is silent until you add it.
- Push only `wave/*` and `agent/*` (decision S2). Do not push `main`, do not tag, do not release, and do not open a pull request.

## Next command

`bun run orc:validate && bun scripts/orc/impact.ts status`, then read `global-sct/.agents/orchestration/reports/restart-2026-11-15.md` and merge W1A-2.
