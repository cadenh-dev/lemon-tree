// Gate C check 1: the diff of a worker stays inside the ticket scope.
import { $ } from "bun";
import { matches } from "./lib";

export type ScopeInput = { worktree: string; base: string; allow: string[]; deny: string[]; maxFiles: number; maxLines: number; maxCommits: number };
export type ScopeResult = { paths: string[]; lines: number; commits: number; violations: string[] };

export async function scopeCheck({ worktree, base, allow, deny, maxFiles, maxLines, maxCommits }: ScopeInput): Promise<ScopeResult> {
  const git = (...args: string[]) => $`git -C ${worktree} ${args}`.text().then(text => text.trim());
  const violations: string[] = [];
  // A worker must leave a clean tree. Uncommitted or untracked files are outside the reviewed diff.
  // The first status column can be a space, so the output is not trimmed at its start.
  for (const line of (await $`git -C ${worktree} status --porcelain=v1 --untracked-files=all`.text()).split("\n").filter(Boolean)) violations.push(`uncommitted:${line.slice(3)}`);
  const paths = (await git("diff", "--name-status", "--no-renames", `${base}..HEAD`)).split("\n").filter(Boolean).map(line => line.split("\t")[1]!);
  for (const path of paths) {
    if (matches(deny, path)) violations.push(`denied:${path}`);
    else if (!matches(allow, path)) violations.push(`outside-scope:${path}`);
  }
  // Structural rules that a glob cannot express.
  const modes = await git("diff", "--raw", `${base}..HEAD`);
  if (/^:\d{6} 120000 /m.test(modes)) violations.push("symlink-added");
  if (/^:\d{6} 160000 /m.test(modes)) violations.push("submodule-added");
  const commits = Number(await git("rev-list", "--count", `${base}..HEAD`));
  if (commits === 0) violations.push("no-commit");
  // One commit for the first attempt and one for each repair.
  if (commits > maxCommits) violations.push(`too-many-commits:${commits}`);
  if ((await git("rev-list", "--merges", "--count", `${base}..HEAD`)) !== "0") violations.push("merge-commit");
  if ((await $`git -C ${worktree} merge-base ${base} HEAD`.nothrow().text()).trim() !== (await git("rev-parse", base))) violations.push("history-rewritten");
  const lines = [...(await git("diff", "--shortstat", `${base}..HEAD`)).matchAll(/(\d+) (?:insertion|deletion)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  if (paths.length > maxFiles) violations.push(`too-many-files:${paths.length}`);
  if (lines > maxLines) violations.push(`too-many-lines:${lines}`);
  return { paths, lines, commits, violations };
}
