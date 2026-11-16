#!/usr/bin/env bun
// The upstream mutation protocol: freeze, impact, ticket invalidation, and the snapshot of in-progress work.
//   bun scripts/orc/impact.ts status                          print freeze state and pin state (exit 5 when frozen or the pins moved)
//   bun scripts/orc/impact.ts freeze <event-id> <reason>      stop new dispatches
//   bun scripts/orc/impact.ts resume                          remove the freeze
//   bun scripts/orc/impact.ts tickets <old-base> <new-base>   list each open ticket that the base move affects
//   bun scripts/orc/impact.ts snapshot <task> <feat> <event-id>   keep the work of a worktree as patches and a tag
// A file watcher is not used. The lead calls `status` before each dispatch and each state transition.
import { $ } from "bun";
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { matches, orchestrationDir, readFeature, readLock, readTask, repoDir, root, sha256, tasksDir, type Feature, type Repo } from "./lib";
import { revalidate } from "./revalidate";

const freezeFile = resolve(orchestrationDir, "freeze.json");
const OPEN = ["draft", "ready", "dispatched", "verifying", "repair", "review"];

export type ChangedFile = { path: string; ranges: [number, number][] };

/** Files and old-side line ranges that differ between two commits of one repository. */
export async function changedRanges(dir: string, oldCommit: string, newCommit: string): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for (const line of (await $`git -C ${dir} diff --unified=0 --no-renames ${oldCommit} ${newCommit}`.text()).split("\n")) {
    if (line.startsWith("--- ")) files.push({ path: line === "--- /dev/null" ? "" : line.slice(6), ranges: [] });
    else if (line.startsWith("+++ ") && files.at(-1)!.path === "") files.at(-1)!.path = line.slice(6);
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (hunk !== null) files.at(-1)!.ranges.push([Number(hunk[1]), Number(hunk[1]) + Math.max(Number(hunk[2] ?? 1), 1) - 1]);
  }
  return files;
}

export type TicketImpact = { ticket: string; status: string; affected: boolean; rules: string[]; action: string };

/**
 * A ticket is affected when a contract no longer hashes to its value (rule 1), a required capability is now
 * missing (rule 3), or a file in scope.allow changed between the old base and the new base (rule 4).
 * Rule 2 (an invalid research claim) applies when a ticket has researchRefs; the lead checks it with verify-claims.
 */
export async function ticketImpact(feature: Feature, ticket: string, input: { oldBase: string; newBase: string; commits: Record<Repo, string>; dirs: Record<Repo, string>; capabilities: string[]; required: string[] }): Promise<TicketImpact> {
  const rules: string[] = [];
  for (const contract of feature.contracts) {
    const state = await revalidate(contract, input.commits[contract.repo], input.dirs[contract.repo]);
    if (state.state === "invalid") rules.push(`1:contract ${contract.symbol} ${state.reason}`);
  }
  for (const capability of input.required.filter(capability => !input.capabilities.includes(capability))) rules.push(`3:capability ${capability} is missing`);
  for (const file of await changedRanges(input.dirs.workspace, input.oldBase, input.newBase)) if (matches(feature.scope.allow, file.path)) rules.push(`4:${file.path} changed on the base`);
  const affected = rules.length > 0;
  const action = !OPEN.includes(feature.status) ? "none: the ticket is closed"
    : ["draft", "ready"].includes(feature.status) ? (affected ? "set stale; the lead regenerates contracts by script and reviews the steps" : "update context.pins only")
    : ["dispatched", "repair"].includes(feature.status) ? (affected ? "let the run end, then snapshot, rebase, or supersede" : "rebase the worktree branch onto the new base and run Gate C again; no attempt is counted")
    : affected ? "set stale and keep the diff" : "run Gate C again on the new base";
  return { ticket, status: feature.status, affected, rules, action };
}

/** Keeps the work of a worktree before a rebase: one patch for each commit and a tag on the branch head. */
export async function snapshot(worktree: string, baseCommit: string, outDir: string, tag: string) {
  await mkdir(outDir, { recursive: true });
  const patches = (await $`git -C ${worktree} format-patch --quiet ${`${baseCommit}..HEAD`} -o ${outDir}`.text()).trim();
  await $`git -C ${worktree} tag --force ${tag} HEAD`.quiet();
  return { patches: (await readdir(outDir)).filter(name => name.endsWith(".patch")).sort(), tag, output: patches };
}

export async function frozen() {
  return (await Bun.file(freezeFile).exists()) ? ((await Bun.file(freezeFile).json()) as { eventId: string; reason: string; at: string }) : null;
}

if (import.meta.main) {
  const [command, ...args] = Bun.argv.slice(2);
  if (command === "status") {
    const freeze = await frozen();
    const lockNow = (await $`bun scripts/pins.ts --check`.cwd(root).nothrow().quiet()).exitCode === 0;
    console.log(JSON.stringify({ frozen: freeze, pinsCurrent: lockNow, fingerprint: (await readLock()).fingerprint }, null, 2));
    process.exit(freeze === null && lockNow ? 0 : 5);
  } else if (command === "freeze" && args.length >= 2) {
    await Bun.write(freezeFile, `${JSON.stringify({ eventId: args[0], reason: args.slice(1).join(" "), at: new Date().toISOString() }, null, 2)}\n`);
  } else if (command === "resume") {
    await rm(freezeFile, { force: true });
  } else if (command === "tickets" && args.length === 2) {
    const lock = await readLock();
    const capabilities = ((await Bun.file(resolve(root, "pins.lock.json")).json()) as { capabilities: { present: string[] } }).capabilities.present;
    const impacts: TicketImpact[] = [];
    for (const taskId of (await readdir(tasksDir)).sort()) {
      const { task, context } = await readTask(taskId);
      for (const featId of task.feature_order) {
        impacts.push(await ticketImpact(await readFeature(taskId, featId), `${taskId}/${featId}`, {
          oldBase: args[0]!, newBase: args[1]!, dirs: repoDir, capabilities, required: context.capabilities ?? [],
          commits: { workspace: args[1]!, agtop: lock.agtop.sha, toolkit: lock.subagentclassifiertoolkit.sha },
        }));
      }
    }
    // Each invalidation leaves one line, so the lead can audit why a ticket went stale.
    for (const impact of impacts.filter(impact => impact.affected && impact.status !== "completed" && impact.status !== "superseded")) {
      await appendFile(resolve(orchestrationDir, "invalidation.ndjson"), `${JSON.stringify({ event: sha256(`${args[0]}${args[1]}`).slice(0, 12), at: new Date().toISOString(), oldBase: args[0], newBase: args[1], ...impact })}\n`);
    }
    console.log(JSON.stringify(impacts, null, 2));
  } else if (command === "snapshot" && args.length === 3) {
    const feature = await readFeature(args[0]!, args[1]!);
    if (!feature.worktree?.path || !feature.worktree.base_commit) throw new Error("The ticket has no worktree.");
    console.log(JSON.stringify(await snapshot(feature.worktree.path, feature.worktree.base_commit, resolve(tasksDir, args[0]!, "attempts", `${args[1]}-${Math.max(1, feature.attempts.length)}`), `orc/${args[0]}/${args[1]}/pre-${args[2]}`), null, 2));
  } else {
    console.error("Usage: impact.ts status | freeze <event-id> <reason> | resume | tickets <old-base> <new-base> | snapshot <task> <feat> <event-id>");
    process.exit(2);
  }
}
