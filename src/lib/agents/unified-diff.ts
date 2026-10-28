// Kept free of Node imports: the client-side diff view uses it.

export interface DiffLine {
  kind: "add" | "del" | "context";
  /** Line number in the old file; null for added lines. */
  oldNumber: number | null;
  /** Line number in the new file; null for removed lines. */
  newNumber: number | null;
  text: string;
}

export interface DiffHunk {
  /** The text after the second @@, usually the enclosing function or heading. */
  context: string;
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/**
 * Turn a unified diff of one file into hunks with line numbers, so the view
 * can show where a change sits instead of raw @@ headers. The file header
 * lines before the first hunk are dropped.
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;
  for (const line of diff.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = { context: header[3], lines: [] };
      hunks.push(hunk);
      oldNumber = Number(header[1]);
      newNumber = Number(header[2]);
      continue;
    }
    if (!hunk || line.startsWith("\\")) continue;
    const sign = line.charAt(0);
    const text = line.slice(1);
    if (sign === "+") {
      hunk.lines.push({ kind: "add", oldNumber: null, newNumber, text });
      newNumber++;
    } else if (sign === "-") {
      hunk.lines.push({ kind: "del", oldNumber, newNumber: null, text });
      oldNumber++;
    } else {
      hunk.lines.push({ kind: "context", oldNumber, newNumber, text });
      oldNumber++;
      newNumber++;
    }
  }
  return hunks;
}
