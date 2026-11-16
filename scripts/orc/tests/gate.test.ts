// Fixture tests for Gate C checks 1 and 5. Each test builds a small real git repository. No mock of git.
import { $ } from "bun";
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { scopeCheck } from "../scope-check";
import { testSubstance } from "../test-substance";

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

const ALLOW = ["global-sct/src/main/thing.ts", "global-sct/tests/thing.test.ts"];
const DENY = ["global-sct/src/shared/contracts.ts", "scripts/**"];
const IMPLEMENTATION = "export const limit = 4\nexport const double = (value: number) => value * 2\n";
const REAL_TEST = `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { double, limit } from '../src/main/thing'\n\ntest('double multiplies by two', () => {\n  assert.equal(double(limit), 8)\n})\n`;

async function fixture(files: Record<string, string> = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "orc-fixture-"));
  made.push(dir);
  await $`git -C ${dir} init --quiet --initial-branch=main`;
  await $`git -C ${dir} config user.email fixture@example.invalid`;
  await $`git -C ${dir} config user.name fixture`;
  await write(dir, { "README.md": "fixture\n", "global-sct/src/shared/contracts.ts": "export type A = 1\n", ...files });
  return { dir, base: await commit(dir, "base") };
}

async function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(dir, path)), { recursive: true });
    await Bun.write(resolve(dir, path), text);
  }
}

async function commit(dir: string, message: string) {
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit --quiet -m ${message}`;
  return (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
}

const scope = (worktree: string, base: string, extra: Partial<Parameters<typeof scopeCheck>[0]> = {}) =>
  scopeCheck({ worktree, base, allow: ALLOW, deny: DENY, maxFiles: 12, maxLines: 600, maxCommits: 1, ...extra }).then(result => result.violations);

test("an in-scope diff with one commit passes", async () => {
  const { dir, base } = await fixture();
  await write(dir, { "global-sct/src/main/thing.ts": IMPLEMENTATION, "global-sct/tests/thing.test.ts": REAL_TEST });
  await commit(dir, "work");
  expect(await scope(dir, base)).toEqual([]);
});

test("an edit to contracts.ts is denied", async () => {
  const { dir, base } = await fixture();
  await write(dir, { "global-sct/src/shared/contracts.ts": "export type A = 2\n" });
  await commit(dir, "work");
  expect(await scope(dir, base)).toEqual(["denied:global-sct/src/shared/contracts.ts"]);
});

test("a path that no allow pattern matches is outside the scope", async () => {
  const { dir, base } = await fixture();
  await write(dir, { "global-sct/src/main/other.ts": "export {}\n" });
  await commit(dir, "work");
  expect(await scope(dir, base)).toEqual(["outside-scope:global-sct/src/main/other.ts"]);
});

test("an untracked file and a changed tracked file are uncommitted work", async () => {
  const { dir, base } = await fixture();
  await write(dir, { "global-sct/src/main/thing.ts": IMPLEMENTATION });
  await commit(dir, "work");
  await write(dir, { "notes.txt": "x\n", "README.md": "changed\n" });
  expect((await scope(dir, base)).sort()).toEqual(["uncommitted:README.md", "uncommitted:notes.txt"]);
});

test("a symbolic link fails", async () => {
  const { dir, base } = await fixture();
  await mkdir(resolve(dir, "global-sct/src/main"), { recursive: true });
  await symlink("/etc/hostname", resolve(dir, "global-sct/src/main/thing.ts"));
  await commit(dir, "work");
  expect(await scope(dir, base)).toContain("symlink-added");
});

test("a merge commit fails", async () => {
  const { dir, base } = await fixture();
  await $`git -C ${dir} checkout --quiet -b side`;
  await write(dir, { "global-sct/tests/thing.test.ts": REAL_TEST });
  await commit(dir, "side");
  await $`git -C ${dir} checkout --quiet main`;
  await write(dir, { "global-sct/src/main/thing.ts": IMPLEMENTATION });
  await commit(dir, "work");
  await $`git -C ${dir} merge --quiet --no-ff -m merge side`;
  expect(await scope(dir, base, { maxCommits: 3 })).toEqual(["merge-commit"]);
});

test("no commit, a second commit, and a rewritten history each fail", async () => {
  const { dir, base } = await fixture();
  expect(await scope(dir, base)).toEqual(["no-commit"]);
  await write(dir, { "global-sct/src/main/thing.ts": IMPLEMENTATION });
  await commit(dir, "one");
  await write(dir, { "global-sct/tests/thing.test.ts": REAL_TEST });
  await commit(dir, "two");
  expect(await scope(dir, base)).toEqual(["too-many-commits:2"]);
  expect(await scope(dir, base, { maxCommits: 2 })).toEqual([]);
  await $`git -C ${dir} checkout --quiet --orphan rewritten`;
  await commit(dir, "rewritten");
  expect(await scope(dir, base)).toContain("history-rewritten");
});

test("the file and line limits apply", async () => {
  const { dir, base } = await fixture();
  await write(dir, { "global-sct/src/main/thing.ts": "export const a = 1\n".repeat(20), "global-sct/tests/thing.test.ts": REAL_TEST });
  await commit(dir, "work");
  expect(await scope(dir, base, { maxFiles: 1, maxLines: 10 })).toEqual(["too-many-files:2", "too-many-lines:27"]);
});

const substance = (worktree: string, base: string, type: "feat" | "test", tests: Partial<Parameters<typeof testSubstance>[0]["tests"]> = {}) =>
  testSubstance({ worktree, base, type, tests: { files: ["global-sct/tests/thing.test.ts"], must_add: [], min_cases: 1, ...tests } });

test("a feat ticket with a real test passes, because the test fails on the base", async () => {
  const { dir, base } = await fixture();
  await write(dir, { "global-sct/src/main/thing.ts": IMPLEMENTATION, "global-sct/tests/thing.test.ts": REAL_TEST });
  await commit(dir, "work");
  expect(await substance(dir, base, "feat")).toEqual([]);
});

test("a feat ticket fails when its test passes without the implementation", async () => {
  const { dir, base } = await fixture();
  await write(dir, { "global-sct/src/main/thing.ts": IMPLEMENTATION, "global-sct/tests/thing.test.ts": `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n\ntest('adds', () => {\n  assert.equal(1 + 1, 2)\n})\n` });
  await commit(dir, "work");
  expect(await substance(dir, base, "feat")).toEqual(["mutation-probe:the new tests pass on the base, without the implementation"]);
});

test("an empty test, a skipped test, a mock, and a missing test each fail", async () => {
  const { dir, base } = await fixture();
  expect(await substance(dir, base, "feat")).toEqual(["missing-test-file:global-sct/tests/thing.test.ts"]);
  await write(dir, {
    "global-sct/tests/thing.test.ts": `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n\ntest('empty', () => {\n  assert.ok(true)\n})\ntest.skip('later', () => {})\ntest('same', () => {\n  assert.equal(value, value)\n  globalThis.fetch = fake\n})\n`,
  });
  await commit(dir, "work");
  const issues = await substance(dir, base, "feat", { min_cases: 5 });
  expect(issues).toContain("too-few-tests:2<5");
  expect(issues.filter(issue => issue.startsWith("tautology:")).length).toBe(2);
  expect(issues.filter(issue => issue.startsWith("skipped-test:")).length).toBe(1);
  expect(issues.filter(issue => issue.startsWith("mock-or-globalThis:")).length).toBe(1);
});

test("a test ticket needs a mutation, and each mutation must make a new test fail", async () => {
  const { dir, base } = await fixture({ "global-sct/src/main/thing.ts": IMPLEMENTATION });
  await write(dir, { "global-sct/tests/thing.test.ts": REAL_TEST });
  await commit(dir, "work");
  const path = "global-sct/src/main/thing.ts";
  expect(await substance(dir, base, "test")).toEqual(["mutation-probe:a ticket of type test needs tests.mutations"]);
  expect(await substance(dir, base, "test", { mutations: [{ path, find: "value * 2", replace: "value * 3" }] })).toEqual([]);
  expect(await substance(dir, base, "test", { mutations: [{ path, find: "export const limit = 4", replace: "export const limit = 4 // same" }] })).toEqual([`mutation-probe:the new tests pass with mutation 1 in ${path}`]);
  expect(await substance(dir, base, "test", { mutations: [{ path, find: "absent", replace: "" }] })).toEqual([`mutation-probe:mutation 1 must match one time in ${path}`]);
  expect((await $`git -C ${dir} worktree list`.text()).trim().split("\n").length).toBe(1);
});
