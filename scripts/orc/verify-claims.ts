#!/usr/bin/env bun
// Gate R: the deterministic pre-filter for a research packet. It runs before the lead reads the packet.
//   bun scripts/orc/verify-claims.ts <packet.json> --out <verified.json>
// It uses git objects at the cited commits, so the working tree cannot change the result. It needs no model and no network.
// Exit 0: the packet is structurally valid (claims can still be rejected, and passRate below 0.6 discards the packet).
// Exit 2: the packet is unusable. Exit 3: stale-pins, the packet goes back to the queue.
// Gate R proves that the cited text exists at the cited commit. It does not prove that the statement follows from the text.
import { $ } from "bun";
import { fileAt, lineRange, readLock, repoDir, schemaFile, sha256, type Repo } from "./lib";
import { loadSchema, validate } from "./schema";

type Code = { kind: "code"; repo: Repo; path: string; startLine: number; endLine: number; sha256: string; snippet: string; symbols?: string[] };
type External = { kind: "external"; url: string; retrievedAt: string; quote: string };
export type ClaimClass = "VERIFIED_IN_CODE" | "INFERRED_FROM_DOCS" | "EXTERNAL_SPEC_ASSUMPTION";
export type Claim = { id: string; statement: string; class: ClaimClass; risk: "low" | "high"; evidence: (Code | External)[]; dependsOn?: string[] };
export type Packet = { schema: 1; packetId: string; question: string; route: { providerInstanceId: string; model: string }; tree: Record<Repo, string>; claims: Claim[]; openQuestions: string[] };
export type Verdict = { id: string; verdict: "pass" | "downgraded" | "rejected"; class: ClaimClass; reasons: string[] };
export type Verified = { schema: 1; packetId: string; tree: Record<Repo, string>; verdicts: Verdict[]; passRate: number; usable: boolean };
export type GateR = { exit: 0; verified: Verified } | { exit: 2 | 3; reasons: string[] };

export const PASS_RATE_FLOOR = 0.6;

export async function verifyPacket(value: unknown, dirs: Record<Repo, string> = repoDir): Promise<GateR> {
  const structural = validate(await loadSchema(schemaFile("research-packet")), value);
  if (structural.length > 0) return { exit: 2, reasons: structural };
  const packet = value as Packet;
  // A stale tree is not an error of the agent. The pins moved during the run, so the packet is queued again, not judged.
  const lock = await readLock();
  if (packet.tree.agtop !== lock.agtop.sha || packet.tree.toolkit !== lock.subagentclassifiertoolkit.sha) return { exit: 3, reasons: ["stale-pins"] };
  if ((await $`git -C ${dirs.workspace} cat-file -t ${packet.tree.workspace}`.nothrow().quiet().text()).trim() !== "commit") return { exit: 2, reasons: ["unknown-workspace-commit"] };

  const verdicts: Verdict[] = [];
  for (const claim of packet.claims) verdicts.push(await judge(claim, packet.tree, dirs));
  // A claim that depends on a claim that did not pass is rejected. Repeat until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    for (const claim of packet.claims) {
      const own = verdicts.find(verdict => verdict.id === claim.id)!;
      if (own.verdict !== "rejected" && (claim.dependsOn ?? []).some(id => verdicts.find(verdict => verdict.id === id)?.verdict !== "pass")) {
        own.verdict = "rejected";
        own.reasons.push("depends-on-unverified-claim");
        changed = true;
      }
    }
  }
  const passRate = verdicts.filter(verdict => verdict.verdict === "pass").length / verdicts.length;
  // A model that invents 40% of its citations is not a source for the other 60%.
  return { exit: 0, verified: { schema: 1, packetId: packet.packetId, tree: packet.tree, verdicts, passRate, usable: passRate >= PASS_RATE_FLOOR } };
}

async function judge(claim: Claim, tree: Record<Repo, string>, dirs: Record<Repo, string>): Promise<Verdict> {
  const code = claim.evidence.filter((item): item is Code => item.kind === "code");
  const reasons = (await Promise.all(code.map(item => checkCode(item, tree, dirs)))).flat();
  if (reasons.length > 0) return { id: claim.id, verdict: "rejected", class: claim.class, reasons };
  // Class rules. A wrong label is downgraded, never upgraded.
  const isDoc = (item: Code) => item.path.endsWith(".md") || item.path.split("/").includes("docs");
  if (claim.class === "VERIFIED_IN_CODE" && !code.some(item => !isDoc(item))) {
    return { id: claim.id, verdict: "downgraded", class: code.length === 0 ? "EXTERNAL_SPEC_ASSUMPTION" : "INFERRED_FROM_DOCS", reasons: ["label-stronger-than-evidence"] };
  }
  if (claim.class === "INFERRED_FROM_DOCS" && !code.some(isDoc)) return { id: claim.id, verdict: "rejected", class: claim.class, reasons: ["no-document-source"] };
  if (claim.class === "EXTERNAL_SPEC_ASSUMPTION" && !claim.evidence.some(item => item.kind === "external")) return { id: claim.id, verdict: "rejected", class: claim.class, reasons: ["no-external-source"] };
  if (claim.evidence.length === 0) return { id: claim.id, verdict: "rejected", class: claim.class, reasons: ["no-evidence"] };
  return { id: claim.id, verdict: "pass", class: claim.class, reasons };
}

async function checkCode(item: Code, tree: Record<Repo, string>, dirs: Record<Repo, string>): Promise<string[]> {
  // Path safety: relative, no "..", tracked at the cited commit.
  if (item.path.startsWith("/") || item.path.split("/").includes("..")) return [`unsafe-path:${item.path}`];
  const file = await fileAt(item.repo, tree[item.repo], item.path, dirs[item.repo]);
  if (file === null) return [`no-such-file:${item.repo}:${item.path}`];
  const text = lineRange(file, item.startLine, item.endLine);
  if (text === null) return [`line-range-out-of-file:${item.path}:${item.startLine}-${item.endLine}`];
  // The cited bytes hash to the cited value, and the snippet is those bytes.
  const reasons: string[] = [];
  if (sha256(text) !== item.sha256) reasons.push(`hash-mismatch:${item.path}`);
  if (text !== item.snippet) reasons.push(`snippet-mismatch:${item.path}`);
  // Each named symbol is an identifier inside the cited range.
  for (const symbol of item.symbols ?? []) {
    if (!new RegExp(`(^|[^A-Za-z0-9_$])${symbol.split(".").at(-1)!.replaceAll("$", "\\$")}([^A-Za-z0-9_$]|$)`).test(text)) reasons.push(`symbol-not-in-range:${symbol}`);
  }
  return reasons;
}

if (import.meta.main) {
  const [packetPath, flag, outPath] = Bun.argv.slice(2);
  if (packetPath === undefined || flag !== "--out" || outPath === undefined) {
    console.error("Usage: verify-claims.ts <packet.json> --out <verified.json>");
    process.exit(2);
  }
  const result = await verifyPacket(await Bun.file(packetPath).json().catch(() => null));
  if (result.exit !== 0) {
    console.error(JSON.stringify({ reasons: result.reasons }));
    process.exit(result.exit);
  }
  await Bun.write(outPath, `${JSON.stringify(result.verified, null, 2)}\n`);
  console.log(`${result.verified.packetId}: passRate ${result.verified.passRate.toFixed(2)}, ${result.verified.usable ? "usable" : "discarded (below 0.6)"}`);
}
