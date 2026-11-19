# Lemon Tree: multi-agent orchestration architecture

Date: 2026-11-14. Workspace commit: `95013cd`. Author role: planner.
This document specifies how the work in [completion-plan.md](completion-plan.md) is executed by three tiers of agents.
It changes no product code. The scripts in this document are specifications for tickets `ORC-1` to `ORC-6` (section 8).

---

## 0. Facts about the runtime (checked on 2026-11-14)

These facts come from the live `orchestrator_capabilities` result and the installed tools. They are not assumptions.

| Item | Fact |
|---|---|
| Lead model | `claude-opus-5-5` on provider `claudeAgent`. Effort values: `low` to `max`, `ultracode`, `ultrathink` |
| Antigravity models | **Only `gemini-3.8-flash`** (`thinking_level`: `low`, `medium`, `high`). `gemini-4-hydrogen` is **not** in the Antigravity catalog today |
| Gemini 4 Hydrogen | Available only as `opencode/gemini-4-hydrogen` on the `opencode` provider. That is a different runtime from Antigravity |
| Antigravity runtime modes | `approval-required`, `auto-accept-edits`, `full-access`. **No read-only mode exists** |
| Coding model | `opencode-go/deepseek-v4.1-flash` on provider `opencode`. `variant`: `low`, `high`, `max` |
| OpenCode CLI | 2.3.0. `opencode run` has `--model provider/model#variant`, `--agent`, `--format json`. `opencode acp` exists |
| Toolkit scripts at the pin | `select_target.py`, `verify_unit.py`, `record_verification.py`, `plan.schema.json`, `routing-policy.json` |
| Local skills | `subagent-orchestrator`, `offpeak-scheduler`, `agtop`, `compat-matrix`, `worktree-janitor`, `secret-preflight` |

Consequences:

1. The preferred research model is unavailable in the required runtime. The fallback rule applies now. All research slots bind to `antigravity:gemini-3.8-flash`.
2. Read-only access for research agents cannot be a setting. It must be enforced by containment and checked after each run (section 2.3).
3. Each DeepSeek launch must pass the `offpeak-scheduler` gate first (user rule).
4. The session role file routes implementation to `codex:gpt-6-luna`. This specification overrides that for this project, because the user named OpenCode Go. To make the override permanent, set a project role with the `session-kickoff` skill.

---

## 1. Topology and role separation

```
                         ┌──────────────────────────────────────────────┐
                         │ Tier 1  Lead orchestrator  claude-opus-5-5   │
                         │ decomposition · state machine · contracts    │
                         │ adjudication · conflict resolution · merge   │
                         └───────┬───────────────────────────┬──────────┘
              research brief     │                           │   FEAT ticket + context
        ┌────────────────────────▼─────────┐      ┌──────────▼────────────────────────┐
        │ Tier 2  Research (untrusted)     │      │ Tier 3  Coding (bounded)          │
        │ Antigravity                      │      │ OpenCode Go                       │
        │ gemini-4-hydrogen → 3.8-flash    │      │ deepseek-v4.1-flash               │
        │ detached read-only worktree      │      │ one ticket, one git worktree      │
        └────────────────┬─────────────────┘      └──────────┬────────────────────────┘
          claim packet   │                                   │  diff on agent/<task>/<feat>
        ┌────────────────▼─────────────────┐      ┌──────────▼────────────────────────┐
        │ Gate R  deterministic pre-filter │      │ Gate C  verification harness      │
        │ scripts/orc/verify-claims.ts     │      │ scripts/orc/verify-ticket.ts      │
        └────────────────┬─────────────────┘      └──────────┬────────────────────────┘
                         └───────────► Lead adjudication ◄───┘
```

No agent in Tier 2 or Tier 3 talks to another agent. Every handoff passes through a deterministic gate and then the lead.

### 1.1 Tier 1: lead orchestrator (`claude-opus-5-5`)

The lead owns, and never delegates:

- Task decomposition and the dependency order in `completion-plan.md`.
- Every state transition in `.agents/tasks/` (section 5).
- The locked files: `src/shared/contracts.ts`, `acp-types.ts`, `ipc-channels.ts`, `harness-manifest.ts`, `harnesses.json`, `package.json`, `tsconfig*.json`, `src/main/agtop-type-check.ts`, `pins.json`, `scripts/pins.ts`.
- Trust decisions: which research claims are accepted, and which diffs are merged.
- Conflict resolution when agtop, global.sct, and the toolkit disagree (section 1.4).
- Final merge approval. The lead reads every diff. It rejects placeholder tests and tests that repeat the implementation.

The lead does not write feature code. It can fix small review findings (role rule `parent_codes = small-fixes-only`).

### 1.2 Tier 2: untrusted research agents (Antigravity)

Permitted: read files in its worktree, search the web and documentation, inspect syntax trees, and analyze dependency graphs.
Forbidden: write a file, commit, push, read a secret, start `sct`, attach the vault MCP server, decide, plan, or write code for the product.

A research agent returns one JSON claim packet as its final message. It writes no file. The lead's harness stores the packet.

### 1.3 Tier 3: coding agents (OpenCode Go, `deepseek-v4.1-flash`)

One worker gets one `FEAT-*.json` ticket in one git worktree on branch `agent/<task-id>/<feat-id>`.
It can edit only paths that match the ticket's `scope.allow` globs.
It cannot change a locked file unless the ticket has an `unlocks` entry that the lead wrote (section 3.5).
It cannot push, merge, change a pin, or start another agent.

### 1.4 Conflict resolution order

When sources disagree, the lead uses this order. A lower row never overrides a higher row.

1. Code and tests at the pinned commit (`pins.lock.json`).
2. `src/shared/contracts.ts` and the other locked files.
3. `global-sct/AGENTS.md` overrides 1 to 6, then the workspace `AGENTS.md`.
4. A claim marked `VERIFIED_IN_CODE` that passed Gate R.
5. Plan documents in `global-sct/docs/`.
6. A claim marked `INFERRED_FROM_DOCS` or `EXTERNAL_SPEC_ASSUMPTION`. These never justify a contract change alone.

When rows 1 and 2 disagree, the contract is wrong for that pin. The lead opens a contract-change ticket. No delegate "fixes" the contract.

---

## 2. Research tier: routing, sandbox, and zero-trust verification

### 2.1 Model selection logic

The lead runs this once at session start, and again after a provider error.

```ts
// scripts/orc/route-research.ts  (specification)
type Caps = { providers: { providerInstanceId: string; canRunChildTask: boolean; constraints: string[];
  models: { id: string }[] }[] }
type ResearchRoute = { providerInstanceId: 'antigravity'; model: string; options: { thinking_level: 'high' };
  reason: 'preferred' | 'fallback-not-listed' | 'fallback-rate-limited'; boundAt: number }

const PREFERRED = 'gemini-4-hydrogen'
const FALLBACK = 'gemini-3.8-flash'

export function routeResearch(caps: Caps, rateLimitedUntil: number | null, now: number): ResearchRoute {
  const antigravity = caps.providers.find(p => p.providerInstanceId === 'antigravity')
  if (!antigravity?.canRunChildTask || antigravity.constraints.length > 0) throw new Error('research-tier-unavailable')
  const ids = new Set(antigravity.models.map(m => m.id))
  if (!ids.has(FALLBACK) && !ids.has(PREFERRED)) throw new Error('research-tier-unavailable')
  const base = { providerInstanceId: 'antigravity' as const, options: { thinking_level: 'high' as const }, boundAt: now }
  if (!ids.has(PREFERRED)) return { ...base, model: FALLBACK, reason: 'fallback-not-listed' }
  if (rateLimitedUntil !== null && now < rateLimitedUntil) return { ...base, model: FALLBACK, reason: 'fallback-rate-limited' }
  return { ...base, model: PREFERRED, reason: 'preferred' }
}
```

Rules:

- The capability query uses `search: "hydrogen"` as well as the short list, because the short list can omit models.
- All research slots in one session use one model. The lead binds again only at a session start, after a rate-limit window ends, or after an error.
- A rate limit on the preferred model sets `rateLimitedUntil` from the provider's reset time. A rate limit on the fallback stops research and schedules one retry after the reset. The lead tells the user. It does not move research to another provider (role rule `on_provider_limit = wait-and-reschedule`).
- `research-tier-unavailable` stops research. It never routes research to the coding tier or to the lead's own provider without a user decision.
- `opencode/gemini-4-hydrogen` is **not** used. It is outside the Antigravity runtime. Using it is a user decision (section 9, item 1).

Routing config file, read by the script and written by the lead:

```json
{
  "schema": 1,
  "file": ".agents/orchestration/routing.json",
  "lead": { "providerInstanceId": "claudeAgent", "model": "claude-opus-5-5", "options": { "effort": "high" } },
  "research": {
    "providerInstanceId": "antigravity",
    "prefer": ["gemini-4-hydrogen"],
    "fallback": ["gemini-3.8-flash"],
    "options": { "thinking_level": "high" },
    "runtimeMode": "approval-required",
    "isolation": "worktree",
    "maxParallel": 4,
    "onRateLimit": "fallback-then-wait",
    "forbiddenProviders": ["opencode", "codex", "cursor", "claudeAgent"]
  },
  "coding": {
    "providerInstanceId": "opencode",
    "model": "opencode-go/deepseek-v4.1-flash",
    "options": { "variant": "high" },
    "repairOptions": { "variant": "max" },
    "runtimeMode": "auto-accept-edits",
    "isolation": "worktree",
    "maxParallel": 3,
    "gate": "offpeak-scheduler"
  },
  "bound": { "researchModel": "gemini-3.8-flash", "reason": "fallback-not-listed", "boundAt": "2026-11-14" }
}
```

### 2.2 Research brief

Each research task is one question with a fixed output schema. The brief contains: the question, the commit and pin SHAs to read, the paths in scope, the claim schema, and this fixed text:

> You are a research worker. You have read access only. Do not create, edit, or delete any file. Do not run git commands that write. Do not read or ask for secrets. Do not propose a design or write product code. Return one JSON object that matches the schema, and nothing else. Every claim needs evidence. A claim without a file path, a line range, and the exact text of those lines is discarded by a script before a human or the lead reads it. If you cannot verify a statement in the code, mark it `INFERRED_FROM_DOCS` or `EXTERNAL_SPEC_ASSUMPTION`. A wrong label is worse than no claim.

### 2.3 Sandbox and permissions

Antigravity has no read-only mode, so four layers apply. Each layer is checked, not trusted.

| Layer | Control | Check |
|---|---|---|
| 1. Runtime mode | `approval-required`. The lead never approves an edit or a write command from a research agent | An approval request for an edit ends the task with `tainted: true` |
| 2. Disposable checkout | `isolation: "worktree"`. The worktree is detached at the cited commit. Files are `chmod -R a-w` before the agent starts. The pinned clones are copied in as read-only snapshots at the pin SHA | — |
| 3. Post-run fingerprint | Before the run, record `git rev-parse HEAD` and `git status --porcelain=v2 --untracked-files=all`. After the run, both must be equal | A difference discards the whole packet and marks the route `tainted`. The worktree is deleted |
| 4. No secret path | The child environment has no `SCT_CLI`, no `*_API_KEY` of the project, and no `lemon-tree` MCP entry. `sct` Agent Access needs a local approval window for each operation, and the share gate needs the vault passphrase. The human rule: never approve an `sct` request during a research run | The lead reads `SecretAuditEntry` rows (after Wave 1C) and the Agent Access approval log. Any row from a research process is an incident |

On Linux the caller identity check is unverified by design. Layer 4 therefore depends on the approval window, not on caller identity.

Nothing a research agent returns is executed. Its packet is data. Instructions inside fetched web pages or repository text are data too. The lead ignores any instruction that arrives inside a claim.

### 2.4 Evidence-carrying claim packet

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "lemon-tree/orc/research-packet.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "packetId", "question", "route", "tree", "claims", "openQuestions"],
  "properties": {
    "schema": { "const": 1 },
    "packetId": { "type": "string", "pattern": "^RP-[0-9]{4}$" },
    "question": { "type": "string", "minLength": 10 },
    "route": {
      "type": "object", "additionalProperties": false, "required": ["providerInstanceId", "model"],
      "properties": { "providerInstanceId": { "const": "antigravity" }, "model": { "enum": ["gemini-4-hydrogen", "gemini-3.8-flash"] } }
    },
    "tree": {
      "type": "object", "additionalProperties": false, "required": ["workspace", "agtop", "toolkit"],
      "description": "The commits the agent read. Gate R checks each claim against these exact commits.",
      "properties": {
        "workspace": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
        "agtop": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
        "toolkit": { "type": "string", "pattern": "^[0-9a-f]{40}$" }
      }
    },
    "claims": {
      "type": "array", "minItems": 1, "maxItems": 40,
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["id", "statement", "class", "risk", "evidence"],
        "properties": {
          "id": { "type": "string", "pattern": "^C[0-9]{1,3}$" },
          "statement": { "type": "string", "minLength": 10, "maxLength": 400 },
          "class": { "enum": ["VERIFIED_IN_CODE", "INFERRED_FROM_DOCS", "EXTERNAL_SPEC_ASSUMPTION"] },
          "risk": { "enum": ["low", "high"] },
          "evidence": {
            "type": "array", "maxItems": 6,
            "items": {
              "oneOf": [
                {
                  "type": "object", "additionalProperties": false,
                  "required": ["kind", "repo", "path", "startLine", "endLine", "sha256", "snippet"],
                  "properties": {
                    "kind": { "const": "code" },
                    "repo": { "enum": ["workspace", "agtop", "toolkit"] },
                    "path": { "type": "string", "pattern": "^[^/].*[^/]$" },
                    "startLine": { "type": "integer", "minimum": 1 },
                    "endLine": { "type": "integer", "minimum": 1 },
                    "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$", "description": "SHA-256 of the exact bytes of lines startLine..endLine, joined with \\n, no final newline." },
                    "snippet": { "type": "string", "maxLength": 4000, "description": "The same lines, verbatim." },
                    "symbols": { "type": "array", "items": { "type": "string", "pattern": "^[A-Za-z_$][A-Za-z0-9_$.]*$" }, "maxItems": 8 }
                  }
                },
                {
                  "type": "object", "additionalProperties": false,
                  "required": ["kind", "url", "retrievedAt", "quote"],
                  "properties": {
                    "kind": { "const": "external" },
                    "url": { "type": "string", "pattern": "^https://" },
                    "retrievedAt": { "type": "string", "format": "date" },
                    "quote": { "type": "string", "maxLength": 1000 }
                  }
                }
              ]
            }
          },
          "dependsOn": { "type": "array", "items": { "type": "string", "pattern": "^C[0-9]{1,3}$" } }
        }
      }
    },
    "openQuestions": { "type": "array", "items": { "type": "string" } }
  }
}
```

Class rules, enforced by Gate R:

| Class | Required evidence | What it can support |
|---|---|---|
| `VERIFIED_IN_CODE` | At least one `code` item that passes every check | A ticket's `contracts` and `steps` |
| `INFERRED_FROM_DOCS` | At least one `code` item whose path ends in `.md`, or is under `docs/` | A question for the lead. Never a contract |
| `EXTERNAL_SPEC_ASSUMPTION` | At least one `external` item | A risk note in a ticket. Never a step |

### 2.5 Gate R: deterministic pre-filter

The script runs before the lead reads a packet. It uses git objects at the cited commits, so the working tree cannot change the result. It needs no model and no network.

```ts
#!/usr/bin/env bun
// scripts/orc/verify-claims.ts  (specification)
// Usage: bun scripts/orc/verify-claims.ts <packet.json> --out <verified.json>
// Exit 0: packet structurally valid (claims may still be rejected). Exit 2: packet unusable.
import { $ } from 'bun'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

type Code = { kind: 'code'; repo: 'workspace' | 'agtop' | 'toolkit'; path: string; startLine: number; endLine: number
  sha256: string; snippet: string; symbols?: string[] }
type External = { kind: 'external'; url: string; retrievedAt: string; quote: string }
type Claim = { id: string; statement: string; class: 'VERIFIED_IN_CODE' | 'INFERRED_FROM_DOCS' | 'EXTERNAL_SPEC_ASSUMPTION'
  risk: 'low' | 'high'; evidence: (Code | External)[]; dependsOn?: string[] }
type Verdict = { id: string; verdict: 'pass' | 'downgraded' | 'rejected'; class: Claim['class']; reasons: string[] }

const root = resolve(import.meta.dir, '../..')
const repoDir = { workspace: root, agtop: resolve(root, 'agtop'), toolkit: resolve(root, 'subagentclassifiertoolkit') }
const packet = await Bun.file(Bun.argv[2]!).json()
const lock = await Bun.file(resolve(root, 'pins.lock.json')).json()

// 1. Structure. The JSON Schema in section 2.4 is compiled into validatePacket().
const structural = validatePacket(packet)
if (structural.length > 0) fail(2, structural)

// 2. The packet must describe the tree that is pinned now. A stale tree is not an error of the agent;
//    it means the pins moved during the run, so the packet is re-queued, not judged.
if (packet.tree.agtop !== lock.agtop.sha || packet.tree.toolkit !== lock.subagentclassifiertoolkit.sha) fail(3, ['stale-pins'])
if ((await $`git -C ${root} cat-file -t ${packet.tree.workspace}`.nothrow().text()).trim() !== 'commit') fail(2, ['unknown-workspace-commit'])

const commitOf = { workspace: packet.tree.workspace, agtop: packet.tree.agtop, toolkit: packet.tree.toolkit }
const verdicts: Verdict[] = []
for (const claim of packet.claims as Claim[]) verdicts.push(await judge(claim))

// 6. A claim that depends on a rejected claim is rejected. Repeat until nothing changes.
for (let changed = true; changed;) {
  changed = false
  for (const claim of packet.claims as Claim[]) {
    const own = verdicts.find(v => v.id === claim.id)!
    if (own.verdict !== 'rejected' && (claim.dependsOn ?? []).some(id => verdicts.find(v => v.id === id)?.verdict !== 'pass')) {
      own.verdict = 'rejected'; own.reasons.push('depends-on-unverified-claim'); changed = true
    }
  }
}
await Bun.write(Bun.argv[4]!, JSON.stringify({ schema: 1, packetId: packet.packetId, tree: packet.tree, verdicts,
  passRate: verdicts.filter(v => v.verdict === 'pass').length / verdicts.length }, null, 2))

async function judge(claim: Claim): Promise<Verdict> {
  const reasons: string[] = []
  const code = claim.evidence.filter((e): e is Code => e.kind === 'code')
  for (const item of code) reasons.push(...await checkCode(item))
  if (reasons.length > 0) return { id: claim.id, verdict: 'rejected', class: claim.class, reasons }
  // 5. Class rules. A wrong label is downgraded, never upgraded.
  const docsOnly = code.length > 0 && code.every(e => e.path.endsWith('.md') || e.path.includes('docs/'))
  if (claim.class === 'VERIFIED_IN_CODE' && (code.length === 0 || docsOnly)) {
    return { id: claim.id, verdict: 'downgraded', class: code.length === 0 ? 'EXTERNAL_SPEC_ASSUMPTION' : 'INFERRED_FROM_DOCS',
      reasons: ['label-stronger-than-evidence'] }
  }
  if (claim.class === 'EXTERNAL_SPEC_ASSUMPTION' && !claim.evidence.some(e => e.kind === 'external')) {
    return { id: claim.id, verdict: 'rejected', class: claim.class, reasons: ['no-external-source'] }
  }
  return { id: claim.id, verdict: 'pass', class: claim.class, reasons }
}

async function checkCode(item: Code): Promise<string[]> {
  // 3a. Path safety: relative, no "..", no absolute path, tracked at the cited commit.
  if (item.path.startsWith('/') || item.path.split('/').includes('..')) return [`unsafe-path:${item.path}`]
  const blob = await $`git -C ${repoDir[item.repo]} show ${commitOf[item.repo]}:${item.path}`.nothrow().quiet()
  if (blob.exitCode !== 0) return [`no-such-file:${item.repo}:${item.path}`]
  // 3b. Line range exists.
  const lines = blob.stdout.toString('utf8').split('\n')
  if (item.endLine < item.startLine || item.endLine > lines.length) return [`line-range-out-of-file:${item.path}:${item.startLine}-${item.endLine}`]
  // 3c. The cited bytes hash to the cited value, and the snippet is those bytes.
  const text = lines.slice(item.startLine - 1, item.endLine).join('\n')
  const out: string[] = []
  if (createHash('sha256').update(text).digest('hex') !== item.sha256) out.push(`hash-mismatch:${item.path}`)
  if (text !== item.snippet) out.push(`snippet-mismatch:${item.path}`)
  // 4. Every named symbol is declared or used as an identifier inside the cited range.
  for (const symbol of item.symbols ?? []) {
    const name = symbol.split('.').at(-1)!
    if (!new RegExp(`(^|[^A-Za-z0-9_$])${name.replace('$', '\\$')}([^A-Za-z0-9_$]|$)`).test(text)) out.push(`symbol-not-in-range:${symbol}`)
  }
  return out
}

function fail(code: number, reasons: string[]): never { console.error(JSON.stringify({ reasons })); process.exit(code) }
declare function validatePacket(value: unknown): string[]
```

Gate R outcomes:

| Result | Action |
|---|---|
| Exit 2 | The packet is discarded. One retry with the same brief plus the structural errors. A second exit 2 is recorded as a route failure |
| Exit 3 (`stale-pins`) | The packet is put back in the queue after the pin protocol in section 4. No retry counter changes |
| `passRate` below 0.6 | The whole packet is discarded. A model that invents 40% of its citations is not a source for the other 60% |
| `passRate` 0.6 or more | Only `pass` claims go forward. `downgraded` claims go forward with the weaker class. `rejected` claims are logged with their reasons and never shown to the lead as facts |

What Gate R proves: the cited text exists at the cited commit. What it does not prove: that the statement follows from the text. That is the lead's job in Gate A.

### 2.6 Dual-agent cross-check

A research task is high-risk when its question touches one of these:

- agtop type compatibility: `agtop/src/types.ts`, `agtop/src/index.ts`, `src/main/agtop-type-check.ts`, `src/shared/contracts.ts`.
- Toolkit routing: `select_target.py`, `routing-policy.json`, `plan.schema.json`.
- global.sct cryptographic flows: `envelope.ts`, `seal.ts`, `transfer.ts`, `sharing.ts`, `share-gate.ts`, `direct-frame.ts`, `transport-*.ts`, `connect-link.ts`, `vault*.ts`, `key-store.ts`.
- Any claim that would change a locked file.

For a high-risk task the lead starts two independent sessions. Neither sees the other's brief or output.

| | Session A: constructive | Session B: adversarial |
|---|---|---|
| Prompt frame | "Describe how X works. Cite each step." | "Find where the statement 'X works as documented' is false. Cite each counterexample. If you find none, list what you checked." |
| Entry point | Starts from the public interface and reads inward | Starts from call sites, tests, and error paths and reads outward |
| Paths in scope | The module and its imports | The module's callers and its tests |

Both sessions use the bound research model. Two models would be better for independence, and only one is available in the Antigravity runtime today. The orthogonal prompts and entry points are the independence mechanism. When `gemini-4-hydrogen` is listed in Antigravity, session B uses the other model.

The diff is deterministic (`scripts/orc/diff-claims.ts`):

1. Both packets pass Gate R first. Only `pass` and `downgraded` claims take part.
2. Two claims *overlap* when they cite the same `repo` and `path` and their line ranges intersect.
3. Each claim gets one status:

| Status | Condition | Effect |
|---|---|---|
| `corroborated` | Overlaps a claim from the other session, and the lead marks the statements as compatible | Usable |
| `contested` | Overlaps a claim from the other session, and the statements disagree | Blocks the ticket. The lead reads the cited lines and decides, or starts a third targeted probe on those lines only |
| `single-source` | No overlap | Usable for `risk: low`. For `risk: high`, the lead verifies it by reading the cited lines |
| `counterexample` | From session B, with class `VERIFIED_IN_CODE` | Always goes to the lead, even if session A did not cover the area |

The script computes overlap. Compatibility of two statements is a judgment, so the script lists the overlapping pairs and the lead labels them.

### 2.7 Gate A: lead adjudication

Input: the verified packet (or the cross-check result). The lead does the following, in order.

1. Reads the cited lines for every `risk: high` claim and every `contested` pair. It does not rely on the statement.
2. Rejects any claim whose statement goes beyond its evidence. It records the reason.
3. Writes `adjudication.json`:

```json
{
  "schema": 1,
  "packetIds": ["RP-0007", "RP-0008"],
  "pinFingerprint": "sha256 of pins.lock.json surface hashes",
  "accepted": [{ "claim": "RP-0007/C3", "usedIn": ["task-1a-process-bridge/FEAT-002"] }],
  "rejected": [{ "claim": "RP-0007/C9", "reason": "statement generalizes one call site" }],
  "contestedResolved": [{ "pair": ["RP-0007/C4", "RP-0008/C2"], "ruling": "RP-0008/C2", "leadReadLines": "agtop/src/manager.ts:88-131" }],
  "decidedBy": "claude-opus-5-5",
  "decidedAt": "2026-11-14"
}
```

4. Synthesizes `context.json` and the `FEAT-*.json` tickets (section 3). Type signatures in a ticket are copied by a script from the cited commit, not typed by a model. Each has the source path, range, and hash.

A ticket can cite only accepted claims. The ticket validator refuses a `researchRefs` entry that is absent from an `adjudication.json`.

---

## 3. Coding tier: ticket packaging, verification harness, retry policy

### 3.1 `context.json` schema

One file per task. It holds what every feature of the task needs, once. It extends the existing files in `.agents/tasks/` and keeps their field names.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "lemon-tree/orc/context.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "task_id", "wave", "base", "pins", "language", "build_system", "test_framework",
    "commands", "rules", "relevant_files", "locked_files"],
  "properties": {
    "schema": { "const": 2 },
    "task_id": { "type": "string", "pattern": "^task-[a-z0-9-]+$" },
    "wave": { "enum": ["0", "1A", "1B", "1C", "1D", "2A", "2B", "3", "T", "V", "U", "P", "Q"] },
    "base": {
      "type": "object", "additionalProperties": false, "required": ["commit", "branch"],
      "properties": { "commit": { "type": "string", "pattern": "^[0-9a-f]{40}$" }, "branch": { "type": "string" } }
    },
    "pins": {
      "type": "object", "additionalProperties": false, "required": ["agtop", "toolkit", "fingerprint"],
      "properties": {
        "agtop": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
        "toolkit": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
        "fingerprint": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
      }
    },
    "language": { "const": "TypeScript (no `any`)" },
    "build_system": { "type": "string" },
    "test_framework": { "type": "string" },
    "commands": {
      "type": "object", "additionalProperties": false, "required": ["cwd", "typecheck", "lint", "test"],
      "properties": {
        "cwd": { "const": "global-sct" },
        "typecheck": { "const": "bun run typecheck:tsc" },
        "lint": { "const": "bun run lint" },
        "test": { "const": "bun run test" },
        "build": { "const": "bun run build" },
        "ui": { "type": "string" }
      }
    },
    "rules": { "type": "array", "items": { "type": "string" }, "maxItems": 20,
      "description": "The AGENTS.md rules that apply to this task, already resolved for precedence." },
    "relevant_files": { "type": "array", "items": { "type": "string" }, "maxItems": 25 },
    "locked_files": { "type": "array", "items": { "type": "string" } },
    "key_patterns": { "type": "string", "maxLength": 3000 },
    "environment_constraints": { "type": "string", "maxLength": 1500 },
    "capabilities": { "type": "array", "items": { "type": "string" },
      "description": "CapabilityId values present at these pins. A step must not use a missing capability." }
  }
}
```

### 3.2 `features/FEAT-XXX.json` schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "lemon-tree/orc/feature.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "id", "type", "description", "status", "depends_on", "scope", "contracts", "steps",
    "acceptance_criteria", "verification", "tests", "budget", "route", "attempts", "blocked_reason", "findings"],
  "properties": {
    "schema": { "const": 2 },
    "id": { "type": "string", "pattern": "^FEAT-[0-9]{3}$" },
    "type": { "enum": ["feat", "fix", "test", "chore", "docs"] },
    "description": { "type": "string", "maxLength": 800 },
    "status": { "enum": ["draft", "ready", "dispatched", "verifying", "repair", "review", "completed", "blocked", "stale", "superseded"] },
    "depends_on": { "type": "array", "items": { "type": "string" } },
    "supersedes": { "type": ["string", "null"] },
    "scope": {
      "type": "object", "additionalProperties": false, "required": ["allow", "deny", "max_files", "max_lines"],
      "properties": {
        "allow": { "type": "array", "minItems": 1, "items": { "type": "string" }, "description": "Globs relative to the repository root. The only paths the diff can touch." },
        "deny": { "type": "array", "items": { "type": "string" }, "description": "Always includes the locked files, pins.json, scripts/pins.ts, .agents/**, agtop/**, subagentclassifiertoolkit/**, bun.lock." },
        "max_files": { "type": "integer", "minimum": 1, "maximum": 12 },
        "max_lines": { "type": "integer", "minimum": 1, "maximum": 600 }
      }
    },
    "unlocks": {
      "type": "array", "description": "Written only by the lead. Each entry moves one locked file from deny to allow for this ticket.",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["path", "change", "approved_by", "approved_at"],
        "properties": {
          "path": { "type": "string" },
          "change": { "type": "string", "description": "The exact permitted change, for example: add optional field `capabilities?: CapabilityId[]` to HarnessManifestEntry." },
          "approved_by": { "const": "claude-opus-5-5" },
          "approved_at": { "type": "string", "format": "date" }
        }
      }
    },
    "contracts": {
      "type": "array", "maxItems": 12,
      "description": "Exact type signatures the worker needs. Copied by script from the cited commit.",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["symbol", "repo", "path", "startLine", "endLine", "sha256", "text", "role"],
        "properties": {
          "symbol": { "type": "string" },
          "repo": { "enum": ["workspace", "agtop", "toolkit"] },
          "path": { "type": "string" },
          "startLine": { "type": "integer" },
          "endLine": { "type": "integer" },
          "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
          "text": { "type": "string", "maxLength": 2500 },
          "role": { "enum": ["implement", "call", "extend", "read-only"] }
        }
      }
    },
    "steps": { "type": "array", "minItems": 1, "maxItems": 10, "items": { "type": "string", "maxLength": 600 } },
    "acceptance_criteria": { "type": "array", "minItems": 1, "items": { "type": "string" } },
    "verification": { "type": "array", "minItems": 1, "items": { "type": "string" },
      "description": "Commands, each one argv with no shell operators. Run from context.commands.cwd." },
    "tests": {
      "type": "object", "additionalProperties": false, "required": ["files", "must_add", "min_cases"],
      "properties": {
        "files": { "type": "array", "items": { "type": "string" } },
        "must_add": { "type": "array", "items": { "type": "string" }, "description": "One line per required test case, stated as behavior." },
        "min_cases": { "type": "integer", "minimum": 0 }
      }
    },
    "researchRefs": { "type": "array", "items": { "type": "string", "pattern": "^RP-[0-9]{4}/C[0-9]{1,3}$" } },
    "budget": {
      "type": "object", "additionalProperties": false, "required": ["context_tokens", "wall_clock_minutes"],
      "properties": { "context_tokens": { "type": "integer", "maximum": 24000 }, "wall_clock_minutes": { "type": "integer", "maximum": 45 } }
    },
    "route": {
      "type": "object", "additionalProperties": false, "required": ["providerInstanceId", "model", "options", "classified_by", "policy_hash"],
      "properties": {
        "providerInstanceId": { "const": "opencode" },
        "model": { "const": "opencode-go/deepseek-v4.1-flash" },
        "options": { "type": "object" },
        "classified_by": { "enum": ["toolkit-select-target", "lead-pinned"] },
        "policy_hash": { "type": "string", "description": "SHA-256 of routing-policy.json at the toolkit pin." }
      }
    },
    "worktree": {
      "type": ["object", "null"], "additionalProperties": false,
      "properties": {
        "path": { "type": "string" }, "branch": { "type": "string", "pattern": "^agent/task-[a-z0-9-]+/FEAT-[0-9]{3}$" },
        "base_commit": { "type": "string" }, "head_commit": { "type": ["string", "null"] }
      }
    },
    "attempts": {
      "type": "array", "maxItems": 3,
      "items": {
        "type": "object", "additionalProperties": false, "required": ["n", "kind", "started_at", "report"],
        "properties": {
          "n": { "enum": [1, 2, 3] },
          "kind": { "enum": ["initial", "repair"] },
          "started_at": { "type": "string" },
          "report": { "type": "string", "description": "Path to the Gate C report JSON for this attempt." }
        }
      }
    },
    "blocked_reason": {
      "type": ["object", "null"], "additionalProperties": false, "required": ["code", "retryable", "detail"],
      "properties": {
        "code": { "enum": ["gate-failed-3", "scope-violation", "contract-unlock-needed", "upstream-drift", "stale-pins", "provider-limit", "offpeak-deferred", "needs-user-decision"] },
        "retryable": { "type": "boolean" },
        "detail": { "type": "string" }
      }
    },
    "findings": { "type": "string" }
  }
}
```

How the package avoids context bloat:

- The worker receives 3 things: `context.json`, one `FEAT-*.json`, and the files in `scope.allow` that already exist. It receives no plan document and no research packet.
- `contracts[].text` holds each signature it must implement or call, verbatim. The worker does not need to open `contracts.ts` (495 lines) to find one interface.
- `budget.context_tokens` is checked by a script before dispatch: the sizes of `context.json`, the ticket, and the allowed files, at 4 characters per token. A ticket over the budget is split by the lead.
- `steps` has at most 10 entries. A ticket that needs more is two tickets.

The brief sent to the worker is generated from the two files. It ends with fixed text:

> Edit only paths that match `scope.allow`. Do not edit a path in `scope.deny`. Do not run `git push`, `git merge`, `git rebase`, `git reset`, or `git checkout` of another branch. Do not change `package.json` or `bun.lock`. Do not install a dependency. Commit your work on the current branch with one commit. If a step needs a change outside the scope, stop, and write the exact needed change in your final message under the heading `SCOPE REQUEST`. Never run `tsc` directly. Use the package scripts.

### 3.3 OpenCode Go agent configuration

The worker runs under a project agent definition with a deny-first permission set.

`global-sct/.opencode/agent/lt-coder.md` (location and keys must be checked against the OpenCode 2.3.0 config schema before first use; the schema URL is in the `$schema` field of `~/.config/opencode/opencode.json`):

```markdown
---
description: Bounded Lemon Tree coding worker. One FEAT ticket, one worktree.
mode: primary
model: opencode-go/deepseek-v4.1-flash
temperature: 0.1
permission:
  edit: allow
  webfetch: deny
  websearch: deny
  task: deny
  bash:
    "*": deny
    "bun run typecheck*": allow
    "bun run lint": allow
    "bun run test": allow
    "bun run check": allow
    "bun run build": allow
    "bun run build:sdk": allow
    "bun run build:vscode": allow
    "bun run react-doctor": allow
    "bun test *": allow
    "git status*": allow
    "git diff*": allow
    "git add *": allow
    "git commit *": allow
    "git log*": allow
---
You implement exactly one ticket. Read `context.json` and the ticket first.
Follow the steps in order. Write the tests in `tests.must_add`. Run every command in `verification`.
Report: files changed, each command with its exit code, and any SCOPE REQUEST.
```

Project `global-sct/opencode.json` for worker runs:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode-go/deepseek-v4.1-flash",
  "share": "disabled",
  "autoupdate": false,
  "mcp": {},
  "instructions": ["AGENTS.md"]
}
```

Notes:

- `"mcp": {}` is deliberate. The worker gets no vault or memory server. The harness manifest injects `lemon-tree` MCP for product jobs. Orchestration workers are not product jobs.
- The agent definition is a guardrail, not the control. The control is Gate C. A model that ignores the permission text is still caught by the scope check.
- The permission keys above follow the OpenCode 1.x documentation. The installed version is 2.3.0. Ticket `ORC-4` verifies each key with a negative test (a worker told to run `curl` must be refused) before any real ticket is dispatched.

Dispatch, in this workspace, goes through the T3 `delegate_task` tool:

```json
{
  "target": { "providerInstanceId": "opencode", "model": "opencode-go/deepseek-v4.1-flash", "options": { "variant": "high" } },
  "isolation": "worktree",
  "runtimeMode": "auto-accept-edits",
  "task": "<generated brief>"
}
```

The equivalent direct command, which is also what the product's `harnesses.json` entry produces, is:

```sh
opencode run --agent lt-coder --model 'opencode-go/deepseek-v4.1-flash#high' --format json "<generated brief>"
```

Before each dispatch the lead runs the `offpeak-scheduler` gate. If the gate defers, the ticket moves to `blocked` with `code: "offpeak-deferred"`, `retryable: true`, and a one-time scheduled retry. No polling.

Running workers are inspected and stopped with `agtop`, never with `ps` or `kill`.

### 3.4 Gate C: automated verification harness

`scripts/orc/verify-ticket.ts <task-id> <feat-id>` runs in the worker's worktree after the worker stops. The worker's own report is ignored. Order matters: cheap and decisive checks run first.

| # | Check | Command or logic | Fail code |
|---|---|---|---|
| 0 | Pins unchanged since dispatch | `pins.lock.json` fingerprint equals `context.pins.fingerprint` | `stale-pins` (not an attempt) |
| 1 | **Diff scope** | Section 3.4.1 | `scope-violation` |
| 2 | Typecheck, official compiler | `bun run typecheck:tsc`. This compiles `src/main/agtop-type-check.ts` and every `Equal<>` schema assertion | `typecheck` |
| 3 | Lint | `bun run lint` (`eslint.config.mjs`, 0 warnings) | `lint` |
| 4 | Unit tests | `bun run test`, then each `bun test <file>` in `tests.files` that the root script does not list yet | `test` |
| 5 | Test substance | Section 3.4.2 | `test-substance` |
| 6 | Ticket commands | Each entry in `verification`, as argv, no shell, 600-second limit | `verification` |
| 7 | UI tickets only | `bun run build`, `bun run react-doctor` with score 100, the named Playwright spec with `ELECTRON_RUN_AS_NODE` unset | `ui` |
| 8 | Secret scan | The diff has no `{secret:` resolution to disk, no `.env` file, and no string that matches the synthetic test secret | `secret-leak` |

"`tsc --noEmit`" in any brief means `bun run typecheck:tsc` (AGENTS.md override 2). The harness never calls `tsc` directly.

Checks 2 to 6 reuse the toolkit: the harness writes a `plan.json` unit (fields `id`, `write_scope`, `commands`, `acceptance` of `plan.schema.json`) and runs `verify_unit.py --plan plan.json --unit <id> --repo <worktree> --base <base_commit> --timeout 600 --allow-commands`. The result goes to `record_verification.py` for the outcome ledger. When the capability `toolkit.verify-unit` is missing, the harness runs the same commands itself and records that the ledger step was skipped.

#### 3.4.1 Diff scope check

`verify_unit.py` checks committed paths in `base..HEAD`. The harness adds the uncommitted and structural cases.

```ts
// scripts/orc/scope-check.ts  (specification)
import { $ } from 'bun'
const glob = (pattern: string) => new Bun.Glob(pattern)

export async function scopeCheck(worktree: string, base: string, allow: string[], deny: string[], maxFiles: number, maxLines: number) {
  const committed = (await $`git -C ${worktree} diff --name-status --no-renames ${base}..HEAD`.text()).trim().split('\n').filter(Boolean)
  const dirty = (await $`git -C ${worktree} status --porcelain=v1 --untracked-files=all`.text()).trim().split('\n').filter(Boolean)
  const violations: string[] = []
  // A worker must leave a clean tree. Uncommitted or untracked files are outside the reviewed diff.
  for (const line of dirty) violations.push(`uncommitted:${line.slice(3)}`)
  const paths = committed.map(line => line.split('\t')[1]!)
  for (const path of paths) {
    if (deny.some(p => glob(p).match(path))) violations.push(`denied:${path}`)
    else if (!allow.some(p => glob(p).match(path))) violations.push(`outside-scope:${path}`)
  }
  // Structural rules that a glob cannot express.
  const modes = await $`git -C ${worktree} diff --raw ${base}..HEAD`.text()
  if (/^:\d{6} 120000 /m.test(modes)) violations.push('symlink-added')
  if (/^:\d{6} 160000 /m.test(modes)) violations.push('submodule-added')
  if ((await $`git -C ${worktree} rev-list --count ${base}..HEAD`.text()).trim() === '0') violations.push('no-commit')
  if ((await $`git -C ${worktree} rev-list --merges --count ${base}..HEAD`.text()).trim() !== '0') violations.push('merge-commit')
  if ((await $`git -C ${worktree} merge-base ${base} HEAD`.text()).trim() !== base) violations.push('history-rewritten')
  const stat = await $`git -C ${worktree} diff --shortstat ${base}..HEAD`.text()
  const lines = [...stat.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce((sum, m) => sum + Number(m[1]), 0)
  if (paths.length > maxFiles) violations.push(`too-many-files:${paths.length}`)
  if (lines > maxLines) violations.push(`too-many-lines:${lines}`)
  return { paths, lines, violations }
}
```

The default `deny` list, merged into every ticket:

```json
[
  "global-sct/src/shared/contracts.ts", "global-sct/src/shared/acp-types.ts", "global-sct/src/shared/ipc-channels.ts",
  "global-sct/src/shared/harness-manifest.ts", "global-sct/harnesses.json", "global-sct/package.json", "global-sct/bun.lock",
  "global-sct/tsconfig*.json", "global-sct/src/main/agtop-type-check.ts", "global-sct/eslint.config.mjs",
  "global-sct/AGENTS.md", "AGENTS.md", "pins.json", "pins.lock.json", "scripts/**", "package.json",
  "agtop/**", "subagentclassifiertoolkit/**", ".agents/**", ".github/**", "global-sct/.github/**",
  "global-sct/.opencode/**", "global-sct/opencode.json", "docs/**"
]
```

A scope violation is not repaired by the worker. The diff is discarded for the violating paths only if the lead decides so. By default the attempt fails.

#### 3.4.2 Test substance check

A green test run does not prove that a test exists. The harness checks:

1. Each file in `tests.files` exists and the number of added `test(` calls in the diff is at least `tests.min_cases`.
2. No added test is skipped (`test.skip`, `test.todo`, `{ skip: true }`) unless the ticket lists it.
3. No added test file uses `globalThis.` or a module mock (project testing rule).
4. No assertion in the diff is `assert.ok(true)`, `expect(true)`, or compares a literal with itself.
5. **Mutation probe** for `feat` and `fix` tickets: the harness checks out the test files from `HEAD` onto `base` in a temporary worktree and runs them. At least one new test must fail there. A test that passes without the implementation tests nothing.

The lead still reads the tests. The probe removes the empty ones before the lead spends time on them.

### 3.5 Contract unlock protocol

A worker that needs a locked-file change writes a `SCOPE REQUEST`. It does not edit the file.

1. Gate C marks the attempt `contract-unlock-needed`. This is not a failed attempt.
2. The lead decides. Options: reject and rewrite the ticket; make the change itself as a Wave 0 commit and re-base the ticket; or add an `unlocks` entry with the exact permitted change.
3. With an `unlocks` entry, Gate C allows that path and adds one check: the diff of that file contains only the described change. The lead confirms this by reading the diff. No script approves a contract change.
4. A contract change needs a new `CONTRACT_VERSION` minor (additive) or major (breaking), per section 3.3 of the completion plan.
5. After a contract change merges, every `ready` or `dispatched` ticket whose `contracts[]` cites a changed range becomes `stale` (section 4.3).

### 3.6 Retry and escalation policy

```
attempt 1 (initial, variant high) ──Gate C pass──► review ──lead accepts──► completed
        │ fail
        ▼
attempt 2 (repair 1, variant high)   input: ticket + failing check + stderr tail
        │ fail
        ▼
attempt 3 (repair 2, variant max)    input: ticket + both failure reports + diff of attempt 2
        │ fail  (= failure #3)
        ▼
HALT worker → drift probe? → escalate to lead
```

Repair input rules:

- The repair brief contains the failing check name, the exit code, and the last 120 lines of stderr and stdout, with ANSI codes removed. It is capped at 6,000 characters. The middle is cut, not the end.
- The worker continues in the same worktree and adds one commit. It does not start again unless the failure is `scope-violation`, where the worktree is reset to `base` by the harness.
- The same failing check with the same first error line in attempts 1 and 2 raises the variant to `max` for attempt 3. A different error is progress and keeps the plan above.
- These do not count as attempts: `stale-pins`, `offpeak-deferred`, `provider-limit`, `contract-unlock-needed`, and a harness error.
- `provider-limit`: the lead schedules one retry after the reset and tells the user the alternatives. It does not change provider (role rule).

On failure #3:

1. The harness stops the worker through agtop and sets the ticket to `blocked`, `code: "gate-failed-3"`, `retryable: false`. The worktree and branch are kept.
2. **Drift suspicion test**, deterministic. Drift is suspected when any is true:
   - A failing `typecheck` error names a path under `agtop/` or a symbol imported from `'agtop'`, `@agentclientprotocol/sdk`, or `@modelcontextprotocol/server`.
   - A failing error is in `src/main/agtop-type-check.ts` or a boundary schema `Equal<>` assertion.
   - `bun scripts/pins.ts --drift` exits 3.
   - A `contracts[]` entry of the ticket no longer hashes to its `sha256` at the base commit.
3. When drift is suspected, the lead starts **one targeted research probe** (Tier 2, one session, or two if the files are high-risk per section 2.6). The question is narrow: "At commit X, does symbol S in file F have signature T? Cite the lines." The packet goes through Gate R as usual.
4. Escalation packet to the lead:

```json
{
  "schema": 1,
  "kind": "escalation",
  "ticket": "task-1a-process-bridge/FEAT-002",
  "failures": [
    { "attempt": 1, "check": "typecheck", "firstError": "src/main/process-bridge/agtop-adapter.ts(41,9): error TS2345: ...", "report": ".agents/tasks/.../reports/attempt-1.json" },
    { "attempt": 2, "check": "typecheck", "firstError": "...", "report": "..." },
    { "attempt": 3, "check": "test", "firstError": "...", "report": "..." }
  ],
  "driftSuspected": true,
  "driftSignals": ["error-names-agtop-symbol:AgentProcessTree"],
  "probe": "RP-0012",
  "worktree": { "path": "...", "branch": "agent/task-1a-process-bridge/FEAT-002", "head_commit": "..." },
  "leadOptions": ["rewrite-ticket", "split-ticket", "fix-contract", "small-fix-by-lead", "reassign-model-needs-user"]
}
```

5. The lead chooses one option. "Reassign to another model" is a user decision, because the user fixed the coding tier.

---

## 4. Live upstream mutation protocol

### 4.1 Detection

Three triggers. All call the same script, `bun scripts/pins.ts --status --json`, and compare the result with `pins.lock.json`.

| Trigger | When | Mechanism |
|---|---|---|
| Transition hook | Before every state transition in section 5, and before every dispatch | The orchestration harness calls the script. This is the trigger that guarantees correctness |
| Git hooks | `post-merge`, `post-checkout`, `post-rewrite` in the workspace | `.githooks/` with `core.hooksPath`. They run `pins --check` and write `.agents/orchestration/pin-event.json` when `pins.json`, `global-sct/package.json`, `global-sct/bun.lock`, or `global-sct/packages/*/package.json` changed |
| Upstream poll | At session start and once per hour of active work | `git ls-remote` on each `track`. It needs the network and can fail. A failure is logged, not fatal |

A file watcher is not used. A watcher that misses an event gives false confidence. The transition hook cannot miss, because nothing moves without it.

Two kinds of event exist:

| Event | Meaning | Urgency |
|---|---|---|
| `pin-moved` | `pins.json` SHA changed in the workspace, or a workspace package manifest changed | Immediate. Run 4.2 now |
| `upstream-ahead` | The track has new commits and the pin did not move | Informational. Run `pins --drift`. Exit 3 (a surface file changed) creates a lead decision ticket "move pin?". Exit 0 changes nothing |

For global.sct itself, the "pin" is the workspace commit. A change to a locked file on `main` is a `pin-moved` event with repository `workspace`.

### 4.2 Protocol on `pin-moved`

```
1 FREEZE      Stop new dispatches. Running workers continue. Set .agents/orchestration/freeze.json.
2 MATERIALIZE bun run pins            → clones at the new SHA, agtop rebuilt
3 FINGERPRINT pins --status --json    → new surfaceHash per pin, new CapabilitySet
4 CHECK BASE  bun run typecheck:tsc && bun run test on main
              fail → the pin move itself is broken. Open a lead ticket. Stay frozen for affected waves.
5 IMPACT      scripts/orc/impact.ts   → changed files and changed line ranges per repository
6 INVALIDATE  research cache and tickets (4.3)
7 RECLASSIFY  routes, when the toolkit policy changed (4.4)
8 RESUME      Write the new pins.lock.json. Remove freeze.json. Dispatch unaffected tickets first.
```

Step 4 runs before anything is invalidated. If the base does not compile at the new pin, the boundary layer has a gap, and the lead must close it before any worker continues.

### 4.3 Invalidation of the research cache and tickets

Claims and contracts are addressed by content, so most of the invalidation is mechanical and precise.

**Research cache.** Each stored claim has, for each evidence item, `(repo, path, startLine, endLine, sha256)`. After a pin move, `scripts/orc/revalidate.ts` does this for each `pass` claim:

| Result at the new commit | New state |
|---|---|
| The file exists and the same line range has the same hash | `valid`. No work |
| The hash is found at a different line range in the same file (the text moved) | `valid`, with the range updated and the old range recorded |
| The file exists and the text is gone or changed | `invalid` |
| The file does not exist | `invalid` |
| `external` evidence | `valid` if `retrievedAt` is less than 30 days old, else `aging` |

A claim never becomes valid again by a model's statement. Only a new packet through Gate R can replace an invalid claim.

**Tickets.** A ticket is affected when one of these is true:

1. A `contracts[]` entry no longer hashes to its `sha256` (same procedure as above; a pure move updates the range and does not affect the ticket).
2. A `researchRefs` claim is now `invalid`.
3. Its `context.capabilities` contains a capability that is now missing.
4. A file in `scope.allow` changed on `main` between the old base and the new base.

| Ticket status at the event | Affected | Action |
|---|---|---|
| `draft`, `ready` | Yes | `stale`. The lead regenerates `contracts[]` by script and reviews the steps |
| `draft`, `ready` | No | Update `context.pins`. No other change |
| `dispatched`, `repair` | Yes | Let the current run end. Do not kill it: the diff is evidence. Then follow 4.5 |
| `dispatched`, `repair` | No | Gate C check 0 reports `stale-pins`. The harness rebases the worktree branch onto the new base and runs Gate C again. No attempt is counted |
| `verifying`, `review` | Yes | Back to `stale` with the diff kept |
| `completed` (merged) | Yes | Not reopened. Step 4 already proved that `main` compiles and passes. If a completed ticket's behavior depends on a changed surface, the lead opens a new `fix` ticket |

Every invalidation writes one line to `.agents/orchestration/invalidation.ndjson`: event id, ticket or claim, rule number, old hash, new hash. The lead can audit why a ticket went stale.

### 4.4 Re-classification with updated toolkit rules

Routing data and work data are separate fields. That separation is what protects in-progress work.

- `route` holds the classification result and `policy_hash`, the hash of `routing-policy.json` at the toolkit pin.
- `worktree` and `attempts` hold the work state. Re-classification never writes them.

Procedure when the toolkit pin moves:

1. Compute the new `policy_hash`. If it is equal, stop. A toolkit change that does not touch the routing policy or `select_target.py` reroutes nothing.
2. If the capability `toolkit.select-target` is missing at the new pin (the script moved or its `--help` lost a required flag), keep every existing route and mark them `classified_by: "lead-pinned"`. The lead is told. Work continues.
3. For each ticket that is not `completed` or `superseded`, run `select_target.py --capabilities <live caps> --role <role> --depth <depth> --json` with the new policy. The role and depth come from the ticket `type` and its size, as before.
4. The coding tier is fixed by the user. So the result is compared, not applied blindly:

| New result | Action |
|---|---|
| Same provider and model | Update `policy_hash` only |
| Same provider and model, different `options` (for example `variant`) | Apply to tickets in `draft`, `ready`, `stale`. For `dispatched` and `repair`, apply at the next attempt |
| A different model or provider | Record it in `findings` as a recommendation. Do not apply. The user fixed `opencode-go/deepseek-v4.1-flash`. The lead reports the difference |
| `UNAVAILABLE` or `BUDGET_EXCEEDED` | Ticket `blocked`, `code: "provider-limit"`, `retryable: true` |

5. Process-role classification is not part of this. It comes from agtop at run time (AGENTS.md rule 6) and has no stored state to migrate.

### 4.5 Keeping in-progress worktree state

A worktree is never deleted by the mutation protocol. Deletion happens only after a merge or an explicit lead decision, through the `worktree-janitor` skill.

For an affected ticket with work in its worktree:

1. **Snapshot.** `git -C <worktree> format-patch <base_commit>..HEAD -o .agents/tasks/<task>/attempts/<feat>-<n>/`. Add a tag `orc/<task>/<feat>/pre-<event-id>` on the branch head. The work now survives any later step.
2. **Try a rebase** onto the new base: `git rebase --onto <new_base> <old_base>` in the worktree, by the harness, not by a worker.
   - Clean rebase: run Gate C. Pass → the ticket continues to `review` with a note that the base moved. Fail → one repair attempt with the Gate C output. This repair counts.
   - Conflict: `git rebase --abort`. Go to step 3.
3. **Supersede.** The lead writes a new ticket with `supersedes: <old id>`, new `contracts[]`, and a step: "Apply the intent of the attached patch to the new base." The patch from step 1 is attached to the brief. The old ticket becomes `superseded`. Its branch and tag stay until the new ticket merges.
4. The attempt counter of the new ticket starts at 0. An upstream change is not a worker failure.

Research worktrees are different. They are disposable and detached at one commit. After a pin move, a running research session is allowed to end, and Gate R returns exit 3 (`stale-pins`) for its packet. The question is queued again at the new commit.

---

## 5. State machine

`task.json` keeps its existing fields (`task_id`, `task_description`, `status`, `feature_order`, `blocked_reason`). Task status is derived: `completed` when all features are `completed` or `superseded`; `blocked` when any is `blocked` and none can run; else `in_progress`.

Feature transitions. Only the actor in the last column can make the move. The harness refuses any other.

| From | To | Condition | Actor |
|---|---|---|---|
| `draft` | `ready` | The ticket validates. `researchRefs` are all accepted. Dependencies are `completed`. The context budget passes | Lead |
| `ready` | `dispatched` | Pins fingerprint current. No freeze. Off-peak gate passes. Worktree created | Lead |
| `dispatched` | `verifying` | The worker stopped | Harness |
| `verifying` | `review` | Gate C passes | Harness |
| `verifying` | `repair` | Gate C fails and fewer than 3 attempts exist | Harness |
| `repair` | `verifying` | The worker stopped | Harness |
| `verifying` | `blocked` | Failure #3, or a scope violation the lead does not waive, or an unlock request | Harness |
| `review` | `completed` | The lead read the diff and the tests, and merged | Lead |
| `review` | `repair` | The lead found a defect. This uses an attempt | Lead |
| any open state | `stale` | Section 4.3 | Harness |
| `stale` | `ready` | The lead regenerated and reviewed the ticket | Lead |
| `stale`, `blocked` | `superseded` | A new ticket replaces it | Lead |
| `blocked` | `ready` | The lead resolved the cause | Lead |

The lead writes `findings` when it completes a feature: files changed, each gate result, and the merge commit. This repairs the problem in D4 of the completion plan, where a feature stayed `in_progress` with empty findings.

Concurrency rule: two tickets with intersecting `scope.allow` globs are never `dispatched` at the same time. The C8d task record shows the cost: two writers in `src/main/sharing.ts` produced 22 type errors and one blocked feature. The harness checks the intersection at dispatch.

---

## 6. Merge procedure

1. The lead reads the full diff of `agent/<task>/<feat>` against its base.
2. It checks each acceptance criterion against the code, not against the worker's report.
3. It reads each new test. It rejects a test that restates the implementation or asserts nothing.
4. It merges with `--no-ff` into the wave integration branch `wave/<wave>`. One ticket, one merge commit.
5. On the integration branch it runs the full gate: `bun run check`, `bun run typecheck:tsc`, `bun run test`, `bun run build`, and for UI waves `bun run react-doctor` and `bun run test:ui`.
6. A wave merges to `main` when all its tickets are `completed` and the integration gate passes. Pushing and opening a pull request are user-approved actions.

---

## 7. Failure modes and responses

| Failure | Detection | Response |
|---|---|---|
| A research agent invents a file or a line | Gate R: `no-such-file`, `hash-mismatch` | The claim is rejected. Below 0.6 pass rate, the packet is discarded |
| A research agent cites real lines for a false statement | Gate A: the lead reads the lines. Cross-check: `contested` or `counterexample` | The claim is rejected with a reason |
| A research agent writes a file | Sandbox layer 3 fingerprint | The packet is discarded. The route is marked `tainted`. The lead reports it to the user |
| Prompt injection in a web page or a repository file | The packet is data. No field is executed | No effect. The lead ignores instructions in claims |
| A worker edits a contract | Gate C check 1 | The attempt fails. The contract is unchanged, because the branch is not merged |
| A worker makes tests pass by weakening them | Gate C check 5, then lead review | The attempt fails |
| A worker reports success and did nothing | Gate C: `no-commit` | The attempt fails |
| Two workers need one file | Dispatch-time glob intersection | The second ticket waits |
| The preferred research model appears mid-session | Next session start | Bind then. No mid-session change, so that one cross-check uses consistent models |
| The Antigravity provider hits a limit | Provider error | Fallback model, then wait and reschedule once. The user is told |
| DeepSeek peak-price window | `offpeak-scheduler` gate | The ticket is deferred with a scheduled retry |
| A pin SHA disappears upstream | `pins --check` at a transition | Freeze. This is D1 of the completion plan. The lead moves or mirrors the pin |
| The lead's context is summarized mid-wave | — | All state is in `.agents/` files and git. The lead reads `task.json`, the tickets, and `invalidation.ndjson`, and continues |

---

## 8. Build order for the orchestration layer itself

These tickets build the scripts in this document. They are lead-owned, because they are the trust base. A Tier 3 worker does not build its own gate.

| Ticket | Deliverable | Depends | Acceptance |
|---|---|---|---|
| ORC-1 | JSON Schemas of sections 2.4, 3.1, 3.2 in `.agents/orchestration/schemas/`, and a validator script | LT-0.4 | The 3 existing task folders are migrated to schema 2 and validate |
| ORC-2 | `scripts/orc/verify-claims.ts` and `diff-claims.ts` | ORC-1 | Fixture packets: a true claim passes; a wrong hash, a missing file, an out-of-range line, a `..` path, and a mislabeled class each give the stated verdict |
| ORC-3 | `scripts/orc/verify-ticket.ts`, `scope-check.ts`, the test substance check | ORC-1 | Fixture worktrees: an in-scope diff passes; an edit to `contracts.ts`, an untracked file, a symlink, a merge commit, and an empty test each fail with the stated code |
| ORC-4 | OpenCode agent definition and project config. Negative permission test | ORC-3 | A worker told to edit `contracts.ts` and to run `curl` produces no merged change and a failed gate |
| ORC-5 | `scripts/orc/route-research.ts`, `routing.json`, the research sandbox wrapper with the fingerprint check | ORC-2 | With today's capabilities the route is `gemini-3.8-flash`, reason `fallback-not-listed`. A fixture with Hydrogen listed gives `preferred` |
| ORC-6 | `scripts/orc/impact.ts`, `revalidate.ts`, the git hooks, the freeze file | ORC-2, ORC-3, LT-0.4 | A synthetic pin move in a fixture repository: an unchanged claim stays valid, a moved one gets a new range, a changed one becomes invalid, and an affected `dispatched` ticket keeps its patch and tag |

The first real use is a pilot: tickets T-3 and T-10 of the completion plan. They are test-only, have no shared file, and need no contract. They exercise Gate C end to end with low risk.

---

## 9. Decisions the user must make

| # | Decision | Default in this document |
|---|---|---|
| 1 | Gemini 4 Hydrogen is not in the Antigravity catalog. Use `opencode/gemini-4-hydrogen` for research, or stay on Antigravity with 3.8 Flash | Stay on Antigravity with `gemini-3.8-flash`, as the fallback rule says |
| 2 | Make this tier assignment the project role, so later sessions do not route implementation to `codex:gpt-6-luna` | Yes, through `session-kickoff` |
| 3 | The lead in execution sessions is `claude-opus-5-5`. This planning session ran on a different model | Start the execution session with Opus 5.5 as the main agent |
| 4 | Workers commit in their worktrees. The existing task records say "Do not commit", written for a shared checkout | Workers commit on their own branch only. Nothing is pushed without approval |
| 5 | Override 1 (each wave writes tests) against "Do not add tests unless I approve" | Override 1 applies to tickets, as `global-sct/AGENTS.md` states. Changes to *existing* tests still need approval |
