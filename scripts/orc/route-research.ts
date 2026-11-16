#!/usr/bin/env bun
// Research routing and the post-run check of the research sandbox.
//   bun scripts/orc/route-research.ts route <capabilities.json> [rateLimitedUntilMs]
//   bun scripts/orc/route-research.ts check <worktree> <expectedCommit>
// `route` prints the bound research route. `check` exits 0 for a clean run and 4 for a tainted run.
//
// Antigravity has no read-only mode. The lead starts a research task with runtimeMode approval-required and never
// approves a write. A T3 worktree starts the agent at once, so the lead cannot remove write permission before the
// run. The post-run check is therefore the control: a different HEAD or any changed or untracked file taints the
// run, and the lead discards the whole packet and deletes the worktree.
import { $ } from "bun";

export type Caps = { providers: { providerInstanceId: string; canRunChildTask: boolean; constraints: string[]; models: { id: string }[] }[] };
export type ResearchRoute = { providerInstanceId: "antigravity"; model: string; options: { thinking_level: "high" }; reason: "preferred" | "fallback-not-listed" | "fallback-rate-limited"; boundAt: number };

const PREFERRED = "gemini-4-hydrogen";
const FALLBACK = "gemini-3.8-flash";

/** One model for all research slots of a session. The route never leaves the Antigravity provider. */
export function routeResearch(caps: Caps, rateLimitedUntil: number | null, now: number): ResearchRoute {
  const antigravity = caps.providers.find(provider => provider.providerInstanceId === "antigravity");
  if (!antigravity?.canRunChildTask || antigravity.constraints.length > 0) throw new Error("research-tier-unavailable");
  const ids = new Set(antigravity.models.map(model => model.id));
  if (!ids.has(FALLBACK) && !ids.has(PREFERRED)) throw new Error("research-tier-unavailable");
  const base = { providerInstanceId: "antigravity" as const, options: { thinking_level: "high" as const }, boundAt: now };
  if (!ids.has(PREFERRED)) return { ...base, model: FALLBACK, reason: "fallback-not-listed" };
  if (rateLimitedUntil !== null && now < rateLimitedUntil) {
    if (!ids.has(FALLBACK)) throw new Error("research-tier-unavailable");
    return { ...base, model: FALLBACK, reason: "fallback-rate-limited" };
  }
  return { ...base, model: PREFERRED, reason: "preferred" };
}

export type SandboxCheck = { tainted: boolean; reasons: string[] };

/** Layer 3 of the research sandbox: the worktree must be at the commit it started at, with no change. */
export async function checkSandbox(worktree: string, expectedCommit: string): Promise<SandboxCheck> {
  const head = (await $`git -C ${worktree} rev-parse HEAD`.nothrow().quiet().text()).trim();
  const reasons = head === expectedCommit ? [] : [`head-moved:${head || "unknown"}`];
  for (const line of (await $`git -C ${worktree} status --porcelain=v2 --untracked-files=all`.nothrow().quiet().text()).split("\n").filter(Boolean)) reasons.push(`changed:${line.split(" ").at(-1)}`);
  return { tainted: reasons.length > 0, reasons };
}

if (import.meta.main) {
  const [command, first, second] = Bun.argv.slice(2);
  if (command === "route" && first !== undefined) {
    console.log(JSON.stringify(routeResearch((await Bun.file(first).json()) as Caps, second === undefined ? null : Number(second), Date.now()), null, 2));
  } else if (command === "check" && first !== undefined && second !== undefined) {
    const result = await checkSandbox(first, second);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.tainted ? 4 : 0);
  } else {
    console.error("Usage: route-research.ts route <capabilities.json> [rateLimitedUntilMs] | check <worktree> <expectedCommit>");
    process.exit(2);
  }
}
