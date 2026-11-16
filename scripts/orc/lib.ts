// Shared paths and helpers for the orchestration scripts.
import { $ } from "bun";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const root = resolve(import.meta.dir, "../..");
export const orchestrationDir = resolve(root, "global-sct/.agents/orchestration");
export const tasksDir = resolve(root, "global-sct/.agents/tasks");
export const schemaFile = (name: "research-packet" | "context" | "feature") => resolve(orchestrationDir, `schemas/${name}.schema.json`);
export const repoDir = { workspace: root, agtop: resolve(root, "agtop"), toolkit: resolve(root, "subagentclassifiertoolkit") } as const;
export type Repo = keyof typeof repoDir;

export type Lock = { fingerprint: string; agtop: { sha: string }; subagentclassifiertoolkit: { sha: string } };
export const readLock = async () => (await Bun.file(resolve(root, "pins.lock.json")).json()) as Lock;
export const globalDeny = async () => (await Bun.file(resolve(orchestrationDir, "schemas/deny.json")).json()) as string[];

export const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

export const matches = (patterns: string[], path: string) => patterns.some(pattern => new Bun.Glob(pattern).match(path));

/** The text of a file at a commit, from the git objects. `null` when the commit has no such file. */
export async function fileAt(repo: Repo, commit: string, path: string, dir: string = repoDir[repo]) {
  const blob = await $`git -C ${dir} show ${`${commit}:${path}`}`.nothrow().quiet();
  return blob.exitCode === 0 ? blob.stdout.toString("utf8") : null;
}

/** Lines `startLine..endLine` joined with `\n`, with no final newline. `null` when the range is not in the text. */
export function lineRange(text: string, startLine: number, endLine: number) {
  const lines = text.split("\n");
  return startLine < 1 || endLine < startLine || endLine > lines.length ? null : lines.slice(startLine - 1, endLine).join("\n");
}

/** Removes ANSI codes and keeps the two ends of long output. The middle is cut, not the end. */
export function tail(output: string, limit = 6000) {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").slice(-120).join("\n");
  return plain.length <= limit ? plain : `${plain.slice(0, limit / 3)}\n… ${plain.length - limit} characters cut …\n${plain.slice(-(2 * limit) / 3)}`;
}

export type Feature = {
  schema: 2; id: string; type: "feat" | "fix" | "test" | "chore" | "docs"; description: string; status: string; depends_on: string[]
  supersedes?: string | null
  scope: { allow: string[]; deny: string[]; max_files: number; max_lines: number }
  unlocks?: { path: string; change: string; approved_by: string; approved_at: string }[]
  contracts: { symbol: string; repo: Repo; path: string; startLine: number; endLine: number; sha256: string; text: string; role: string }[]
  steps: string[]; acceptance_criteria: string[]; verification: string[]
  tests: { files: string[]; must_add: string[]; min_cases: number }
  researchRefs?: string[]
  budget: { context_tokens: number; wall_clock_minutes: number }
  route: { providerInstanceId: string; model: string; options: Record<string, unknown>; classified_by: string; policy_hash: string }
  worktree?: { path?: string; branch?: string; base_commit?: string; head_commit?: string | null } | null
  attempts: { n: number; kind: string; started_at: string; report: string }[]
  blocked_reason: { code: string; retryable: boolean; detail: string } | null
  findings: string
};
export type Context = {
  schema: 2; task_id: string; wave: string; base: { commit: string; branch: string }; pins: { agtop: string; toolkit: string; fingerprint: string }
  commands: { cwd: string; typecheck: string; lint: string; test: string; build?: string; ui?: string }
  relevant_files: string[]; locked_files: string[]; capabilities?: string[]
};
export type Task = { task_id: string; task_description: string; status: string; feature_order: string[]; blocked_reason: unknown };

export async function readTask(taskId: string) {
  const dir = resolve(tasksDir, taskId);
  const task = (await Bun.file(`${dir}/task.json`).json()) as Task;
  return { dir, task, context: (await Bun.file(`${dir}/context.json`).json()) as Context };
}
export const readFeature = async (taskId: string, featId: string) => (await Bun.file(resolve(tasksDir, taskId, `features/${featId}.json`)).json()) as Feature;
