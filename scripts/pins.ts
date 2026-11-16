// Pin materialization, status, drift report, and lock file.
//
//   bun scripts/pins.ts                  materialize the pins, build agtop, write pins.lock.json
//   bun scripts/pins.ts --check          verify the clones, the build, the lock file, and the required capabilities
//   bun scripts/pins.ts --status --json  print the position of each pin against its track
//   bun scripts/pins.ts --drift          exit 3 when a surface file differs between a pin and its track head
import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

type Pin = { url: string; sha: string; path?: string; track?: string; build?: string[]; requires?: string[]; optional?: string[]; surface?: string[] };
type Pins = { schema?: number; agtop: Pin; subagentclassifiertoolkit: Pin; globalSctForkBase: Pin };
type CloneKey = "agtop" | "subagentclassifiertoolkit";
type CapabilitySet = { present: string[]; missing: { capability: string; reason: string }[]; probedAt: number; pins: { agtop: string; toolkit: string } };
type LockPin = { sha: string; track: string | null; surfaceHash: string };
type Lock = { schema: 1; date: string; fingerprint: string; agtop: LockPin; subagentclassifiertoolkit: LockPin; globalSctForkBase: { sha: string }; capabilities: CapabilitySet };
type Status = { sha: string; track: string | null; upstreamHead: string | null; ahead: number | null; behind: number | null; isAncestorOfTrack: boolean | null; surfaceHash: string };

const root = resolve(import.meta.dir, "..");
const lockFile = Bun.file(resolve(root, "pins.lock.json"));
const pins = (await Bun.file(resolve(root, "pins.json")).json()) as Pins;
const cloneKeys = ["agtop", "subagentclassifiertoolkit"] as const;
const flag = (name: string) => Bun.argv.includes(name);
const checkOnly = flag("--check");
const dirOf = (key: CloneKey) => resolve(root, pins[key].path!);

// Each agtop capability is one exported function of the built module.
const AGTOP_EXPORTS: Record<string, string> = {
  "agtop.trees": "listAgentTrees",
  "agtop.kill": "killAgentTree",
  "agtop.spawn-contained": "spawnContainedAgent",
  "agtop.roles": "roleCatalog",
  "agtop.accelerators": "getAcceleratorSnapshot",
  "agtop.lemonade-probe": "probeLemonade",
  "agtop.worktree-detect": "resolveGitWorktree",
  "agtop.daemon": "startDaemon",
};
// Each toolkit capability is one file below the skill folder of the toolkit.
const TOOLKIT_SKILL = ".opencode/skills/subagent-orchestrator";
const TOOLKIT_FILES: Record<string, string> = {
  "toolkit.select-target": `${TOOLKIT_SKILL}/scripts/select_target.py`,
  "toolkit.verify-unit": `${TOOLKIT_SKILL}/scripts/verify_unit.py`,
  "toolkit.plan-schema": `${TOOLKIT_SKILL}/assets/plan.schema.json`,
  "toolkit.fix-brief": `${TOOLKIT_SKILL}/scripts/fix_brief.py`,
};
const SELECT_TARGET_FLAGS = ["--capabilities", "--role", "--depth", "--json"];

if (flag("--status")) await printStatus();
else if (flag("--drift")) await reportDrift();
else await materializeAndVerify();

async function materializeAndVerify() {
  for (const key of cloneKeys) {
    const pin = pins[key];
    const head = await headOf(dirOf(key));
    if (head !== pin.sha) {
      if (checkOnly) throw new Error(head === null ? `${pin.path} is missing.` : `${pin.path} exists at ${head}; expected ${pin.sha}.`);
      await materialize(pin, dirOf(key));
    }
    const verified = await headOf(dirOf(key));
    if (verified !== pin.sha) throw new Error(`${pin.path} verification failed: ${verified}`);
    console.log(`${pin.path}: ${verified}`);
  }
  await buildAgtop(dirOf("agtop"), pins.agtop);
  const lock = await computeLock();
  requireCapabilities(lock.capabilities);
  if (checkOnly) {
    await requireCurrentLock(lock);
    await requireAncestors();
  } else await writeLock(lock);
}

// A clone by branch cannot check out a commit that no branch contains.
// A fetch by SHA works for each commit that the host still serves.
async function materialize(pin: Pin, target: string) {
  if (await Bun.file(`${target}/.git/HEAD`).exists()) await requireCleanTree(pin, target);
  else {
    await mkdir(target, { recursive: true });
    await $`git -C ${target} init --quiet`;
  }
  if ((await $`git -C ${target} remote get-url origin`.nothrow().quiet()).exitCode === 0) await $`git -C ${target} remote set-url origin ${pin.url}`;
  else await $`git -C ${target} remote add origin ${pin.url}`;
  await $`git -C ${target} fetch --quiet origin ${pin.sha}`;
  await $`git -C ${target} checkout --quiet --detach FETCH_HEAD`;
}

// The script never resets a clone. A changed tree stops the run and the user decides.
async function requireCleanTree(pin: Pin, target: string) {
  const changed = (await $`git -C ${target} status --porcelain --untracked-files=all`.text()).split("\n").filter(Boolean);
  if (changed.length > 0) throw new Error(`${pin.path} has local changes. No reset was performed. Files:\n${changed.join("\n")}`);
}

// The stamp records the commit that the build output came from.
// A missing or different stamp means the output is absent or stale.
async function buildAgtop(target: string, pin: Pin) {
  const stamp = Bun.file(`${target}/dist/.pin-build`);
  const current = (await Bun.file(`${target}/dist/index.js`).exists()) && (await stamp.exists()) && (await stamp.text()).trim() === pin.sha;
  if (current) return;
  if (checkOnly) throw new Error(`agtop/dist is missing or was not built from ${pin.sha}. Run \`bun run pins\`.`);
  for (const command of pin.build ?? ["bun install --frozen-lockfile", "bun run build"]) await $`${{ raw: command }}`.cwd(target);
  await Bun.write(stamp, `${pin.sha}\n`);
  console.log(`agtop: built at ${pin.sha}`);
}

async function headOf(target: string) {
  if (!(await Bun.file(`${target}/.git/HEAD`).exists())) return null;
  const result = await $`git -C ${target} rev-parse --verify --quiet HEAD`.nothrow().quiet();
  return result.exitCode === 0 ? result.stdout.toString().trim() : "an unborn branch";
}

// ---------------------------------------------------------------- Lock file

async function computeLock(): Promise<Lock> {
  const agtop = { sha: pins.agtop.sha, track: pins.agtop.track ?? null, surfaceHash: await surfaceHash("agtop") };
  const toolkit = { sha: pins.subagentclassifiertoolkit.sha, track: pins.subagentclassifiertoolkit.track ?? null, surfaceHash: await surfaceHash("subagentclassifiertoolkit") };
  return {
    schema: 1,
    date: new Date().toISOString().slice(0, 10),
    fingerprint: createHash("sha256").update(`${agtop.sha}\n${agtop.surfaceHash}\n${toolkit.sha}\n${toolkit.surfaceHash}\n${pins.globalSctForkBase.sha}\n`).digest("hex"),
    agtop,
    subagentclassifiertoolkit: toolkit,
    globalSctForkBase: { sha: pins.globalSctForkBase.sha },
    capabilities: await probeCapabilities(),
  };
}

// The hash covers the git objects at the pin, so the working tree cannot change the result.
async function surfaceHash(key: CloneKey) {
  const hash = createHash("sha256");
  for (const path of [...(pins[key].surface ?? [])].sort()) {
    const blob = await $`git -C ${dirOf(key)} show ${`${pins[key].sha}:${path}`}`.nothrow().quiet();
    hash.update(`${path}\0${blob.exitCode === 0 ? "present" : "absent"}\0`).update(blob.exitCode === 0 ? blob.stdout : "").update("\0");
  }
  return hash.digest("hex");
}

// Discovery uses facts about the materialized pins, not version numbers.
async function probeCapabilities(): Promise<CapabilitySet> {
  const set: CapabilitySet = { present: [], missing: [], probedAt: Date.now(), pins: { agtop: pins.agtop.sha, toolkit: pins.subagentclassifiertoolkit.sha } };
  const record = (capability: string, reason: string | null) => (reason === null ? set.present.push(capability) : set.missing.push({ capability, reason }));
  const agtop = (await import(resolve(dirOf("agtop"), "dist/index.js")).catch((error: unknown) => ({ importError: String(error) }))) as Record<string, unknown>;
  for (const [capability, name] of Object.entries(AGTOP_EXPORTS)) {
    record(capability, typeof agtop[name] === "function" ? null : typeof agtop.importError === "string" ? `import failed: ${agtop.importError}` : `export ${name} is not a function`);
  }
  for (const [capability, path] of Object.entries(TOOLKIT_FILES)) {
    record(capability, (await Bun.file(resolve(dirOf("subagentclassifiertoolkit"), path)).exists()) ? await toolkitReason(capability, path) : `file ${path} is absent`);
  }
  return set;
}

async function toolkitReason(capability: string, path: string) {
  if (capability !== "toolkit.select-target") return null;
  // On Windows, `python3` can be a Store shim that exits with an error, and the real interpreter is `python`.
  const python = await workingPython();
  if (python === null) return "python is not installed";
  const help = await $`${python} ${resolve(dirOf("subagentclassifiertoolkit"), path)} --help`.nothrow().quiet();
  if (help.exitCode !== 0) return `--help exited with ${help.exitCode}`;
  const absent = SELECT_TARGET_FLAGS.filter(name => !help.stdout.toString().includes(name));
  return absent.length === 0 ? null : `--help does not list ${absent.join(", ")}`;
}

async function workingPython() {
  for (const name of ["python3", "python"]) {
    if (Bun.which(name) !== null && (await $`${name} --version`.nothrow().quiet()).exitCode === 0) return name;
  }
  return null;
}

function requireCapabilities(set: CapabilitySet) {
  const required = [...(pins.agtop.requires ?? []), ...(pins.subagentclassifiertoolkit.requires ?? [])];
  const absent = set.missing.filter(item => required.includes(item.capability));
  if (absent.length > 0) throw new Error(`Required capabilities are missing:\n${absent.map(item => `${item.capability}: ${item.reason}`).join("\n")}`);
}

// The date and the probe time are not facts about the pins. They stay out of the comparison.
function stable(lock: Lock) {
  return JSON.stringify({ ...lock, date: "", capabilities: { ...lock.capabilities, probedAt: 0 } });
}

async function requireCurrentLock(lock: Lock) {
  if (!(await lockFile.exists())) throw new Error("pins.lock.json is missing. Run `bun run pins`.");
  if (stable((await lockFile.json()) as Lock) !== stable(lock)) throw new Error("pins.lock.json does not match pins.json and the materialized pins. Run `bun run pins`.");
  console.log(`pins.lock.json: ${lock.fingerprint}`);
}

async function writeLock(lock: Lock) {
  if ((await lockFile.exists()) && stable((await lockFile.json()) as Lock) === stable(lock)) return;
  await Bun.write(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`pins.lock.json: wrote ${lock.fingerprint}`);
}

// ---------------------------------------------------------------- Status and drift

async function statusOf(key: CloneKey): Promise<Status> {
  const pin = pins[key];
  const base = { sha: pin.sha, track: pin.track ?? null, surfaceHash: await surfaceHash(key) };
  const offline = { ...base, upstreamHead: null, ahead: null, behind: null, isAncestorOfTrack: null };
  if (pin.track === undefined) return offline;
  // The network can fail. A failure is logged and is not fatal.
  if ((await $`git -C ${dirOf(key)} fetch --quiet origin ${pin.track}`.nothrow().quiet()).exitCode !== 0) {
    console.error(`${pin.path}: could not fetch ${pin.track} from ${pin.url}`);
    return offline;
  }
  const upstreamHead = (await $`git -C ${dirOf(key)} rev-parse FETCH_HEAD`.text()).trim();
  const [ahead, behind] = (await $`git -C ${dirOf(key)} rev-list --left-right --count ${`${pin.sha}...${upstreamHead}`}`.text()).trim().split(/\s+/).map(Number);
  return {
    ...base,
    upstreamHead,
    ahead: ahead!,
    behind: behind!,
    isAncestorOfTrack: (await $`git -C ${dirOf(key)} merge-base --is-ancestor ${pin.sha} ${upstreamHead}`.nothrow().quiet()).exitCode === 0,
  };
}

async function printStatus() {
  const forkHead = await $`git ls-remote ${pins.globalSctForkBase.url} ${pins.globalSctForkBase.track ?? "HEAD"}`.nothrow().quiet();
  const status = {
    schema: 1,
    agtop: await statusOf("agtop"),
    subagentclassifiertoolkit: await statusOf("subagentclassifiertoolkit"),
    globalSctForkBase: { sha: pins.globalSctForkBase.sha, track: pins.globalSctForkBase.track ?? null, upstreamHead: forkHead.exitCode === 0 ? (forkHead.stdout.toString().split(/\s/)[0] || null) : null },
  };
  if (flag("--json")) console.log(JSON.stringify(status, null, 2));
  else for (const key of cloneKeys) console.log(`${key}: ${status[key].sha} ahead ${status[key].ahead} behind ${status[key].behind} ancestor ${status[key].isAncestorOfTrack}`);
}

async function requireAncestors() {
  for (const key of cloneKeys) {
    if ((await statusOf(key)).isAncestorOfTrack === false) throw new Error(`${pins[key].path}: pin ${pins[key].sha} is not an ancestor of ${pins[key].track}.`);
  }
}

async function reportDrift() {
  let surfaceChanged = false;
  for (const key of cloneKeys) {
    const status = await statusOf(key);
    if (status.upstreamHead === null) throw new Error(`${pins[key].path}: the track head is unknown, so the drift is unknown.`);
    const stat = (await $`git -C ${dirOf(key)} diff --stat ${pins[key].sha} ${status.upstreamHead} -- ${pins[key].surface ?? []}`.text()).trim();
    console.log(`${pins[key].path}: ${status.behind} commits behind ${pins[key].track}. ${stat === "" ? "No surface file changed." : `Surface files changed:\n${stat}`}`);
    if (stat !== "") surfaceChanged = true;
  }
  if (surfaceChanged) process.exit(3);
}
