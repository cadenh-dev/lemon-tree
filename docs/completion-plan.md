# Lemon Tree: repo audit and drift-tolerant completion plan

Date: 2026-11-14. Workspace commit: `95013cd` (Wave 0). Author role: planner.
This document is a plan. It changes no product code.
The companion document is [orchestration-spec.md](orchestration-spec.md).

Source code, tests, and `pins.json` are the truth in this document. The Markdown plans in `global-sct/docs/` are intent only.

---

## 1. Audit evidence

### 1.1 Commands run in this audit

All commands ran on Linux x64 (CachyOS), Bun 1.4.4, Node 26.13.1.

| Check | Command (from `global-sct/` unless noted) | Result |
|---|---|---|
| Pins, fresh clone | `bun run pins` (workspace root) | **Fails.** See D1 |
| Pins, after manual repair | `bun run pins:check` (workspace root) | Pass. agtop `c139561`, toolkit `d009ae4` |
| Lint | `bun run lint` | Pass, 0 warnings |
| Official typecheck | `bun run typecheck:tsc` | Pass, 4 projects |
| Bun typecheck | `bun run typecheck` | Pass. 92, 39, 1, and 12 files |
| Unit tests | `bun run test` | 46 pass, 0 fail, 7 files |
| SDK build | `bun run build:sdk` | Pass |
| VS Code bundle | `bun run build:vscode` | Pass |
| App build | `bun run build` | Pass. The AirDrop helper is skipped outside macOS |
| React Doctor | `bun run react-doctor` | **93 / 100.** 8 warnings, all in `src/shared/harness-manifest.ts` |
| Playwright | `bun run test:ui` | **Not run in this audit.** It opens app windows on the desktop |
| Package | `bun run package:linux` | Not run |

Typecheck and tests pass only after agtop is cloned **and built**. Without `agtop/dist`, typecheck fails with TS2307 in `agtop-type-check.ts`, `contracts.ts`, and `tests/workspace-link.test.ts`.

### 1.2 Upstream position against the pins

| Repository | Pinned SHA | Upstream `HEAD` today | Position |
|---|---|---|---|
| agtop | `c139561` | `d516dcb` | The pin is 9 commits behind. The only `src/` change is 5 lines in `src/mcp.ts`. No exported type changed |
| SubagentClassifierToolkit | `d009ae4` | `6190c31` | **The pin is not an ancestor of `main`.** 61 commits exist only on the pin side and 64 only on `main`. The history was rewritten |
| global.sct fork base | `ab5b001` | `ab5b001` | No change |

The toolkit pin can still be fetched by SHA. No branch contains it, so the host can delete it at any time.
`select_target.py`, `verify_unit.py`, `record_verification.py`, and `plan.schema.json` are the same at the pin and on `main`. `main` adds `fix_brief.py`, `install_bootstrap.py`, and an eval suite.

### 1.3 Defects and drift found (D-list)

| ID | Finding | Evidence | Effect |
|---|---|---|---|
| D1 | `scripts/pins.ts` cannot materialize the toolkit | `git clone` then `checkout --detach d009ae4` gives `fatal: unable to read tree`. `git fetch origin <sha>` works | A new checkout cannot build. A failed run leaves a clone at the wrong commit, and the next run stops with "exists at … expected …" |
| D2 | agtop is built only when the same `pins` run cloned it and both pins passed | `agtopMaterialized` flag in `scripts/pins.ts` | After D1, agtop has no `dist/`. `bun install` in `global-sct/` then links an empty package |
| D3 | No CI runs in this repository | Workflows are in `global-sct/.github/workflows/`. The workspace root has no `.github/` | Checks and release jobs are dead. They also have no pins step |
| D4 | The task records are stale | `task-c8d-transport-receipt` is `in_progress` with FEAT-002 `blocked`. `task-cream-theme-polish` FEAT-002 is `in_progress` with empty findings. Both describe a Windows shared checkout | The state machine does not describe the code. See section 2 |
| D5 | React Doctor is below the target | 8 `zod-v4-no-deprecated-schema-apis` warnings in `harness-manifest.ts` lines 20–51 | Wave 0 broke the "score 100" rule |
| D6 | `.hallmark/preflight.json` is wrong | It records "GSAP state motion". The dependency is `animejs` 4.5.0. No GSAP import exists | Design preflight gives wrong guidance |
| D7 | `.hallmark/log.json` has one entry (issue 14, 2026-10-25) | Direct, WebRTC, Links, share gate, and receipt screens are not logged | The design log is incomplete |
| D8 | The link router accepts a second scheme | `src/main/protocol.ts` accepts `global-sct://` and `sct://`. The plan permits only `global-sct://` | Spec divergence. It needs a decision |
| D9 | Direct records use a different layout | Code: `direct-sent.json`, `direct-inbox.json`, `direct-receipts.json`. Plan: one file per transfer in `direct-outbox/`, `direct-inbox/`, `direct-receipts/` | No outbox exists, so an explicit retry of the same ciphertext is not possible |
| D10 | No common transport adapter | `src/main/transport.ts` has one function, `relayReceiptState`. The plan specifies `availability`, `send`, `sendReceipt`, `close` | Each transport has its own surface. The selector cannot treat them the same |
| D11 | New sharing code has no unit tests | No test names `prepareEnvelope`, `acceptEnvelope`, `verifyEnvelopeReceipt`, `FrameReader`, `ShareGate`, or `readProtocolLink` | The C8d acceptance criterion "exactly two new tests" is not met |
| D12 | `stage-dependencies.ts` stages keyring and Hyperswarm only | Lines 14–15 | A packaged app fails when Wave 1A imports agtop at run time. agtop needs `koffi`, a native module |
| D13 | Manifest versions are behind the installed tools | `harnesses.json` records OpenCode 2.2.6. The installed version is 2.3.0. `dsh` and `aider` are not installed here | Preflight results for those entries are unverified |
| D14 | Contracts have no run-time schemas | `contracts.ts` is types only. Only the harness manifest has a Zod schema | Upstream shape changes pass typecheck at the pin and fail at run time after a pin move |
| D15 | `ipc-channels.ts` has two channels with one meaning | `job:events` and `job:sync` both take `JobSyncRequest` and return `JobSyncResponse` | Wave 3 must know which one to implement |
| D16 | Two rule sets conflict in `global-sct/AGENTS.md` | "Do not add tests unless I approve" and "Do not make decisions for yourself" stand below override 1 and 3. `implementation-plan.md` 0.2 names Effect Schema. The code uses Zod | Delegates need one rule. The overrides win. Tickets must say so |
| D17 | The SpacetimeDB CLI is not installed | `spacetime` is missing | `bun run relay:generate` cannot run here |

---

## 2. Drift and readiness matrix

Classification rules:

- `[COMPLETE & VERIFIED]`: the code exists and a check in section 1.1 covers it.
- `[IMPLEMENTED BUT DIVERGED FROM SPEC]`: the code exists and differs from the plan, the task record, or the project rules.
- `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]`: partly done, or its truth depends on an upstream that moves.
- `[MISSING / UNSTARTED]`: no file exists.

"Verified" means the automated checks pass on Linux. It does not mean a platform, network, or packaged check passed.

### 2.1 Workspace root

| Module | Class | Notes |
|---|---|---|
| `pins.json` | `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]` | agtop is 9 commits behind. The toolkit pin is orphaned. No version, capability, or compatibility field |
| `scripts/pins.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | D1, D2. No drift report. No machine-readable output |
| Root `AGENTS.md` | `[COMPLETE & VERIFIED]` | It matches `global-sct/AGENTS.md` section 6 |
| Root CI | `[MISSING / UNSTARTED]` | D3 |

### 2.2 `global-sct/src/shared/`

| Module | Class | Notes |
|---|---|---|
| `contracts.ts` (495 lines) | `[COMPLETE & VERIFIED]` as types | Typecheck passes at the pin. No implementer exists for any of its 8 service interfaces. D14 |
| `acp-types.ts` (3 lines) | `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]` | A re-export of `@agentclientprotocol/sdk` 2.4.0 types. Its comment records that draft v2 removes `fs/*` and `terminal/*` |
| `harness-manifest.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | Schema and 3 tests pass. D5. `harnessManifestSchema` requires exactly 6 entries, so a seventh harness breaks validation |
| `ipc-channels.ts` | `[COMPLETE & VERIFIED]` as types | Typed `handle()` and `invokeChannel()` helpers exist. No handler is registered for any of the 28 channels. D15 |
| `transport.ts`, `envelope.ts`, `direct.ts`, `connect.ts`, `share.ts`, `webrtc.ts` | `[COMPLETE & VERIFIED]` | Typecheck passes. They are used by the sharing code |
| `agent.ts`, `api.ts`, `vault.ts`, `secrets.ts`, `projects.ts`, `relay.ts`, `sharing.ts`, `cards.ts` | `[COMPLETE & VERIFIED]` | Covered by the unit tests through their users |

### 2.3 `global-sct/src/main/` (existing global.sct code)

| Module | Class | Notes |
|---|---|---|
| `agtop-type-check.ts` | `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]` | 4 compile-time assertions pass at `c139561`. It checks no run-time value. It must be re-run for each pin move |
| `vault.ts`, `vault-header.ts`, `key-store.ts`, `seal.ts` | `[COMPLETE & VERIFIED]` | 18 vault tests pass |
| `runtime.ts`, `launch.ts` | `[COMPLETE & VERIFIED]` | 6 runtime tests pass on Linux. The plan records 3 skips on Windows |
| `agent.ts`, `agent-access.ts` | `[COMPLETE & VERIFIED]` | 10 operations. Each has a matching `skills/sct-*` folder. Agent sends go through the share gate (`index.ts:535`) |
| `mcp.ts` | `[COMPLETE & VERIFIED]` | The stdio `sct mcp` server for Agent Access. **It is not the Wave 1C per-job HTTP server** |
| `caller.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | Linux callers are unverified by design. The certificate thumbprint pin is an open follow-up. No test |
| `projects.ts`, `preferences.ts`, `cards.ts`, `transfer.ts` | `[COMPLETE & VERIFIED]` | Project and sharing tests pass |
| `envelope.ts` | `[COMPLETE & VERIFIED]` | 7 envelope tests pass. `verifyTransferReceipt` exists |
| `sharing.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | The device-ID envelope methods exist and typecheck. D11. The method signatures follow the "second writer" version in the task record, not the FEAT-002 text |
| `transport.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | D10 |
| `transport-link.ts`, `connect-link.ts` | `[COMPLETE & VERIFIED]` by typecheck only | No unit test. `app.spec.ts` uses Link |
| `direct-frame.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | The global frame limit is enforced. Per-kind limits are enforced in each transport, not in the reader. No test |
| `transport-hyperswarm.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | Auth, ping, 32/8 session caps, and the 4-transfer cap exist. D9. No two-minute transmission limit was found. No test. No two-machine check |
| `transport-webrtc.ts`, `webrtc-window.ts`, `webrtc-config.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | Hidden window, non-persistent partition, navigation and permission denial, one-fingerprint SDP check, 16 KiB chunks, and 256/64 KiB backpressure exist. No session-count cap was found. No test. No network check |
| `share-gate.ts` | `[COMPLETE & VERIFIED]` by inspection | Two-minute expiry, one-use closure, queue of 8, clear on lock. Wired to Mailbox, Direct, WebRTC, Link, export, and agent paths. No unit test |
| `protocol.ts`, `protocol-registration.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | D8. Registration code exists for 3 platforms. V1–V3 are not run |
| `relay-connection.ts`, `relay/**` | `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]` | `relayReceiptState` is wired. One relay test passes. The generated bindings cannot be regenerated here (D17). No live relay check |
| `index.ts` | `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]` | global.sct handlers are complete. Lemon Tree handlers are absent |

### 2.4 `global-sct/src/main/` (Lemon Tree control plane)

Every file is `[MISSING / UNSTARTED]`.

| Wave | Missing files |
|---|---|
| 1A | `process-bridge.ts`, `process-bridge/**` |
| 1B | `worktree-manager.ts` |
| 1C | `vault-mcp.ts` |
| 1D | `lemonade-service.ts` |
| 2A | `acp-runner.ts`, `context-bridge.ts` |
| 2B | `remote-dispatcher.ts`, `db.ts`, `daemon-entry.ts`, `mesh/**` |
| 3 | 28 IPC handlers, preload exposure, `ProjectHistorySidebar`, `HarnessStudioPane`, `WorktreeDiffPane`, `SubagentProcessDrawer`, `PermissionModal`, `VaultDrawer`, `PeerMeshDrawer` |

### 2.5 Packages, skills, renderer, tests, packaging

| Module | Class | Notes |
|---|---|---|
| `packages/env` | `[COMPLETE & VERIFIED]` | `build:sdk` passes. Wave 1C extends it |
| `packages/relay` | `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]` | Typecheck passes. D17. Wave 2B can add reducers |
| `packages/vscode` | `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]` | Beyond the skeleton: 3 commands, an Explorer tree, and a secrets terminal. The Activity Bar panel is a proposal only. No VSIX. V14 is not run |
| `skills/sct-*` (10) | `[COMPLETE & VERIFIED]` | One folder for each `agentTools` key. `mcp.ts` reads them by that name |
| Renderer sharing views, `PendingReceipts.tsx` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | The build passes. The activity table of the plan (6 states, sender and recipient actions) is not verified. No Playwright test covers Direct, WebRTC, the gate, or receipts |
| `styles.css` (Cream polish) | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | `--color-input-border`, the ink overrides, and the 4px tab rule exist. The task record has no findings, and the Terminal screenshots were not regenerated |
| `.hallmark/` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | D6, D7 |
| `harnesses.json` | `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]` | 6 entries validate. 5 entries list `unverified` fields. D13 |
| Unit tests | `[COMPLETE & VERIFIED]` for existing scope | 46 tests. D11 |
| Playwright specs | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | `platform.spec.ts` is Windows only. The plan records 2 Windows failures in `app.spec.ts` and `sharing.spec.ts` that need approved test changes. No Linux run exists |
| `scripts/package-macos.ts` | `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]` | Signing code exists. Credentials are deferred (D12 of the fork plan) |
| `scripts/package-windows.ts`, `package-linux.ts` | `[IN-FLIGHT / PARTIAL — RECEIVING EXTERNAL UPDATES]` | Unsigned. Only the Windows package has a recorded check |
| `scripts/stage-dependencies.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | D12 of this document |
| `scripts/install-cli.ts` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | Item 1.6 is "partly done": a direct MCP client on Windows needs `cmd /c` or the full path |
| `native/airdrop.swift` | `[COMPLETE & VERIFIED]` on macOS only, by record | Not buildable here |
| `.agents/tasks/*` | `[IMPLEMENTED BUT DIVERGED FROM SPEC]` | D4 |

---

## 3. Defensive architecture for agtop, global.sct, and the toolkit

### 3.1 Principle

No file outside the boundary layer imports `agtop`, starts a toolkit script, or reads a pin. Core code depends on Lemon Tree's own types and on a capability set. When an upstream changes, one adapter changes.

Today `contracts.ts` re-exports 15 agtop types directly. Each of those is an uncontrolled coupling point. The plan keeps the type re-exports, because they are locked, and adds a run-time layer under them.

### 3.2 File layout

All paths are relative to `global-sct/`. Lead-owned files are marked.

| File | Owner | Purpose |
|---|---|---|
| `src/shared/boundary.ts` (new, lead) | Wave 0 | `Envelope<T>`, `CapabilityId`, `CapabilitySet`, `BoundaryIssue`, `Degraded<T>` types. Renderer-safe |
| `src/shared/boundary-schemas.ts` (new, lead) | Wave 0 | Zod schemas for every shape that crosses a process or repository edge |
| `src/main/agtop-type-check.ts` (lead) | Wave 0 | Keeps the 4 assertions. Adds the schema-to-type equality assertions |
| `src/main/process-bridge/agtop-adapter.ts` | 1A | The only run-time importer of `agtop` |
| `src/main/process-bridge/toolkit-adapter.ts` | 1A | The only caller of `select_target.py` |
| `src/main/process-bridge/capabilities.ts` | 1A | Capability discovery and the cached `CapabilitySet` |
| `../scripts/pins.ts`, `../pins.json` (lead) | Wave 0 | Pin materialization, drift report, capability manifest |
| `../pins.lock.json` (new, generated, committed) | Wave 0 | The verified facts about each pin |

### 3.3 Versioned contract envelope

Every message that crosses IPC, the job event log, the mesh, or a subprocess pipe travels in one envelope.

```ts
// src/shared/boundary.ts
export const CONTRACT_VERSION = { major: 1, minor: 0 } as const

export interface Envelope<K extends string, T> {
  /** Fixed marker. A reader rejects any other value before it reads the body. */
  format: 'lemon-tree'
  /** Major: breaking. Minor: additive fields only. */
  v: { major: number; minor: number }
  kind: K
  /** Capabilities the writer used to build the body. The reader needs all of them. */
  needs: CapabilityId[]
  body: T
}

export type BoundaryIssue =
  | { code: 'major-mismatch'; got: number; want: number }
  | { code: 'missing-capability'; capability: CapabilityId }
  | { code: 'schema'; path: string; message: string }

export type Decoded<T> = { ok: true; value: T; ignoredFields: string[] } | { ok: false; issues: BoundaryIssue[] }
```

Reader rules:

1. Check `format`, then `v.major`. A different major returns `major-mismatch`. The reader never guesses.
2. A higher `v.minor` is accepted. Unknown fields are dropped and listed in `ignoredFields`.
3. Each entry in `needs` must be in the local `CapabilitySet`. If not, return `missing-capability`.
4. Validate `body` with the schema for `kind`. Schemas for *inbound upstream data* use `z.looseObject` and then pick known fields. Schemas for *Lemon Tree's own persisted data* use `z.strictObject`.
5. A failed decode never reaches the store, the renderer, or the vault. It becomes one `JobEvent` of kind `error` with `fatal: false`, or one row in a boundary log.

Where the envelope applies:

| Edge | Body | Rule |
|---|---|---|
| `events.ndjson` lines | `JobEvent` | A line with a bad envelope is skipped and counted. The index sequence stays intact |
| `RemoteJobPayload`, `RemoteJobAck` | Inside the sealed envelope | A major mismatch returns `RemoteJobAck { accepted: false, reason }` |
| MCP tool results from `vault-mcp.ts` | `SecretAccessResult`, `ProjectMemory` | Validate before the result leaves the server |
| IPC `Reply<T>` for Lemon Tree channels | Channel result | Validate in `handle()` in development and test builds. Production validates only data that came from an upstream |
| agtop return values | `ProcessListing`, `KillResult`, `AcceleratorSnapshot`, `LemonadeStatus` | Validated in `agtop-adapter.ts` |
| `select_target.py` stdout | `HarnessRecommendation[]` source data | Validated in `toolkit-adapter.ts` |

Schema and type agreement is a compile-time fact. For each schema, add the same assertion that `harness-manifest.ts` uses:

```ts
export const processListingMatches: Equal<z.infer<typeof processListingSchema>, ProcessListing> = true
```

A pin move that changes an agtop type then fails `typecheck:tsc` in one known file.

### 3.4 Capability negotiation

```ts
// src/shared/boundary.ts
export const CAPABILITIES = [
  'agtop.trees', 'agtop.kill', 'agtop.spawn-contained', 'agtop.roles', 'agtop.accelerators',
  'agtop.lemonade-probe', 'agtop.worktree-detect', 'agtop.daemon',
  'toolkit.select-target', 'toolkit.verify-unit', 'toolkit.plan-schema', 'toolkit.fix-brief',
  'acp.v1', 'acp.fs', 'acp.terminal',
  'sct.envelope-v1', 'sct.direct-hyperswarm', 'sct.direct-webrtc', 'sct.mailbox', 'sct.share-gate',
] as const
export type CapabilityId = (typeof CAPABILITIES)[number] | `x.${string}`
export interface CapabilitySet {
  present: CapabilityId[]
  missing: { capability: CapabilityId; reason: string }[]
  probedAt: number
  pins: { agtop: string; toolkit: string }
}
```

Discovery runs once at start and again after a pin change. It uses facts, not version numbers.

| Capability | Probe |
|---|---|
| `agtop.*` function capabilities | `typeof agtop.<name> === 'function'` on the dynamic import |
| `agtop.roles` | `roleCatalog()` returns an array, and each row passes `roleInfoSchema` |
| `agtop.trees` | `listAgentTrees()` resolves, and the result passes `processListingSchema` |
| `toolkit.select-target` | The script file exists at the path in `pins.lock.json`, `python3` exists, and `--help` exits 0 and lists `--capabilities`, `--role`, `--depth`, `--json` |
| `toolkit.fix-brief` | The file exists. It is absent at the current pin, so this capability is `missing` |
| `acp.fs`, `acp.terminal` | Read from the agent's `initialize` response, never assumed |
| `sct.*` | Fixed by the build. They exist so that mesh peers can compare sets |

The `x.<name>` form lets a new project addition register a capability without a change to the union.

### 3.5 Graceful degradation table

Each `ProcessBridge` method has one defined fallback. No method throws because an upstream is absent.

| Method | Needs | When missing |
|---|---|---|
| `listTrees()` | `agtop.trees` | Return `{ supported: false, reason }`. This variant already exists in `ProcessListing` |
| `killTree()` | `agtop.kill` | Return a `KillResult` failure with the reason. Never fall back to a raw `process.kill` |
| `spawnContained()` | `agtop.spawn-contained` | Reject the job before a worktree is created. Status `failed`, code `containment-unavailable` |
| `roleCatalog()` | `agtop.roles` | Return `[]`. The UI hides the role legend. No local role classifier is written (AGENTS.md rule 6) |
| `acceleratorSnapshot()` | `agtop.accelerators` | Return `null`. The contract already allows it |
| `classifyPrompt()` | None. It is local TypeScript | Always available |
| `recommendHarness()` | `toolkit.select-target` | Use the manifest heuristic. Set `source: 'manifest-heuristic'`. The contract already has this value |
| `LemonadeService.probe()` | `agtop.lemonade-probe` | Use a local `fetch` of `LEMONADE_DEFAULTS.healthPath`. Return `reachable: false` with the error on failure |
| ACP runner | `acp.v1` | Use `headless-json` when the manifest allows it. `HarnessPreflightResult.protocol` reports the result |

Unknown values from upstream:

- An agtop `HarnessType` outside `HARNESS_IDS` leaves `harnessId` unset on the tree. The tree is still shown.
- An unknown `ProcessRole` is shown with the raw string and the label "Unrecognized role".
- An unknown `Backend` on a process is display-only. `JobBackend` stays at its 2 values.

### 3.6 Pins as a capability manifest

`pins.json` gains optional fields. The current 3 fields stay valid, so the change is additive.

```json
{
  "schema": 2,
  "agtop": {
    "url": "https://github.com/cadenh-dev/agtop.git",
    "sha": "c13956152d5e0f3ca512e93bae7078d5b0f2d40c",
    "path": "agtop",
    "track": "main",
    "build": ["bun install --frozen-lockfile", "bun run build"],
    "requires": ["agtop.trees", "agtop.kill", "agtop.spawn-contained", "agtop.roles"],
    "optional": ["agtop.accelerators", "agtop.lemonade-probe", "agtop.worktree-detect", "agtop.daemon"],
    "surface": ["src/index.ts", "src/types.ts"]
  },
  "subagentclassifiertoolkit": {
    "url": "https://github.com/cadenh-dev/SubagentClassifierToolkit.git",
    "sha": "d009ae4968b6c8e6e648a3031ced2122bd24e5b8",
    "path": "subagentclassifiertoolkit",
    "track": "main",
    "requires": [],
    "optional": ["toolkit.select-target", "toolkit.verify-unit", "toolkit.plan-schema", "toolkit.fix-brief"],
    "surface": [
      ".opencode/skills/subagent-orchestrator/scripts/select_target.py",
      ".opencode/skills/subagent-orchestrator/scripts/verify_unit.py",
      ".opencode/skills/subagent-orchestrator/assets/plan.schema.json",
      ".opencode/skills/subagent-orchestrator/data/routing-policy.json"
    ]
  },
  "globalSctForkBase": { "url": "https://github.com/cadenh-dev/global.sct", "sha": "ab5b00106f0a47bcd5dd308a5576bbb464b27190", "track": "main" }
}
```

`scripts/pins.ts` changes:

1. **Materialize by SHA.** `git init`, `git remote add`, `git fetch origin <sha>`, `git checkout --detach FETCH_HEAD`. This repairs D1 for any commit the host still serves.
2. **Repair a partial clone.** If the folder exists, the tree is clean, and `HEAD` differs, fetch the SHA and check it out. If the tree is dirty, stop and name the files. Never reset.
3. **Build when `dist/` is missing or older than `HEAD`**, not only on first clone. This repairs D2.
4. **`--status --json`.** Print, for each pin: `sha`, `upstreamHead` (`git ls-remote <url> <track>`), `ahead`, `behind`, `isAncestorOfTrack`, and `surfaceHash` (SHA-256 over the `surface` files at the pin).
5. **`--drift`.** Fetch the track. For the `surface` files, print `git diff --stat <sha> <upstreamHead>`. Exit 3 when a surface file changed, 0 when only other files changed.
6. **Write `pins.lock.json`.** It records `sha`, `surfaceHash`, the probed `CapabilitySet`, and the date. The orchestration layer uses `surfaceHash` as its cache key (see the orchestration spec, section 4).
7. **`--check` also fails** when a `requires` capability is missing or when `isAncestorOfTrack` is false.

Decision needed (lead and user): move the toolkit pin to a commit on `main`. The surface files are the same, so the move has no code effect. Until the move, mirror `d009ae4` to a branch or tag in the toolkit repository so the host keeps it.

### 3.7 Harness manifest as an open set

`HARNESS_IDS` and `.length(HARNESS_IDS.length)` make a new harness a contract change in 3 files. The plan removes that for additions and keeps the lock for the 6 core entries.

1. Keep `HARNESS_IDS` as the *core* set. Keep the test that all 6 validate.
2. Change `harnessManifestSchema` from `.length(6)` to `.min(1)` with a rule "every core id appears once".
3. Add an optional `extensions` object on an entry: `Record<`x.${string}`, JsonTemplate>`. Unknown top-level keys stay errors (`strictObject`), so a typing error is still caught.
4. Add an optional `capabilities: CapabilityId[]` on an entry. The runner refuses an entry when a listed capability is missing and reports it in `HarnessPreflightResult.errors`.
5. Add an optional `manifestVersion: 1` at file level by changing the file to `{ "manifestVersion": 1, "harnesses": [...] }`. The loader accepts the bare array as version 0.
6. Replace the Zod 3 forms that React Doctor reports with the Zod 4 forms (`z.strictObject`, top-level string formats). This repairs D5.

Items 2 to 5 change locked files. They need lead approval as one contract change (ticket `LT-0.6`).

---

## 4. Work breakdown structure

Ticket ids are stable. "Owner" is the wave in the ownership matrix. "Gate" lists the commands that must pass. `G-base` means `bun run check`, `bun run typecheck:tsc`, `bun run test`. `G-ui` means `G-base`, `bun run build`, `bun run react-doctor` at 100, and the named Playwright spec.

### 4.0 Stage 0: stabilize the base (lead only, serial)

No delegate starts before this stage passes.

| Ticket | Work | Files | Gate |
|---|---|---|---|
| LT-0.1 | Repair `pins.ts` items 1–3 of section 3.6 | `scripts/pins.ts` | Fresh clone: `bun run pins` exits 0. Second run exits 0. `bun run pins:check` exits 0 |
| LT-0.2 | Toolkit pin decision. Mirror the SHA, or move the pin to `main` | `pins.json` | `pins --status --json` reports `isAncestorOfTrack: true` |
| LT-0.3 | Root CI. Move both workflows to `/.github/workflows/`. Add the pins step. Set `working-directory: global-sct` | `.github/workflows/*` | A push runs checks on 3 systems |
| LT-0.4 | Pin status, drift, and lock file (items 4–7 of section 3.6) | `scripts/pins.ts`, `pins.lock.json` | `--status --json` validates against its schema. `--drift` exits 3 on a synthetic surface change |
| LT-0.5 | Boundary types and schemas | `src/shared/boundary.ts`, `boundary-schemas.ts`, `agtop-type-check.ts` | `G-base`. One test per schema with a valid, a major-mismatch, and an unknown-field case |
| LT-0.6 | Manifest open set and Zod 4 forms (section 3.7) | `harness-manifest.ts`, `contracts.ts`, `harnesses.json`, `tests/harnesses.test.ts` | `G-base`. React Doctor 100 |
| LT-0.7 | Reconcile the task records (D4). Close C8d and Cream with evidence, or open follow-up features | `.agents/tasks/**` | Each task has `status` equal to the code state, and findings name commit `95013cd` |
| LT-0.8 | Refresh `.hallmark/preflight.json` and add log entries (D6, D7) | `.hallmark/*` | The file names `animejs`. The log lists the 5 unlogged screens |
| LT-0.9 | Resolve D15. Choose `job:sync` or `job:events` and record it in a comment | `ipc-channels.ts` | `G-base` |
| LT-0.10 | Write one precedence note at the top of `global-sct/AGENTS.md` for D16. Tests: override 1 applies. Schemas: Zod | `global-sct/AGENTS.md` | Review |

### 4.1 Track T: transport receipts and envelope verification

Depends on LT-0.7. Owner: existing global.sct sharing code. No ownership row covers it, so the lead assigns each ticket.

| Ticket | Work | Files | Depends | Gate |
|---|---|---|---|---|
| T-1 | Baseline record on Linux. Replace the Windows facts in `task-c8d-transport-receipt/context.json` | `.agents/tasks/task-c8d-transport-receipt/*` | LT-0.7 | Findings hold the 3 command results |
| T-2 | The 2 approved C8d tests: a device-ID round trip (`prepareEnvelope` → `previewEnvelope` → `acceptEnvelope` twice → `verifyEnvelopeReceipt`) and one receipt rejection case | `tests/sharing.test.ts` | T-1 | `G-base`. Exactly 2 new tests |
| T-3 | `direct-frame.ts` tests: split chunks, zero length, over-limit length, surplus bytes in a transfer body, wrapped key over 4,096 bytes | `tests/direct-frame.test.ts` (new) | T-1 | `G-base` |
| T-4 | Move per-kind limits into `FrameReader` so both transports share them. The reader rejects an over-limit length for the kind before it buffers the body | `src/main/direct-frame.ts`, `transport-hyperswarm.ts`, `transport-webrtc.ts` | T-3 | `G-base`. T-3 tests extended |
| T-5 | Common adapter. Define `DeliveryAdapter { availability; send; sendReceipt; close }` in `src/main/transport.ts`. Adapt Link, Hyperswarm, WebRTC, and Mailbox. No change to any wire format | `src/main/transport.ts`, 4 adapters | T-4 | `G-base`. `relay-connection.ts` has no new import from a Direct file, and Direct files import nothing from `relay*` |
| T-6 | Decision D9: keep the single-file layout and document it, **or** add `direct-outbox/<id>.json` for explicit retry. The plan needs retry, so the default is to add the outbox only | `transport-hyperswarm.ts`, `transport-webrtc.ts`, `docs/remaining-features-plan.md` | T-5 | `G-base`. Test: retry reuses the same transfer ID and digest and needs a new gate confirmation |
| T-7 | Receipt recovery. On restart after import and before receipt storage, rebuild the receipt from the completion metadata. Apply it to Link and Direct | `sharing.ts`, `vault.ts` (import completion metadata) | T-5 | `G-base`. Extend the existing recovery test in `sharing.test.ts` |
| T-8 | State rules. `received` never regresses. A valid late receipt moves `failed`, `manual`, or `expired` to `received` | `sharing.ts`, `transport-*.ts` | T-7 | `G-base`. One table-driven test |
| T-9 | Missing limits: two-minute transmission limit, 30-second incomplete-frame limit, WebRTC cap of 4 sessions | `transport-hyperswarm.ts`, `transport-webrtc.ts` | T-4 | `G-base`. Tests use an injected clock, no real waits |
| T-10 | `ShareGate` tests: wrong passphrase sends nothing, expiry, cancel, clear on lock, a second `confirm` during verification, queue limit | `tests/share-gate.test.ts` (new) | T-1 | `G-base` |
| T-11 | `readProtocolLink` tests and decision D8. Default: remove `sct://` to match the plan | `src/main/protocol.ts`, `tests/protocol.test.ts` (new) | T-1 | `G-base`. Rejects query, fragment, port, extra segment, and 16,385 characters |
| T-12 | `PendingReceipts.tsx` and the activity list. One row identity `(mode, transferId, recipientDeviceId)`. The 6 states and their actions from the plan table. A pasted receipt accepts Link and Direct records | `PendingReceipts.tsx`, `SharingView.tsx`, `DirectSharing.tsx`, `LinkSharing.tsx`, `src/shared/direct.ts` | T-8 | `G-ui` with `sharing.spec.ts` |
| T-13 | Playwright two-window Link transfer with a manual receipt on Linux. Guard AirDrop assertions with `darwin` | `tests/sharing.spec.ts` | T-12 | `bun run test:ui` passes on Linux |
| T-14 | Manual checks V4–V10 on 2 machines. Record OS, architecture, commit, package hash, transport, result | `docs/secure-sharing-check.md` | T-9, P-4 | Evidence table complete. No link, SDP, or credential in the log |
| T-15 | Update `docs/sharing.md`, `relay.md`, `architecture.md` for the adapter, recovery, and the TURN exception | docs | T-14 | Review |

Parallel groups: {T-2, T-3, T-10, T-11} have no shared file. T-4 → T-5 → {T-6, T-7, T-9} → T-8 → T-12 is serial because the transport files are shared.

### 4.2 Track V: VS Code extension

Depends on Stage 0 only. It has no relay dependency and must keep none.

| Ticket | Work | Files | Depends | Gate |
|---|---|---|---|---|
| V-1 | Approve `docs/vscode-panel-plan.md` phase 1. It is a proposal today | Decision | — | User approval recorded in the task |
| V-2 | Activity Bar container `sct`. Move `sct.secrets` out of the Explorer. Add `viewsWelcome` for "no folder" and "no project" | `packages/vscode/package.json`, `extension.ts` | V-1 | `bun run build:vscode`, `G-base` |
| V-3 | `sct.startApp`, `sct.focusView`, status bar item, view description | `extension.ts`, `sct.ts` | V-2 | Same. Every CLI child removes `ELECTRON_RUN_AS_NODE` |
| V-4 | `sct.cliPath` setting. Order: setting, `SCT_CLI`, `sctExecutable()` | `package.json`, `sct.ts`, `packages/env/src/executable.ts` (1C owns it; lead approval) | V-2 | `build:sdk` and `build:vscode` pass |
| V-5 | Tree item context values and an empty state. Names and IDs only | `secrets.ts` | V-2 | Review: no value field in any type the extension reads |
| V-6 | Extension tests with `@vscode/test-electron`: activation, the 5 commands exist, the tree shows fixture metadata from a fake `sct` executable | `packages/vscode/test/**`, root `package.json` (lead) | V-3, V-5 | New script `test:vscode` passes on Linux |
| V-7 | VSIX build with `@vscode/vsce`. Add the artifact to the release workflow | `package.json` (lead), `.github/workflows/release.yml` | V-6, LT-0.3 | The VSIX installs in VS Code 1.145 |
| V-8 | Live check V14: 2 terminals, only the requested one has the project environment. Locked vault. No folder. No matching project. Relay off | `docs/vscode.md` | V-7 | Evidence recorded |
| V-9 | Lemon Tree surface in the editor (after Wave 3): read-only job list through `sct agent`. Out of scope until Wave 3 passes | — | W3 | Deferred |

### 4.3 Track U: UI and theme polish

| Ticket | Work | Files | Depends | Gate |
|---|---|---|---|---|
| U-1 | Verify the Cream polish that is already in `styles.css` against each FEAT-002 acceptance line. Compute the contrast ratios again and record them | `.agents/tasks/task-cream-theme-polish/features/FEAT-002.json` | LT-0.7 | Findings complete |
| U-2 | The approved theme test passes on Linux | `tests/theme.spec.ts` | U-1 | Playwright `theme.spec.ts` |
| U-3 | `docs/theme.md` contrast table matches the tokens. Add the "Input border on paper" rows | `docs/theme.md` | U-1 | Review against computed values |
| U-4 | Regenerate the Cream **and** Terminal screenshots. The Terminal set still shows the old tab and border style | `docs/media/themes/**` | U-2 | 1200×800, synthetic data |
| U-5 | New-screen evidence (item 4.6): Direct, WebRTC connection link, receipt, link registration, share gate. Both variants | `docs/media/themes/**`, `docs/theme.md` | T-12 | 10 screenshots |
| U-6 | Token audit. No literal color or font family outside the token blocks. No radius, shadow, or new hue | `src/renderer/src/styles.css`, `*.tsx` | U-1 | A grep script reports 0 matches outside `:root` blocks |
| U-7 | Keyboard and reduced-motion pass on all sharing screens (V13) | Renderer | T-12 | Manual check recorded. Focus is visible immediately |
| U-8 | A portable smoke spec. `platform.spec.ts` skips outside Windows, so Linux has no smoke test | `tests/platform.spec.ts` (needs approval, it changes a test) | U-2 | The spec passes on Linux and Windows |
| U-9 | Lemon Tree panes (Wave 3) use the same tokens. Hallmark preflight before each pane | Wave 3 files | LT-0.8 | `G-ui` for each pane |

### 4.4 Track P: packaging, signing, CLI, and environment injection

| Ticket | Work | Files | Depends | Gate |
|---|---|---|---|---|
| P-1 | Stage agtop and its native dependency. Read the dependency closure from the lockfile instead of a fixed list | `scripts/stage-dependencies.ts` | LT-0.1 | The packaged app starts and `listAgentTrees()` returns on each system |
| P-2 | Linux package check. Native-load check for keyring, Hyperswarm, and `koffi` | `scripts/package-linux.ts` | P-1 | `bun run package:linux` passes. The packaged `sct --version` exits 0 |
| P-3 | Windows MCP client path (item 1.6). Document `sct.exe` for direct MCP clients, or write a second shim | `scripts/install-cli.ts`, `docs/windows-linux.md` | — | `tests/runtime.test.ts` installer test passes |
| P-4 | Protocol registration checks V1–V3 on 3 systems in packaged builds | `protocol-registration.ts`, `package-*.ts` | T-11, P-2 | Evidence recorded |
| P-5 | macOS: build `native/airdrop.swift`, package, and check `CFBundleURLTypes` | `scripts/build-airdrop.ts`, `package-macos.ts` | LT-0.3 | The macOS runner passes `package:mac` with `SCT_SIGN=adhoc` |
| P-6 | Signing (fork decision D12, deferred). Prepare only: read credentials from CI secrets, fail closed when absent, never mark an unsigned build as signed | `package-*.ts`, `release.yml`, signing docs | D12 answer | A dry run with no secret produces an unsigned artifact with the unsigned label |
| P-7 | `@sct/env` extension for Wave 1C: `loadJobEnv({ jobId })` reads the ephemeral boot environment through `sct _env`. No value is written to disk | `packages/env/src/*` | W1C | `build:sdk`. A runtime test with the real vault |
| P-8 | `sct` CLI commands for the control plane: `sct job`, `sct daemon`. Parse and exclude them before the desktop single-instance lock | `src/main/index.ts` | W2B | The runtime tests still pass. A CLI launch does not open a window |
| P-9 | Release workflow: checksums, the VSIX, and a pin report (`pins --status --json`) attached to each beta | `release.yml` | LT-0.4, V-7 | A beta tag produces all artifacts |
| P-10 | Caller identity follow-up: Windows certificate thumbprint pin. Linux stays unverified | `src/main/caller.ts` | — | Needs the concrete failure mode and user buy-in first (project rule) |

### 4.5 Track W: Lemon Tree control-plane waves

These are the largest missing part. Each wave owns its tests (override 1).

| Ticket | Wave | Work | Depends | Gate |
|---|---|---|---|---|
| W1A-1 | 1A | `agtop-adapter.ts`, `capabilities.ts`: dynamic import, schema validation, the degradation table | LT-0.5 | `G-base`. Tests with the real agtop and with a stub module that lacks 2 functions |
| W1A-2 | 1A | `classifyPrompt` in TypeScript: prompt → `PromptIntent` with evidence strings | LT-0.5 | Table-driven test, 20 prompts |
| W1A-3 | 1A | `toolkit-adapter.ts`: start `select_target.py` with `--json`, 5-second limit, no shell. Fall back to the manifest heuristic | W1A-1 | Tests: script present, script absent, bad JSON, timeout |
| W1A-4 | 1A | `process-bridge.ts`: compose the `ProcessBridge` interface | W1A-1..3 | `G-base` |
| W1B-1 | 1B | `worktree-manager.ts`: create, auto-commit, diff summary, merge, discard, open in editor | LT-0.5 | Tests on a temporary real repository. No mock of git |
| W1C-1 | 1C | `vault-mcp.ts`: Streamable HTTP on 127.0.0.1, one path per job, `getScopedSecret`, memory, audit log | LT-0.5 | Tests with the real vault. A wrong job path gets no secret |
| W1C-2 | 1C | `buildEphemeralBootEnv`: resolve `{secret:NAME}` in memory only | W1C-1 | Test: no secret value in any file under the job folder |
| W1D-1 | 1D | `lemonade-service.ts`: probe, state, start, stop, metrics | W1A-1 | Tests against a local fake HTTP server on a random port |
| W2A-1 | 2A | Template engine for the manifest: placeholders, `{ json }` values, deep merge of env templates | LT-0.6 | Table-driven tests for all 6 entries |
| W2A-2 | 2A | `acp-runner.ts`: preflight, ACP stdio session, headless fallback, permission flow, cancel | W1A-4, W1B-1, W1C-2, W2B-1 | Tests with a scripted fake ACP agent process. No dependency on client `fs/*` or `terminal/*` |
| W2A-3 | 2A | `context-bridge.ts`: instruction file, cross-harness context, handoff compaction with a deterministic fallback | W2B-1 | Token-estimate test under 500 |
| W2B-1 | 2B | `db.ts`: `JobStore` with the sqlite index and `events.ndjson` in envelopes | LT-0.5 | Tests: index order, restart, a damaged line is skipped |
| W2B-2 | 2B | `remote-dispatcher.ts`, `mesh/**`: peers, dispatch inside the sealed envelope, job and thread sync | W2B-1, T-5 | Tests: `ephemeralBootEnv` never reaches the store or the log |
| W2B-3 | 2B | `daemon-entry.ts`: headless entry for a peer | W2B-2 | A daemon accepts and rejects one job |
| W3-1 | 3 | The 28 handlers and the 6 push events in `index.ts` and preload | W1*, W2* | `G-base`. A type test: every channel has a handler |
| W3-2..8 | 3 | One ticket per pane, in this order: `HarnessStudioPane`, `ProjectHistorySidebar`, `PermissionModal`, `WorktreeDiffPane`, `SubagentProcessDrawer`, `VaultDrawer`, `PeerMeshDrawer` | W3-1, LT-0.8 | `G-ui` with one Playwright spec per pane |

### 4.6 Track Q: test coverage

Coverage tickets that do not belong to one feature.

| Ticket | Work | Gate |
|---|---|---|
| Q-1 | Add every new unit test file to the `test` script. The script lists files by name, so a new file is silent until it is added (lead, `package.json`) | `bun run test` runs the new files |
| Q-2 | Playwright on Linux in CI with `xvfb-run`. Unset `ELECTRON_RUN_AS_NODE` in the job | The `ubuntu-latest` job runs `app.spec.ts`, `sharing.spec.ts`, `theme.spec.ts` |
| Q-3 | The 2 recorded Windows failures: use the Electron executable for the CLI checks in `app.spec.ts`, and guard the AirDrop assertions in `sharing.spec.ts`. Both are test changes and need approval | The Windows job passes 5 of 5 |
| Q-4 | A boundary test suite: each schema in `boundary-schemas.ts` against a recorded real sample from agtop at the pin (`tests/fixtures/agtop-<sha>/`) | A pin move that changes a shape fails this suite by name |
| Q-5 | A contract test: `Equal<>` assertions for every schema and type pair | `typecheck:tsc` |
| Q-6 | A drift test in CI: `pins --drift` on a schedule. Exit 3 opens an issue | A weekly job |
| Q-7 | A no-secrets test: after each job test, scan the job folder, the sqlite file, and the logs for the synthetic secret value | 0 matches |

### 4.7 Order and critical path

```
Stage 0 (LT-0.1 → 0.2 → 0.4 → 0.5 → 0.6; 0.3, 0.7–0.10 in parallel)
   ├── Track T: {T-2,T-3,T-10,T-11} → T-4 → T-5 → {T-6,T-7,T-9} → T-8 → T-12 → T-13 → T-14 → T-15
   ├── Track V: V-1 → V-2 → {V-3,V-4,V-5} → V-6 → V-7 → V-8
   ├── Track U: U-1 → {U-2,U-3,U-6} → U-4 ; U-5,U-7 after T-12
   ├── Track P: P-1 → P-2 → P-4 ; P-3,P-5 any time ; P-9 after V-7
   └── Track W: {W1A,W1B,W1C,W1D,W2B-1,W2A-1} → W2A-2,W2A-3,W2B-2 → W2B-3 → W3-1 → W3-2..8
```

The critical path is LT-0.1 → LT-0.5 → W1A → W2A-2 → W3-1 → the panes.
Tracks T, V, U, and P have no dependency on Track W except P-7, P-8, U-9, and V-9.
Local Agent Access and the editor keep no relay dependency in any ticket.

### 4.8 Decisions the user must make

The project rule is "do not make decisions for yourself". These choices block the tickets shown.

| # | Decision | Recommended | Blocks |
|---|---|---|---|
| 1 | Toolkit pin: mirror the orphaned SHA, or move to `main` | Move to `main`. The surface files are the same | LT-0.2 |
| 2 | agtop pin: stay, or move 9 commits | Move. Only `src/mcp.ts` changed | LT-0.2 |
| 3 | `sct://` alias (D8) | Remove it | T-11 |
| 4 | Direct record layout (D9) | Keep single files, add the outbox only | T-6 |
| 5 | Manifest open set (section 3.7) | Approve | LT-0.6 |
| 6 | VS Code panel proposal | Approve phase 1 | V-1 |
| 7 | Test changes for the 2 Windows failures and the portable smoke spec | Approve | Q-3, U-8 |
| 8 | Which channel stays: `job:sync` or `job:events` | Keep `job:sync`, remove `job:events` | LT-0.9 |
| 9 | Signing credentials (fork D12) | Stay deferred | P-6 |
