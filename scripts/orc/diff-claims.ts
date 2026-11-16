#!/usr/bin/env bun
// The deterministic part of the dual-agent cross-check.
//   bun scripts/orc/diff-claims.ts <packetA.json> <verifiedA.json> <packetB.json> <verifiedB.json> [--out <diff.json>]
// Session A is constructive and session B is adversarial. Both packets must pass Gate R first.
// The script computes which claims overlap. The compatibility of two statements is a judgment, so the script
// lists each overlapping pair with status `needs-lead-label`, and the lead marks it `corroborated` or `contested`.
import type { Claim, Packet, Verified } from "./verify-claims";

type Range = { repo: string; path: string; startLine: number; endLine: number };
export type ClaimStatus = { claim: string; status: "needs-lead-label" | "single-source" | "counterexample"; risk: Claim["risk"]; overlaps: string[]; leadMustReadLines: boolean };

export function diffClaims(a: { packet: Packet; verified: Verified }, b: { packet: Packet; verified: Verified }): ClaimStatus[] {
  const usable = ({ packet, verified }: { packet: Packet; verified: Verified }) =>
    packet.claims
      .map(claim => ({ claim, verdict: verified.verdicts.find(verdict => verdict.id === claim.id) }))
      .filter(({ verdict }) => verdict !== undefined && verdict.verdict !== "rejected")
      .map(({ claim, verdict }) => ({ ref: `${packet.packetId}/${claim.id}`, claim, class: verdict!.class, ranges: claim.evidence.filter(item => item.kind === "code") as Range[] }));
  const [left, right] = [usable(a), usable(b)];
  const statusOf = (own: (typeof left)[number], others: typeof left, adversarial: boolean): ClaimStatus => {
    const overlaps = others.filter(other => own.ranges.some(x => other.ranges.some(y => intersects(x, y)))).map(other => other.ref);
    // A counterexample from the adversarial session always goes to the lead, even when session A did not cover the area.
    const status = adversarial && own.class === "VERIFIED_IN_CODE" && overlaps.length === 0 ? "counterexample" : overlaps.length > 0 ? "needs-lead-label" : "single-source";
    return { claim: own.ref, status, risk: own.claim.risk, overlaps, leadMustReadLines: status !== "single-source" || own.claim.risk === "high" };
  };
  return [...left.map(own => statusOf(own, right, false)), ...right.map(own => statusOf(own, left, true))];
}

const intersects = (x: Range, y: Range) => x.repo === y.repo && x.path === y.path && x.startLine <= y.endLine && y.startLine <= x.endLine;

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length < 4) {
    console.error("Usage: diff-claims.ts <packetA.json> <verifiedA.json> <packetB.json> <verifiedB.json> [--out <diff.json>]");
    process.exit(2);
  }
  const [packetA, verifiedA, packetB, verifiedB] = (await Promise.all(args.slice(0, 4).map(path => Bun.file(path).json()))) as [Packet, Verified, Packet, Verified];
  if (!verifiedA.usable || !verifiedB.usable) {
    console.error("A packet below the pass rate floor is discarded and takes no part in a cross-check.");
    process.exit(2);
  }
  const text = `${JSON.stringify({ schema: 1, packets: [packetA.packetId, packetB.packetId], claims: diffClaims({ packet: packetA, verified: verifiedA }, { packet: packetB, verified: verifiedB }) }, null, 2)}\n`;
  if (args[4] === "--out" && args[5] !== undefined) await Bun.write(args[5], text);
  console.log(text);
}
