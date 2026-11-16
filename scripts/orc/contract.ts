#!/usr/bin/env bun
// Copies one contract entry for a ticket from a cited commit. A signature is never typed by a model.
//   bun scripts/orc/contract.ts <repo> <path> <startLine> <endLine> <symbol> <role> [commit]
// repo: workspace | agtop | toolkit. role: implement | call | extend | read-only.
// The default commit is HEAD for the workspace, and the pin for agtop and the toolkit.
import { $ } from "bun";
import { fileAt, lineRange, readLock, repoDir, root, sha256, type Repo } from "./lib";

const [repo, path, start, end, symbol, role, commit] = Bun.argv.slice(2) as [Repo, string, string, string, string, string, string | undefined];
if (!(repo in repoDir) || role === undefined) throw new Error("Usage: contract.ts <repo> <path> <startLine> <endLine> <symbol> <role> [commit]");
const lock = await readLock();
const at = commit ?? { workspace: (await $`git -C ${root} rev-parse HEAD`.text()).trim(), agtop: lock.agtop.sha, toolkit: lock.subagentclassifiertoolkit.sha }[repo];
const file = await fileAt(repo, at, path);
const text = file === null ? null : lineRange(file, Number(start), Number(end));
if (text === null) throw new Error(`${repo}:${path}:${start}-${end} is not at ${at}`);
console.log(JSON.stringify({ symbol, repo, path, startLine: Number(start), endLine: Number(end), sha256: sha256(text), text, role }, null, 2));
