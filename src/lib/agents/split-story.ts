import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const IMPLEMENTATION = path.join("_bmad-output", "implementation-artifacts");

/**
 * Whether a story was split into subtasks (spec frontmatter `status: split`). A split story is never
 * built as a whole: its subtasks (4.1a, 4.1b, …) are started instead. The spec file is the source of truth.
 */
export async function isSplitStory(localPath: string, storyId: string): Promise<boolean> {
  const dir = path.join(localPath, IMPLEMENTATION);
  const prefix = `spec-${storyId.replace(/\./g, "-")}-`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    // "spec-4-1-…" matches story 4.1 only; "spec-4-1a-…" is a subtask and does not match.
    if (!name.startsWith(prefix) || !name.endsWith(".md")) continue;
    const head = (await readFile(path.join(dir, name), "utf8")).slice(0, 800);
    if (/^status:\s*'?split'?\s*$/m.test(head)) return true;
  }
  return false;
}
