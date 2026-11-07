import { $ } from "bun";
import { resolve } from "node:path";

type Pin = { url: string; sha: string; path?: string };
type Pins = { agtop: Pin; subagentclassifiertoolkit: Pin; globalSctForkBase: Pin };

const pins = (await Bun.file("pins.json").json()) as Pins;
const checkOnly = Bun.argv.includes("--check");
let agtopMaterialized = false;

for (const key of ["agtop", "subagentclassifiertoolkit"] as const) {
  const pin = pins[key];
  const target = resolve(import.meta.dir, "..", pin.path!);
  const exists = await Bun.file(`${target}/.git/HEAD`).exists();
  if (exists) {
    const head = (await $`git -C ${target} rev-parse HEAD`.text()).trim();
    if (head !== pin.sha) throw new Error(`${pin.path} exists at ${head}; expected ${pin.sha}. No reset was performed.`);
  } else {
    if (checkOnly) throw new Error(`${pin.path} is missing.`);
    await $`git clone ${pin.url} ${target}`;
    await $`git -C ${target} checkout --detach ${pin.sha}`;
    if (key === "agtop") agtopMaterialized = true;
  }
  const verified = (await $`git -C ${target} rev-parse HEAD`.text()).trim();
  if (verified !== pin.sha) throw new Error(`${pin.path} verification failed: ${verified}`);
  console.log(`${pin.path}: ${verified}`);
}

if (!checkOnly && agtopMaterialized) {
  await $`bun install --frozen-lockfile`.cwd(resolve(import.meta.dir, "..", "agtop"));
  await $`bun run build`.cwd(resolve(import.meta.dir, "..", "agtop"));
}
