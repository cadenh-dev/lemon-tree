// Content-addressed revalidation after a pin move or a new base commit.
// A claim or a contract is valid when its text has the same hash at the new commit. A model statement never makes it valid again.
import { fileAt, lineRange, sha256, type Repo } from "./lib";

export type Cited = { repo: Repo; path: string; startLine: number; endLine: number; sha256: string };
export type Revalidated =
  | { state: "valid" }
  | { state: "moved"; startLine: number; endLine: number; oldRange: [number, number] }
  | { state: "invalid"; reason: "file-absent" | "text-changed" };

/** Checks one cited range at the new commit of its repository. `dirs` gives the checkout of each repository. */
export async function revalidate(item: Cited, commit: string, dir: string): Promise<Revalidated> {
  const file = await fileAt(item.repo, commit, item.path, dir);
  if (file === null) return { state: "invalid", reason: "file-absent" };
  const same = lineRange(file, item.startLine, item.endLine);
  if (same !== null && sha256(same) === item.sha256) return { state: "valid" };
  // The text can move inside the file. Search each range of the same length for the same hash.
  const lines = file.split("\n");
  const length = item.endLine - item.startLine + 1;
  for (let start = 1; start + length - 1 <= lines.length; start++) {
    if (sha256(lines.slice(start - 1, start - 1 + length).join("\n")) === item.sha256) return { state: "moved", startLine: start, endLine: start + length - 1, oldRange: [item.startLine, item.endLine] };
  }
  return { state: "invalid", reason: "text-changed" };
}

/** External evidence has no hash. It is valid for 30 days from the retrieval date. */
export function externalState(retrievedAt: string, now: number): "valid" | "aging" {
  return now - Date.parse(retrievedAt) < 30 * 24 * 60 * 60 * 1000 ? "valid" : "aging";
}
