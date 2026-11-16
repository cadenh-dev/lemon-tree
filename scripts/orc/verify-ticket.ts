#!/usr/bin/env bun
// Gate C: the verification harness for one coding ticket. The report of the worker is ignored.
//   bun scripts/orc/verify-ticket.ts <task-id> <feat-id> [--worktree <path>] [--base <commit>] [--report <file>] [--no-prepare]
// The ticket comes from this checkout, not from the worktree, so a worker cannot change its own gate.
// Exit 0: pass. Exit 1: a check failed (the report names the fail code). Exit 3: stale-pins (not an attempt).
// Exit 2: harness error (not an attempt).
import { $ } from "bun";
import { resolve } from "node:path";
import { globalDeny, matches, readFeature, readLock, readTask, tail, type Context, type Feature } from "./lib";
import { scopeCheck } from "./scope-check";
import { testSubstance } from "./test-substance";

export type CheckResult = { n: number; name: string; status: "pass" | "fail" | "skipped"; detail: string[]; firstError?: string; output?: string };
export type Report = { schema: 1; ticket: string; worktree: string; base: string; head: string; result: "pass" | "fail"; failCode: string | null; ledger: "not-recorded"; checks: CheckResult[] };
export type GateInput = { ticket: string; feature: Feature; context: Context; worktree: string; base: string; prepare: boolean };

const COMMAND_LIMIT_MS = 600_000;
const SHELL_OPERATORS = /[;&|<>`$()]/;
// The synthetic secret of the job tests. It can occur in a test file and nowhere else.
const SYNTHETIC_SECRET = "LEMON_TREE_SYNTHETIC_SECRET";
const SECRET_PATTERNS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bAKIA[0-9A-Z]{16}\b/];

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const [taskId, featId] = args as [string, string];
  if (taskId === undefined || featId === undefined) fail(2, "Usage: verify-ticket.ts <task-id> <feat-id> [--worktree <path>] [--base <commit>] [--report <file>] [--no-prepare]");
  const { context } = await readTask(taskId);
  const feature = await readFeature(taskId, featId);
  const worktree = option("--worktree") ?? feature.worktree?.path;
  if (worktree === undefined) fail(2, "The ticket has no worktree.path. Give --worktree.");
  const report = await runGate({ ticket: `${taskId}/${featId}`, feature, context, worktree: resolve(worktree), base: option("--base") ?? feature.worktree?.base_commit ?? context.base.commit, prepare: !args.includes("--no-prepare") })
    .catch((error: unknown) => fail(2, `harness-error: ${String(error)}`));
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (option("--report") !== undefined) await Bun.write(option("--report")!, text);
  console.log(text);
  process.exit(report.result === "pass" ? 0 : report.failCode === "stale-pins" ? 3 : 1);
}

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

// Cheap and decisive checks run first. The first failed check stops the gate.
export async function runGate({ ticket, feature, context, worktree, base, prepare }: GateInput): Promise<Report> {
  const cwd = resolve(worktree, context.commands.cwd);
  const report: Report = { schema: 1, ticket, worktree, base, head: (await $`git -C ${worktree} rev-parse HEAD`.text()).trim(), result: "pass", failCode: null, ledger: "not-recorded", checks: [] };
  const steps: [string, string, () => Promise<Omit<CheckResult, "n" | "name">>][] = [
    ["pins", "stale-pins", async () => verdict((await readLock()).fingerprint === context.pins.fingerprint ? [] : ["pins.lock.json fingerprint differs from context.pins.fingerprint"])],
    ["scope", "scope-violation", async () => verdict((await scopeCheck({ worktree, base, ...(await scope(feature)) })).violations)],
    ["prepare", "harness", async () => (prepare ? await prepareWorktree(worktree, cwd) : skipped("--no-prepare"))],
    ["typecheck", "typecheck", () => command(context.commands.typecheck, cwd)],
    ["lint", "lint", () => command(context.commands.lint, cwd)],
    ["test", "test", () => unitTests(feature, context, worktree, cwd)],
    ["test-substance", "test-substance", async () => verdict(await testSubstance({ worktree, base, type: feature.type, tests: feature.tests }))],
    ["verification", "verification", () => ticketCommands(feature, context, cwd)],
    ["ui", "ui", () => (context.commands.ui === undefined ? Promise.resolve(skipped("not a UI ticket")) : uiChecks(context, cwd))],
    ["secret-scan", "secret-leak", async () => verdict(await secretScan(worktree, base))],
  ];
  for (const [index, [name, failCode, run]] of steps.entries()) {
    const result = await run();
    report.checks.push({ n: index, name, ...result });
    if (result.status !== "fail") continue;
    if (name === "prepare") throw new Error(`worktree preparation failed: ${result.firstError}`);
    return { ...report, result: "fail", failCode };
  }
  return report;
}

const verdict = (issues: string[]): Omit<CheckResult, "n" | "name"> => ({ status: issues.length === 0 ? "pass" : "fail", detail: issues, ...(issues.length > 0 ? { firstError: issues[0] } : {}) });
const skipped = (reason: string): Omit<CheckResult, "n" | "name"> => ({ status: "skipped", detail: [reason] });

// An unlock moves one locked path from deny to allow for this ticket. The lead reads the diff of that file.
async function scope(feature: Feature) {
  const unlocked = (feature.unlocks ?? []).map(unlock => unlock.path);
  return {
    allow: [...feature.scope.allow, ...unlocked],
    deny: [...new Set([...feature.scope.deny, ...(await globalDeny())])].filter(path => !unlocked.includes(path)),
    maxFiles: feature.scope.max_files,
    maxLines: feature.scope.max_lines,
    maxCommits: Math.max(1, feature.attempts.length),
  };
}

// A worktree has no pinned clones and no node_modules, because git ignores them.
async function prepareWorktree(worktree: string, cwd: string) {
  const pins = await exec(["bun", "run", "pins"], worktree);
  if (pins.exitCode !== 0) return failed(pins.output);
  const install = await exec(["bun", "install", "--frozen-lockfile"], cwd);
  if (install.exitCode !== 0) return failed(install.output);
  // The preparation must not change a tracked file, for example bun.lock.
  return verdict((await $`git -C ${worktree} status --porcelain=v1 --untracked-files=all`.text()).split("\n").filter(Boolean).map(line => `preparation-changed:${line.slice(3)}`));
}

async function command(line: string, cwd: string, env?: Record<string, string | undefined>) {
  if (SHELL_OPERATORS.test(line)) return verdict([`shell-operator-in-command:${line}`]);
  const result = await exec(line.split(/\s+/).filter(Boolean), cwd, env);
  return result.exitCode === 0 ? verdict([]) : { ...failed(result.output), detail: [`${line} exited with ${result.exitCode}`] };
}

const failed = (output: string): Omit<CheckResult, "n" | "name"> => ({ status: "fail", detail: [], firstError: firstErrorLine(output), output: tail(output) });

function firstErrorLine(output: string) {
  const lines = tail(output, 1_000_000).split("\n").map(line => line.trim()).filter(Boolean);
  return (lines.find(line => /\berror\b|✗|\(fail\)|not ok/i.test(line)) ?? lines.at(-1) ?? "").slice(0, 400);
}

async function exec(argv: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: COMMAND_LIMIT_MS });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, output: `${stdout}\n${stderr}${child.signalCode === null ? "" : `\nThe command stopped with ${child.signalCode} (limit ${COMMAND_LIMIT_MS / 1000} s).`}` };
}

// The test script lists its files by name. A new test file is silent until the lead adds it, so the gate runs it directly.
async function unitTests(feature: Feature, context: Context, worktree: string, cwd: string) {
  const all = await command(context.commands.test, cwd);
  if (all.status === "fail") return all;
  const script = ((await Bun.file(resolve(cwd, "package.json")).json()) as { scripts: Record<string, string> }).scripts.test ?? "";
  for (const file of feature.tests.files.filter(file => /\.test\.ts$/.test(file) && !script.split(/\s+/).includes(file.split("/").at(-1)!))) {
    const result = await exec(["bun", "test", file.split("/").at(-1)!], resolve(worktree, file, ".."));
    if (result.exitCode !== 0) return { ...failed(result.output), detail: [`bun test ${file} exited with ${result.exitCode}`] };
  }
  return verdict([]);
}

async function ticketCommands(feature: Feature, context: Context, cwd: string) {
  const done = [context.commands.typecheck, context.commands.lint, context.commands.test];
  for (const line of feature.verification.filter(line => !done.includes(line))) {
    const result = await command(line, cwd);
    if (result.status === "fail") return result;
  }
  return verdict([]);
}

// Playwright starts Electron. ELECTRON_RUN_AS_NODE makes Electron run as plain Node, so the gate removes it.
async function uiChecks(context: Context, cwd: string) {
  const build = await command(context.commands.build ?? "bun run build", cwd);
  if (build.status === "fail") return build;
  const doctor = await exec(["bun", "run", "react-doctor"], cwd);
  const score = /Score:\s*(\d+)\s*\/\s*100/.exec(tail(doctor.output, 1_000_000))?.[1];
  if (doctor.exitCode !== 0 || score !== "100") return { ...failed(doctor.output), detail: [`react-doctor score is ${score ?? "unknown"}, expected 100`] };
  return command(context.commands.ui!, cwd, { ELECTRON_RUN_AS_NODE: undefined });
}

async function secretScan(worktree: string, base: string) {
  const issues: string[] = [];
  let path = "";
  for (const line of (await $`git -C ${worktree} diff --unified=0 ${`${base}..HEAD`}`.text()).split("\n")) {
    if (line.startsWith("+++ ")) path = line.slice(6);
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (line.includes(SYNTHETIC_SECRET) && !matches(["global-sct/tests/**"], path)) issues.push(`synthetic-secret-outside-tests:${path}`);
    if (SECRET_PATTERNS.some(pattern => pattern.test(line))) issues.push(`secret-pattern:${path}`);
  }
  for (const file of (await $`git -C ${worktree} diff --name-only --diff-filter=A ${`${base}..HEAD`}`.text()).split("\n").filter(Boolean)) {
    if (/(^|\/)\.env(\.|$)/.test(file)) issues.push(`env-file-added:${file}`);
  }
  return [...new Set(issues)];
}
