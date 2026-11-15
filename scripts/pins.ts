import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

type Pin = { url: string; sha: string; path?: string };
type Pins = { agtop: Pin; subagentclassifiertoolkit: Pin; globalSctForkBase: Pin };

const root = resolve(import.meta.dir, "..");
const pins = (await Bun.file(resolve(root, "pins.json")).json()) as Pins;
const checkOnly = Bun.argv.includes("--check");

for (const key of ["agtop", "subagentclassifiertoolkit"] as const) {
  const pin = pins[key];
  const target = resolve(root, pin.path!);
  const head = await headOf(target);
  if (head !== pin.sha) {
    if (checkOnly) throw new Error(head === null ? `${pin.path} is missing.` : `${pin.path} exists at ${head}; expected ${pin.sha}.`);
    await materialize(pin, target);
  }
  const verified = await headOf(target);
  if (verified !== pin.sha) throw new Error(`${pin.path} verification failed: ${verified}`);
  console.log(`${pin.path}: ${verified}`);
}

await buildAgtop(resolve(root, pins.agtop.path!), pins.agtop.sha);

// A clone by branch cannot check out a commit that no branch contains.
// A fetch by SHA works for each commit that the host still serves.
async function materialize(pin: Pin, target: string) {
  if (await Bun.file(`${target}/.git/HEAD`).exists()) await requireCleanTree(pin, target);
  else {
    await mkdir(target, { recursive: true });
    await $`git -C ${target} init --quiet`;
  }
  if ((await $`git -C ${target} remote get-url origin`.nothrow().quiet()).exitCode === 0) await $`git -C ${target} remote set-url origin ${pin.url}`;
  else await $`git -C ${target} remote add origin ${pin.url}`;
  await $`git -C ${target} fetch --quiet origin ${pin.sha}`;
  await $`git -C ${target} checkout --quiet --detach FETCH_HEAD`;
}

// The script never resets a clone. A changed tree stops the run and the user decides.
async function requireCleanTree(pin: Pin, target: string) {
  const changed = (await $`git -C ${target} status --porcelain --untracked-files=all`.text()).split("\n").filter(Boolean);
  if (changed.length > 0) throw new Error(`${pin.path} has local changes. No reset was performed. Files:\n${changed.join("\n")}`);
}

// The stamp records the commit that the build output came from.
// A missing or different stamp means the output is absent or stale.
async function buildAgtop(target: string, sha: string) {
  const stamp = Bun.file(`${target}/dist/.pin-build`);
  const current = (await Bun.file(`${target}/dist/index.js`).exists()) && (await stamp.exists()) && (await stamp.text()).trim() === sha;
  if (current) return;
  if (checkOnly) throw new Error(`agtop/dist is missing or was not built from ${sha}. Run \`bun run pins\`.`);
  await $`bun install --frozen-lockfile`.cwd(target);
  await $`bun run build`.cwd(target);
  await Bun.write(stamp, `${sha}\n`);
  console.log(`agtop: built at ${sha}`);
}

async function headOf(target: string) {
  if (!(await Bun.file(`${target}/.git/HEAD`).exists())) return null;
  const result = await $`git -C ${target} rev-parse --verify --quiet HEAD`.nothrow().quiet();
  return result.exitCode === 0 ? result.stdout.toString().trim() : "an unborn branch";
}
