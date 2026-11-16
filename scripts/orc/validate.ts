#!/usr/bin/env bun
// Validates the task records in global-sct/.agents/tasks against the orchestration schemas.
//   bun scripts/orc/validate.ts                 all task folders
//   bun scripts/orc/validate.ts <task-id> ...   the named task folders
// Exit 0: every record is valid. Exit 1: at least one issue, printed one per line.
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileAt, globalDeny, lineRange, orchestrationDir, readLock, schemaFile, sha256, tasksDir, type Context, type Feature, type Task } from "./lib";
import { loadSchema, validate } from "./schema";

const TASK_STATUS = ["in_progress", "completed", "blocked"];
const CLOSED = ["completed", "superseded"];

if (import.meta.main) {
  const named = Bun.argv.slice(2);
  const issues = (await Promise.all((named.length > 0 ? named : (await readdir(tasksDir)).sort()).map(validateTask))).flat();
  for (const issue of issues) console.error(issue);
  console.log(issues.length === 0 ? "All task records are valid." : `${issues.length} issues.`);
  process.exit(issues.length === 0 ? 0 : 1);
}

export async function validateTask(taskId: string): Promise<string[]> {
  const dir = resolve(tasksDir, taskId);
  const at = (file: string) => `${taskId}/${file}`;
  const task = (await Bun.file(`${dir}/task.json`).json()) as Task;
  const context = (await Bun.file(`${dir}/context.json`).json()) as Context;
  const issues = validate(await loadSchema(schemaFile("context")), context).map(issue => `${at("context.json")} ${issue}`);
  if (task.task_id !== taskId || context.task_id !== taskId) issues.push(`${at("task.json")} task_id must equal the folder name in task.json and context.json`);
  if (!TASK_STATUS.includes(task.status)) issues.push(`${at("task.json")} status ${task.status} is not one of ${TASK_STATUS.join(", ")}`);

  const files = (await readdir(`${dir}/features`)).filter(name => /^FEAT-\d{3}\.json$/.test(name)).sort();
  if (JSON.stringify(files.map(name => name.slice(0, -5))) !== JSON.stringify([...task.feature_order].sort())) issues.push(`${at("task.json")} feature_order does not match the files in features/`);
  const features: Feature[] = [];
  for (const file of files) {
    const feature = (await Bun.file(`${dir}/features/${file}`).json()) as Feature;
    const structural = validate(await loadSchema(schemaFile("feature")), feature).map(issue => `${at(`features/${file}`)} ${issue}`);
    issues.push(...structural);
    if (structural.length > 0) continue;
    features.push(feature);
    issues.push(...(await featureRules(feature, context, files)).map(issue => `${at(`features/${file}`)} ${issue}`));
  }
  if (features.length === files.length && task.status !== derivedStatus(features)) issues.push(`${at("task.json")} status is ${task.status}, and the features give ${derivedStatus(features)}`);
  return issues;
}

/** `completed` when every feature is closed. `blocked` when a feature is blocked and no feature can run. Otherwise `in_progress`. */
export function derivedStatus(features: Pick<Feature, "status">[]) {
  if (features.every(feature => CLOSED.includes(feature.status))) return "completed";
  return features.some(feature => feature.status === "blocked") && features.every(feature => [...CLOSED, "blocked"].includes(feature.status)) ? "blocked" : "in_progress";
}

async function featureRules(feature: Feature, context: Context, files: string[]) {
  const issues: string[] = [];
  const deny = await globalDeny();
  const unlocked = (feature.unlocks ?? []).map(unlock => unlock.path);
  issues.push(...deny.filter(path => !feature.scope.deny.includes(path) && !unlocked.includes(path)).map(path => `scope.deny does not include the global entry ${path}`));
  issues.push(...unlocked.filter(path => !deny.includes(path)).map(path => `unlocks names ${path}, which is not a locked path`));
  issues.push(...feature.depends_on.filter(id => /^FEAT-\d{3}$/.test(id) && !files.includes(`${id}.json`)).map(id => `depends_on names ${id}, which does not exist in this task`));
  if (feature.id !== feature.id.trim() || !files.includes(`${feature.id}.json`)) issues.push(`id ${feature.id} does not match its file name`);
  if (feature.status === "completed" && feature.findings.trim() === "") issues.push("a completed feature needs findings");
  if (feature.status === "blocked" && feature.blocked_reason === null) issues.push("a blocked feature needs blocked_reason");
  if (feature.tests.min_cases === 0 && ["feat", "fix", "test"].includes(feature.type) && !CLOSED.includes(feature.status) && !/min_cases/.test(feature.findings)) issues.push("min_cases is 0, and findings do not give the reason (write a sentence that names min_cases)");
  const accepted = await acceptedClaims();
  issues.push(...(feature.researchRefs ?? []).filter(ref => !accepted.has(ref)).map(ref => `researchRefs names ${ref}, which no adjudication accepted`));
  // A closed feature keeps its contracts as a record. An open feature must cite text that exists at the base.
  if (!CLOSED.includes(feature.status)) issues.push(...(await contractIssues(feature, context)));
  return issues;
}

/** Each contract must hash to its recorded value at the base commit (workspace) or at the pin (agtop, toolkit). */
export async function contractIssues(feature: Pick<Feature, "contracts">, context: Pick<Context, "base" | "pins">) {
  const lock = await readLock();
  const commit = { workspace: context.base.commit, agtop: lock.agtop.sha, toolkit: lock.subagentclassifiertoolkit.sha };
  const issues: string[] = [];
  for (const contract of feature.contracts) {
    const file = await fileAt(contract.repo, commit[contract.repo], contract.path);
    const text = file === null ? null : lineRange(file, contract.startLine, contract.endLine);
    if (text === null) issues.push(`contract ${contract.symbol}: ${contract.repo}:${contract.path}:${contract.startLine}-${contract.endLine} is not at ${commit[contract.repo].slice(0, 7)}`);
    else if (sha256(text) !== contract.sha256 || text !== contract.text) issues.push(`contract ${contract.symbol}: the text or hash differs from ${contract.repo}:${contract.path} at ${commit[contract.repo].slice(0, 7)}`);
  }
  return issues;
}

async function acceptedClaims() {
  const dir = resolve(orchestrationDir, "adjudications");
  const accepted = new Set<string>();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    for (const item of ((await Bun.file(`${dir}/${name}`).json()) as { accepted?: { claim: string }[] }).accepted ?? []) accepted.add(item.claim);
  }
  return accepted;
}
