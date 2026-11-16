#!/usr/bin/env bun
// Prepares one dispatch of a coding ticket. The lead runs the printed command in the background.
//   bun scripts/orc/dispatch.ts <task-id> <feat-id> [--repair <gate-report.json>] [--variant low|high|max]
// The script gates the dispatch, creates the worktree (first attempt), prepares it, writes the brief,
// and moves the ticket to `dispatched`. It does not start the worker.
// Exit 0: ready to start. Exit 1: a gate refused the dispatch. Exit 3: offpeak-deferred.
import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { frozen } from "./impact";
import { matches, readFeature, readLock, readTask, root, tail, tasksDir, type Feature } from "./lib";
import { derivedStatus, validateTask } from "./validate";
import type { Report } from "./verify-ticket";

const FIXED_ENDING = [
  "Edit only paths that match `scope.allow`. Do not edit a path in `scope.deny`. Do not run `git push`, `git merge`, `git rebase`, `git reset`, or `git checkout` of another branch.",
  "Do not change `package.json` or `bun.lock`. Do not install a dependency. Commit your work on the current branch with one commit.",
  "If a step needs a change outside the scope, stop and write the exact needed change in your final message under the heading `SCOPE REQUEST`.",
  "Never run `tsc` directly; use the package scripts.",
].join(" ");
const RUNNING = ["dispatched", "verifying", "repair", "review"];
const TOKEN_LIMIT = 24_000;

const args = Bun.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const [taskId, featId] = args as [string, string];
if (taskId === undefined || featId === undefined) refuse("Usage: dispatch.ts <task-id> <feat-id> [--repair <gate-report.json>] [--variant low|high|max]");
const repairReport = option("--repair");

const invalid = await validateTask(taskId);
if (invalid.length > 0) refuse(`The task records are not valid:\n${invalid.join("\n")}`);
const { dir, task, context } = await readTask(taskId);
const feature = await readFeature(taskId, featId);
const attempt = feature.attempts.length + 1;
if (repairReport === undefined ? feature.status !== "ready" : feature.status !== "repair") refuse(`The ticket status is ${feature.status}. A first dispatch needs ready, and a repair needs repair.`);
if (attempt > 3) refuse("The ticket has 3 attempts. Escalate to the lead.");

// Gate: no freeze, current pins, and the off-peak scheduler.
if ((await frozen()) !== null) refuse("Dispatch is frozen (freeze.json).");
if ((await $`bun scripts/pins.ts --check`.cwd(root).nothrow().quiet()).exitCode !== 0) refuse("bun run pins:check failed. Run the pin protocol first.");
if ((await readLock()).fingerprint !== context.pins.fingerprint) refuse("stale-pins: context.pins.fingerprint differs from pins.lock.json.");
const offpeak = await $`python3 ${resolve(homedir(), ".config/opencode/skills/offpeak-scheduler/scripts/offpeak.py")} gate --opt-in --target opencode-go:deepseek-v4.1-flash`.nothrow().quiet();
if (offpeak.exitCode === 3) {
  console.error(`offpeak-deferred: ${offpeak.stdout.toString().trim()}`);
  process.exit(3);
}

// Gate: no other running ticket can write a path that this ticket can write.
for (const other of await runningTickets()) {
  const shared = await intersection(feature.scope.allow, other.feature.scope.allow);
  if (shared !== null) refuse(`scope-intersection with ${other.ticket} (${other.feature.status}): ${shared}`);
}
// Gate: each dependency in this task is closed.
for (const id of feature.depends_on.filter(id => /^FEAT-\d{3}$/.test(id))) {
  if (!["completed", "superseded"].includes((await readFeature(taskId, id)).status)) refuse(`The dependency ${id} is not completed.`);
}

// The worker sees the ticket without the fields of the lead. The mutations stay with the lead, so a test cannot target them.
const { attempts: _attempts, worktree: _worktree, route: _route, findings: _findings, blocked_reason: _blocked, status: _status, ...visible } = feature;
const { mutations: _mutations, ...tests } = feature.tests as Feature["tests"] & { mutations?: unknown };
const contextText = await Bun.file(`${dir}/context.json`).text();
const ticketText = JSON.stringify({ ...visible, tests }, null, 2);
const base = feature.worktree?.base_commit ?? context.base.commit;
const existing = (await $`git -C ${root} ls-tree -r --name-only ${base}`.text()).split("\n").filter(path => path !== "" && matches(feature.scope.allow, path));
const sizes = await Promise.all(existing.map(async path => (await $`git -C ${root} cat-file -s ${`${base}:${path}`}`.text()).trim()));
const tokens = Math.ceil((contextText.length + ticketText.length + sizes.reduce((sum, size) => sum + Number(size), 0)) / 4);
if (tokens > Math.min(feature.budget.context_tokens, TOKEN_LIMIT)) refuse(`context budget: ${tokens} tokens is more than ${Math.min(feature.budget.context_tokens, TOKEN_LIMIT)}. Split the ticket.`);

// The worktree. A repair continues in the same worktree and adds one commit.
const branch = `agent/${taskId}/${featId}`;
const worktree = feature.worktree?.path ?? resolve(homedir(), ".t3/worktrees/lemon-tree", `orc-${taskId}-${featId}`);
// With --t3 the worker is a T3 subagent (decision S4). T3 creates the worktree, so this script only gates and writes the brief.
const t3 = args.includes("--t3");
if (repairReport === undefined && !t3) {
  await $`git -C ${root} worktree add --quiet -b ${branch} ${worktree} ${base}`;
  await $`bun run pins`.cwd(worktree).quiet();
  await $`bun install --frozen-lockfile`.cwd(resolve(worktree, context.commands.cwd)).quiet();
}

const briefFile = resolve(dir, "attempts", `${featId}-${attempt}.brief.md`);
const reportFile = resolve(dir, "attempts", `${featId}-${attempt}.gate.json`);
await mkdir(resolve(dir, "attempts"), { recursive: true });
await Bun.write(briefFile, [
  "You are a child task. Do not run a session kickoff script. Do not start subagents.",
  t3
    ? `You implement exactly one ticket in the git worktree at your current directory, on its current branch. Product commands run from \`${context.commands.cwd}/\`. First prepare the worktree: run \`bun run pins\` from the repository root, then \`bun install --frozen-lockfile\` from \`${context.commands.cwd}/\`. On this machine you can run only the static checks \`bun run typecheck:tsc\` and \`bun run lint\`. Do not run unit tests, the build, or the app here: a test machine runs them after your commit. Write the tests with care, because you cannot run them.`
    : `You implement exactly one ticket in the git worktree at your current directory, on branch \`${branch}\`. Product commands run from \`${context.commands.cwd}/\`. The worktree is prepared: the pinned clones and the dependencies are present.`,
  "## context.json", "```json", contextText.trim(), "```",
  "## Ticket", "```json", ticketText, "```",
  ...(repairReport === undefined ? [] : [await repairSection(repairReport)]),
  "## Rules", FIXED_ENDING,
  "Final message: the files that you changed, each verification command with its exit code, and any SCOPE REQUEST.",
].join("\n\n"));

const variant = option("--variant") ?? (attempt === 3 ? "max" : String(feature.route.options.variant ?? "high"));
feature.status = "dispatched";
feature.worktree = { path: t3 ? (feature.worktree?.path ?? "") : worktree, branch, base_commit: base, head_commit: null };
feature.attempts.push({ n: attempt, kind: repairReport === undefined ? "initial" : "repair", started_at: new Date().toISOString(), report: reportFile.slice(root.length + 1) });
await Bun.write(resolve(tasksDir, taskId, `features/${featId}.json`), `${JSON.stringify(feature, null, 2)}\n`);
task.status = derivedStatus(await Promise.all(task.feature_order.map(id => readFeature(taskId, id))));
await Bun.write(`${dir}/task.json`, `${JSON.stringify(task, null, 2)}\n`);

const log = resolve(dir, "attempts", `${featId}-${attempt}.worker.log`);
console.log(JSON.stringify({
  ticket: `${taskId}/${featId}`, attempt, variant, worktree, branch, base, tokens, briefFile, reportFile, log,
  start: `cd ${worktree} && agtop run --harness opencode --id orc-${taskId}-${featId}-${attempt} -- opencode run --agent lt-coder --model 'opencode-go/deepseek-v4.1-flash#${variant}' --auto "$(cat ${briefFile})" > ${log} 2>&1`,
  verify: `bun scripts/orc/verify-ticket.ts ${taskId} ${featId} --report ${reportFile}`,
}, null, 2));

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

async function runningTickets() {
  const found: { ticket: string; feature: Feature }[] = [];
  for (const other of await Array.fromAsync(new Bun.Glob("*/features/FEAT-*.json").scan(tasksDir))) {
    const item = (await Bun.file(resolve(tasksDir, other)).json()) as Feature;
    const ticket = `${other.split("/")[0]}/${item.id}`;
    if (ticket !== `${taskId}/${featId}` && RUNNING.includes(item.status)) found.push({ ticket, feature: item });
  }
  return found;
}

// Two glob sets intersect when one path can match both. The candidates are the tracked files, each literal
// pattern, and each pattern with its wildcards replaced, which covers a new file below a shared directory.
async function intersection(left: string[], right: string[]) {
  const tracked = (await $`git -C ${root} ls-files`.text()).split("\n").filter(Boolean);
  const probes = [...left, ...right].flatMap(pattern => [pattern, pattern.replaceAll("**", "x/y").replaceAll("*", "x")]);
  return [...tracked, ...probes].find(path => matches(left, path) && matches(right, path)) ?? null;
}

// The repair brief has the failed check, the exit detail, and the end of the output. It is capped at 6,000 characters.
async function repairSection(file: string) {
  const report = (await Bun.file(file).json()) as Report;
  const failed = report.checks.find(check => check.status === "fail");
  return [
    "## Repair",
    `Gate C rejected your last commit. Continue in this worktree and add one commit. Failed check: \`${failed?.name}\` (fail code \`${report.failCode}\`).`,
    ...(failed?.detail ?? []).map(line => `- ${line}`),
    "```", tail(failed?.output ?? failed?.firstError ?? "", 6000), "```",
  ].join("\n");
}
