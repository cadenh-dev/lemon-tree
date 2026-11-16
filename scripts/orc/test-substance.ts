// Gate C check 5: a green test run does not prove that a test exists.
import { $ } from "bun";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Feature } from "./lib";

/** A source change that must make at least one new test fail. Tickets of type `test` need one or more. */
export type Mutation = { path: string; find: string; replace: string };
export type SubstanceInput = { worktree: string; base: string; type: Feature["type"]; tests: Feature["tests"] & { mutations?: Mutation[]; allow_skips?: string[] } };

const TEST_CALL = /(?:^|[^.\w])(?:test|it)\(/;
const SKIP = /\b(?:test|it|describe)\.(?:skip|todo|only)\b|\bskip\s*:\s*true\b|\btodo\s*:\s*true\b/;
const MOCK = /\bglobalThis\.|\bmock\.module\(|\b(?:jest|vi)\.mock\(/;
const TAUTOLOGY = /\bassert(?:\.ok)?\(\s*true\s*[,)]|\bexpect\(\s*true\s*\)\.toBe\(\s*true\s*\)|\bassert\.(?:strictEqual|equal|deepEqual|deepStrictEqual)\(\s*([^,()]+?)\s*,\s*\1\s*[,)]|\bexpect\(\s*([^()]+?)\s*\)\.(?:toBe|toEqual)\(\s*\2\s*\)/;

export async function testSubstance({ worktree, base, type, tests }: SubstanceInput): Promise<string[]> {
  const issues: string[] = [];
  for (const file of tests.files) if (!(await Bun.file(resolve(worktree, file)).exists())) issues.push(`missing-test-file:${file}`);
  if (issues.length > 0) return issues;

  const added = tests.files.length === 0 ? [] : (await $`git -C ${worktree} diff --unified=0 ${`${base}..HEAD`} -- ${tests.files}`.text()).split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1));
  const cases = added.filter(line => TEST_CALL.test(line)).length;
  if (cases < tests.min_cases) issues.push(`too-few-tests:${cases}<${tests.min_cases}`);
  for (const line of added) {
    if (SKIP.test(line) && !(tests.allow_skips ?? []).some(allowed => line.includes(allowed))) issues.push(`skipped-test:${line.trim().slice(0, 120)}`);
    if (MOCK.test(line)) issues.push(`mock-or-globalThis:${line.trim().slice(0, 120)}`);
    if (TAUTOLOGY.test(line)) issues.push(`tautology:${line.trim().slice(0, 120)}`);
  }
  if (issues.length > 0 || tests.files.length === 0) return issues;
  return ["feat", "fix"].includes(type) ? await baseProbe(worktree, base, tests.files) : type === "test" ? await mutationProbe(worktree, tests.files, tests.mutations ?? []) : [];
}

// feat and fix: the new tests run against the base, which has no implementation. At least one must fail.
async function baseProbe(worktree: string, base: string, files: string[]) {
  return withScratch(worktree, base, async scratch => {
    await $`git -C ${scratch} checkout --quiet ${await head(worktree)} -- ${files}`;
    return (await testsPass(scratch, files)) ? ["mutation-probe:the new tests pass on the base, without the implementation"] : [];
  });
}

// test: the implementation is already on the base, so the base cannot fail the tests.
// The lead writes source mutations in the ticket. Each mutation must make at least one new test fail.
async function mutationProbe(worktree: string, files: string[], mutations: Mutation[]) {
  if (mutations.length === 0) return ["mutation-probe:a ticket of type test needs tests.mutations"];
  const issues: string[] = [];
  for (const [index, mutation] of mutations.entries()) {
    issues.push(...(await withScratch(worktree, await head(worktree), async scratch => {
      const source = await Bun.file(resolve(scratch, mutation.path)).text();
      if (source.split(mutation.find).length !== 2) return [`mutation-probe:mutation ${index + 1} must match one time in ${mutation.path}`];
      await Bun.write(resolve(scratch, mutation.path), source.replace(mutation.find, mutation.replace));
      return (await testsPass(scratch, files)) ? [`mutation-probe:the new tests pass with mutation ${index + 1} in ${mutation.path}`] : [];
    })));
  }
  return issues;
}

const head = async (worktree: string) => (await $`git -C ${worktree} rev-parse HEAD`.text()).trim();

async function testsPass(scratch: string, files: string[]) {
  const byDir = Map.groupBy(files, file => dirname(file));
  for (const [dir, group] of byDir) {
    if ((await $`bun test ${group.map(file => file.slice(dir.length + 1))}`.cwd(resolve(scratch, dir)).nothrow().quiet()).exitCode !== 0) return false;
  }
  return true;
}

// The scratch worktree uses the dependencies and the pinned clones of the worker worktree through symbolic links.
async function withScratch<T>(worktree: string, commit: string, run: (scratch: string) => Promise<T>) {
  const scratch = await mkdtemp(resolve(tmpdir(), "orc-probe-"));
  await $`git -C ${worktree} worktree add --quiet --detach ${scratch} ${commit}`;
  try {
    for (const link of ["global-sct/node_modules", "agtop", "subagentclassifiertoolkit"]) await symlink(resolve(worktree, link), resolve(scratch, link));
    return await run(scratch);
  } finally {
    await $`git -C ${worktree} worktree remove --force ${scratch}`.nothrow().quiet();
    await rm(scratch, { recursive: true, force: true });
  }
}
