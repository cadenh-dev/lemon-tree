// Fixture tests for the research route, the research sandbox check, and the pin-move protocol.
// Each test uses a small real git repository. No mock of git.
import { $ } from "bun";
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { changedRanges, snapshot, ticketImpact } from "../impact";
import { sha256, type Feature } from "../lib";
import { externalState, revalidate } from "../revalidate";
import { checkSandbox, routeResearch, type Caps } from "../route-research";

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(resolve(tmpdir(), "orc-pin-"));
  made.push(dir);
  await $`git -C ${dir} init --quiet --initial-branch=main`;
  await $`git -C ${dir} config user.email fixture@example.invalid`;
  await $`git -C ${dir} config user.name fixture`;
  return { dir, commit: await commit(dir, files) };
}

async function commit(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(dir, path)), { recursive: true });
    await Bun.write(resolve(dir, path), text);
  }
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit --quiet -m change`;
  return (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
}

const caps = (models: string[], extra: object = {}): Caps => ({
  providers: [
    { providerInstanceId: "opencode", canRunChildTask: true, constraints: [], models: [{ id: "opencode/gemini-4-hydrogen" }] },
    { providerInstanceId: "antigravity", canRunChildTask: true, constraints: [], models: models.map(id => ({ id })), ...extra },
  ],
});

test("the research route uses the fallback today and the preferred model when Antigravity lists it", () => {
  expect(routeResearch(caps(["gemini-3.8-flash"]), null, 10)).toEqual({ providerInstanceId: "antigravity", model: "gemini-3.8-flash", options: { thinking_level: "high" }, reason: "fallback-not-listed", boundAt: 10 });
  expect(routeResearch(caps(["gemini-3.8-flash", "gemini-4-hydrogen"]), null, 10).reason).toBe("preferred");
  expect(routeResearch(caps(["gemini-3.8-flash", "gemini-4-hydrogen"]), 20, 10)).toMatchObject({ model: "gemini-3.8-flash", reason: "fallback-rate-limited" });
  expect(routeResearch(caps(["gemini-3.8-flash", "gemini-4-hydrogen"]), 20, 30).model).toBe("gemini-4-hydrogen");
  expect(() => routeResearch(caps([]), null, 10)).toThrow("research-tier-unavailable");
  expect(() => routeResearch(caps(["gemini-3.8-flash"], { constraints: ["Provider instance is disabled."] }), null, 10)).toThrow("research-tier-unavailable");
  expect(() => routeResearch(caps(["gemini-3.8-flash"], { canRunChildTask: false }), null, 10)).toThrow("research-tier-unavailable");
});

test("a research run that writes a file or makes a commit is tainted", async () => {
  const { dir, commit: start } = await repo({ "a.txt": "one\n" });
  expect(await checkSandbox(dir, start)).toEqual({ tainted: false, reasons: [] });
  await Bun.write(resolve(dir, "notes.md"), "x\n");
  expect(await checkSandbox(dir, start)).toEqual({ tainted: true, reasons: ["changed:notes.md"] });
  const moved = await commit(dir, {});
  expect(await checkSandbox(dir, start)).toEqual({ tainted: true, reasons: [`head-moved:${moved}`] });
});

const SOURCE = ["export interface Tree {", "  jobId: string", "}", "", "export function kill(id: string) {", "  return id", "}", ""].join("\n");
const cite = (text: string, start: number, end: number) => ({ repo: "agtop" as const, path: "src/types.ts", startLine: start, endLine: end, sha256: sha256(text.split("\n").slice(start - 1, end).join("\n")) });

test("after a synthetic pin move, an unchanged claim stays valid, a moved one gets a new range, and a changed one is invalid", async () => {
  const { dir } = await repo({ "src/types.ts": SOURCE });
  const moved = await commit(dir, { "src/types.ts": `// header\n// header 2\n${SOURCE.replace("return id", "return id.trim()")}` });
  expect(await revalidate(cite(SOURCE, 1, 3), moved, dir)).toEqual({ state: "moved", startLine: 3, endLine: 5, oldRange: [1, 3] });
  expect(await revalidate(cite(SOURCE, 5, 7), moved, dir)).toEqual({ state: "invalid", reason: "text-changed" });
  const appended = await commit(dir, { "src/types.ts": `// header\n// header 2\n${SOURCE}export const added = 1\n` });
  expect(await revalidate({ ...cite(SOURCE, 1, 3), startLine: 3, endLine: 5 }, appended, dir)).toEqual({ state: "valid" });
  expect(await revalidate({ ...cite(SOURCE, 1, 3), path: "src/gone.ts" }, appended, dir)).toEqual({ state: "invalid", reason: "file-absent" });
  expect(externalState("2026-11-01", Date.parse("2026-11-15"))).toBe("valid");
  expect(externalState("2026-10-01", Date.parse("2026-11-15"))).toBe("aging");
});

test("the changed line ranges of a commit pair name each file", async () => {
  const { dir, commit: first } = await repo({ "a.txt": "1\n2\n3\n4\n", "b.txt": "b\n" });
  const second = await commit(dir, { "a.txt": "1\ntwo\n3\n4\n", "c.txt": "new\n" });
  expect((await changedRanges(dir, first, second)).map(file => `${file.path}:${JSON.stringify(file.ranges)}`)).toEqual(["a.txt:[[2,2]]", "c.txt:[[0,0]]"]);
});

const feature = (status: string, contracts: Feature["contracts"], allow: string[]): Feature => ({
  schema: 2, id: "FEAT-001", type: "feat", description: "", status, depends_on: [], scope: { allow, deny: [], max_files: 1, max_lines: 1 }, contracts, steps: [],
  acceptance_criteria: [], verification: [], tests: { files: [], must_add: [], min_cases: 0 }, budget: { context_tokens: 0, wall_clock_minutes: 0 },
  route: { providerInstanceId: "opencode", model: "m", options: {}, classified_by: "lead-pinned", policy_hash: "" }, attempts: [], blocked_reason: null, findings: "",
});

test("a ticket is affected by a changed contract, a missing capability, or a changed file in its scope", async () => {
  const upstream = await repo({ "src/types.ts": SOURCE });
  const newPin = await commit(upstream.dir, { "src/types.ts": SOURCE.replace("jobId: string", "jobId: number") });
  const workspace = await repo({ "global-sct/src/main/a.ts": "a\n", "global-sct/src/main/b.ts": "b\n" });
  const newBase = await commit(workspace.dir, { "global-sct/src/main/b.ts": "b2\n" });
  const contract = (start: number, end: number) => ({ ...cite(SOURCE, start, end), symbol: "S", text: "", role: "call" });
  const input = { oldBase: workspace.commit, newBase, commits: { workspace: newBase, agtop: newPin, toolkit: newPin }, dirs: { workspace: workspace.dir, agtop: upstream.dir, toolkit: upstream.dir }, capabilities: ["agtop.trees"], required: ["agtop.trees"] };
  const impact = async (item: Feature, extra: object = {}) => {
    const result = await ticketImpact(item, "task-x/FEAT-001", { ...input, ...extra });
    return [result.affected, result.rules, result.action.split(";")[0]];
  };
  expect(await impact(feature("ready", [contract(5, 7)], ["global-sct/src/main/a.ts"]))).toEqual([false, [], "update context.pins only"]);
  expect(await impact(feature("ready", [contract(1, 3)], ["global-sct/src/main/a.ts"]))).toEqual([true, ["1:contract S text-changed"], "set stale"]);
  expect(await impact(feature("dispatched", [], ["global-sct/src/main/**"]))).toEqual([true, ["4:global-sct/src/main/b.ts changed on the base"], "let the run end, then snapshot, rebase, or supersede"]);
  expect(await impact(feature("dispatched", [], ["global-sct/src/main/a.ts"]))).toEqual([false, [], "rebase the worktree branch onto the new base and run Gate C again"]);
  expect(await impact(feature("review", [], ["global-sct/src/main/a.ts"]), { capabilities: [] })).toEqual([true, ["3:capability agtop.trees is missing"], "set stale and keep the diff"]);
  expect(await impact(feature("completed", [contract(1, 3)], ["global-sct/src/main/**"]))).toEqual([true, ["1:contract S text-changed", "4:global-sct/src/main/b.ts changed on the base"], "none: the ticket is closed"]);
});

test("the snapshot of an affected worktree keeps its patch and its tag", async () => {
  const { dir, commit: base } = await repo({ "a.txt": "one\n" });
  const head = await commit(dir, { "a.txt": "two\n" });
  const out = resolve(dir, "..", `${dir.split("/").at(-1)}-attempts`);
  made.push(out);
  const kept = await snapshot(dir, base, out, "orc/task-x/FEAT-001/pre-e1");
  expect(kept.patches.length).toBe(1);
  expect(await Bun.file(resolve(out, (await readdir(out))[0]!)).text()).toContain("+two");
  expect((await $`git -C ${dir} rev-parse orc/task-x/FEAT-001/pre-e1`.text()).trim()).toBe(head);
});
