// Fixture tests for Gate R and the claim diff. The packets cite a small real git repository. No mock of git.
import { $ } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { diffClaims } from "../diff-claims";
import { readLock, repoDir, sha256 } from "../lib";
import { verifyPacket, type Claim, type Packet, type Verified } from "../verify-claims";

const SOURCE = "export function limit() {\n  return 4096\n}\nexport const name = 'frame'\n";
const DOC = "# Frames\n\nThe limit is 4096 bytes.\n";
let dir = "";
let commit = "";
let lock: Awaited<ReturnType<typeof readLock>>;

beforeAll(async () => {
  dir = await mkdtemp(resolve(tmpdir(), "orc-claims-"));
  await $`git -C ${dir} init --quiet --initial-branch=main`;
  await $`git -C ${dir} config user.email fixture@example.invalid`;
  await $`git -C ${dir} config user.name fixture`;
  await mkdir(resolve(dir, "src"), { recursive: true });
  await mkdir(resolve(dir, "docs"), { recursive: true });
  await Bun.write(resolve(dir, "src/frame.ts"), SOURCE);
  await Bun.write(resolve(dir, "docs/frames.md"), DOC);
  await $`git -C ${dir} add -A`;
  await $`git -C ${dir} commit --quiet -m base`;
  commit = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
  lock = await readLock();
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const lines = (text: string, start: number, end: number) => text.split("\n").slice(start - 1, end).join("\n");
const code = (path: string, text: string, start: number, end: number, extra: object = {}) =>
  ({ kind: "code" as const, repo: "workspace" as const, path, startLine: start, endLine: end, sha256: sha256(lines(text, start, end)), snippet: lines(text, start, end), ...extra });
const claim = (id: string, cls: Claim["class"], evidence: Claim["evidence"], extra: Partial<Claim> = {}): Claim =>
  ({ id, statement: `Statement of claim ${id} about the frame limit.`, class: cls, risk: "low", evidence, ...extra });
const packet = (claims: Claim[], extra: object = {}, packetId = "RP-0001"): Packet => ({
  schema: 1, packetId, question: "What is the frame limit and where is it set?", route: { providerInstanceId: "antigravity", model: "gemini-3.8-flash" },
  tree: { workspace: commit, agtop: lock.agtop.sha, toolkit: lock.subagentclassifiertoolkit.sha }, claims, openQuestions: [], ...extra,
});
const gate = (value: unknown) => verifyPacket(value, { ...repoDir, workspace: dir });
const verdicts = async (claims: Claim[]) => {
  const result = await gate(packet(claims));
  if (result.exit !== 0) throw new Error(result.reasons.join(", "));
  return Object.fromEntries(result.verified.verdicts.map(verdict => [verdict.id, [verdict.verdict, verdict.class, ...verdict.reasons].join(" ")]));
};

test("a true claim passes, and each false citation gives its stated verdict", async () => {
  expect(await verdicts([
    claim("C1", "VERIFIED_IN_CODE", [code("src/frame.ts", SOURCE, 1, 3, { symbols: ["limit"] })]),
    claim("C2", "VERIFIED_IN_CODE", [{ ...code("src/frame.ts", SOURCE, 1, 3), sha256: "0".repeat(64) }]),
    claim("C3", "VERIFIED_IN_CODE", [code("src/absent.ts", SOURCE, 1, 3)]),
    claim("C4", "VERIFIED_IN_CODE", [{ ...code("src/frame.ts", SOURCE, 1, 3), endLine: 90 }]),
    claim("C5", "VERIFIED_IN_CODE", [code("src/../src/frame.ts", SOURCE, 1, 3)]),
    claim("C6", "VERIFIED_IN_CODE", [code("docs/frames.md", DOC, 3, 3)]),
    claim("C7", "VERIFIED_IN_CODE", [{ kind: "external", url: "https://example.invalid/spec", retrievedAt: "2026-11-15", quote: "limit" }]),
    claim("C8", "VERIFIED_IN_CODE", [code("src/frame.ts", SOURCE, 1, 3, { symbols: ["name"] })]),
    claim("C9", "VERIFIED_IN_CODE", [{ ...code("src/frame.ts", SOURCE, 1, 3), snippet: "export function limit() {\n  return 8192\n}" }]),
    claim("C10", "EXTERNAL_SPEC_ASSUMPTION", [code("src/frame.ts", SOURCE, 1, 3)]),
    claim("C11", "INFERRED_FROM_DOCS", [code("docs/frames.md", DOC, 3, 3)]),
    claim("C12", "VERIFIED_IN_CODE", [code("src/frame.ts", SOURCE, 4, 4)], { dependsOn: ["C2"] }),
    claim("C13", "VERIFIED_IN_CODE", [code("src/frame.ts", SOURCE, 4, 4)], { dependsOn: ["C6"] }),
  ])).toEqual({
    C1: "pass VERIFIED_IN_CODE",
    C2: "rejected VERIFIED_IN_CODE hash-mismatch:src/frame.ts",
    C3: "rejected VERIFIED_IN_CODE no-such-file:workspace:src/absent.ts",
    C4: "rejected VERIFIED_IN_CODE line-range-out-of-file:src/frame.ts:1-90",
    C5: "rejected VERIFIED_IN_CODE unsafe-path:src/../src/frame.ts",
    C6: "downgraded INFERRED_FROM_DOCS label-stronger-than-evidence",
    C7: "downgraded EXTERNAL_SPEC_ASSUMPTION label-stronger-than-evidence",
    C8: "rejected VERIFIED_IN_CODE symbol-not-in-range:name",
    C9: "rejected VERIFIED_IN_CODE snippet-mismatch:src/frame.ts",
    C10: "rejected EXTERNAL_SPEC_ASSUMPTION no-external-source",
    C11: "pass INFERRED_FROM_DOCS",
    C12: "rejected VERIFIED_IN_CODE depends-on-unverified-claim",
    C13: "rejected VERIFIED_IN_CODE depends-on-unverified-claim",
  });
});

test("the pass rate decides if the packet is usable", async () => {
  const good = claim("C1", "VERIFIED_IN_CODE", [code("src/frame.ts", SOURCE, 1, 3)]);
  const bad = (id: string) => claim(id, "VERIFIED_IN_CODE", [code("src/absent.ts", SOURCE, 1, 3)]);
  const rate = async (claims: Claim[]) => {
    const result = await gate(packet(claims));
    return result.exit === 0 ? [result.verified.passRate, result.verified.usable] : result.reasons;
  };
  expect(await rate([good, { ...good, id: "C2" }, { ...good, id: "C3" }, bad("C4"), bad("C5")])).toEqual([0.6, true]);
  expect(await rate([good, bad("C2")])).toEqual([0.5, false]);
});

test("a malformed packet exits 2 and a packet from other pins exits 3", async () => {
  const good = claim("C1", "VERIFIED_IN_CODE", [code("src/frame.ts", SOURCE, 1, 3)]);
  expect((await gate({ ...packet([good]), extra: 1 })).exit).toBe(2);
  expect((await gate(packet([]))).exit).toBe(2);
  expect((await gate(packet([good], { route: { providerInstanceId: "opencode", model: "gemini-3.8-flash" } }))).exit).toBe(2);
  expect(await gate(packet([good], { tree: { workspace: "f".repeat(40), agtop: lock.agtop.sha, toolkit: lock.subagentclassifiertoolkit.sha } }))).toEqual({ exit: 2, reasons: ["unknown-workspace-commit"] });
  expect(await gate(packet([good], { tree: { workspace: commit, agtop: "0".repeat(40), toolkit: lock.subagentclassifiertoolkit.sha } }))).toEqual({ exit: 3, reasons: ["stale-pins"] });
});

test("the claim diff finds overlaps, single sources, and counterexamples", async () => {
  const a = packet([
    claim("C1", "VERIFIED_IN_CODE", [code("src/frame.ts", SOURCE, 1, 3)]),
    claim("C2", "VERIFIED_IN_CODE", [code("src/frame.ts", SOURCE, 4, 4)], { risk: "high" }),
    claim("C3", "VERIFIED_IN_CODE", [code("src/absent.ts", SOURCE, 1, 1)]),
  ], {}, "RP-0001");
  const b = packet([
    claim("C1", "VERIFIED_IN_CODE", [code("src/frame.ts", SOURCE, 2, 2)]),
    claim("C2", "VERIFIED_IN_CODE", [code("docs/frames.md", DOC, 1, 1)]),
    claim("C3", "INFERRED_FROM_DOCS", [code("docs/frames.md", DOC, 3, 3)]),
  ], {}, "RP-0002");
  const verified = async (value: Packet) => ((await gate(value)) as { exit: 0; verified: Verified }).verified;
  const summary = diffClaims({ packet: a, verified: await verified(a) }, { packet: b, verified: await verified(b) }).map(item => `${item.claim} ${item.status} [${item.overlaps}] ${item.leadMustReadLines}`);
  expect(summary).toEqual([
    "RP-0001/C1 needs-lead-label [RP-0002/C1] true",
    "RP-0001/C2 single-source [] true",
    "RP-0002/C1 needs-lead-label [RP-0001/C1] true",
    // The adversarial claim was downgraded to INFERRED_FROM_DOCS by Gate R, so it is not a code counterexample.
    "RP-0002/C2 single-source [] false",
    "RP-0002/C3 single-source [] false",
  ]);
});
