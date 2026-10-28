import { execFile } from "node:child_process";

/**
 * The files a build run changed on its branch, read from the project's git
 * checkout. A build's branch is cut from the base branch it started on, so
 * its changes are the diff from the merge base to the branch tip.
 */

export type ChangeStatus = "added" | "modified" | "deleted";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** Null for binary files. */
  additions: number | null;
  deletions: number | null;
  group: "code" | "specs";
}

export type RunChanges =
  | { state: "ready"; files: ChangedFile[] }
  /** The run has no branch of its own: plan and review runs work in the checkout. */
  | { state: "no-branch" }
  /** The branch was merged and removed: its changes are in the base branch now. */
  | { state: "merged" };

const MAX_DIFF_BYTES = 512 * 1024;

/** Specs and sprint files are shown apart from code. */
export function groupOf(path: string): ChangedFile["group"] {
  return /^(_bmad-output|docs)\//.test(path) || path.endsWith(".md") ? "specs" : "code";
}

const STATUS: Record<string, ChangeStatus> = { A: "added", M: "modified", D: "deleted" };

/**
 * Join `git diff --name-status` and `--numstat` (both with --no-renames) into
 * one list, in path order.
 */
export function parseChanges(nameStatus: string, numstat: string): ChangedFile[] {
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of numstat.split("\n")) {
    const [adds, dels, ...rest] = line.split("\t");
    if (rest.length === 0) continue;
    counts.set(rest.join("\t"), {
      additions: adds === "-" ? null : Number(adds),
      deletions: dels === "-" ? null : Number(dels),
    });
  }
  const files: ChangedFile[] = [];
  for (const line of nameStatus.split("\n")) {
    const [code, ...rest] = line.split("\t");
    const path = rest.join("\t");
    const status = STATUS[code?.charAt(0) ?? ""];
    if (!status || !path) continue;
    const count = counts.get(path) ?? { additions: null, deletions: null };
    files.push({ path, status, ...count, group: groupOf(path) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function git(checkout: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", checkout, "-c", "core.quotepath=off", ...args],
      { maxBuffer: 16 * MAX_DIFF_BYTES },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** The branch the checkout is on, or null when it is detached or not a repository. */
export async function currentBranch(checkout: string): Promise<string | null> {
  try {
    const name = (await git(checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    return name || null;
  } catch {
    return null;
  }
}

async function branchExists(checkout: string, branch: string): Promise<boolean> {
  try {
    await git(checkout, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** The range that holds a build's own changes: from where the branch was cut to its tip. */
function rangeOf(baseBranch: string, branch: string): string {
  return `${baseBranch}...${branch}`;
}

export async function runChanges(input: {
  checkout: string;
  branch: string | null | undefined;
  baseBranch: string | null | undefined;
}): Promise<RunChanges> {
  if (!input.branch) return { state: "no-branch" };
  if (!(await branchExists(input.checkout, input.branch))) return { state: "merged" };
  const range = rangeOf(input.baseBranch ?? "HEAD", input.branch);
  const [nameStatus, numstat] = await Promise.all([
    git(input.checkout, ["diff", "--no-renames", "--name-status", range]),
    git(input.checkout, ["diff", "--no-renames", "--numstat", range]),
  ]);
  return { state: "ready", files: parseChanges(nameStatus, numstat) };
}

/**
 * The diff of one file of a build's branch. The path must be one the branch
 * changed, so a request cannot read any other file through git.
 */
export async function runFileDiff(input: {
  checkout: string;
  branch: string;
  baseBranch: string | null | undefined;
  path: string;
}): Promise<string | null> {
  const changes = await runChanges(input);
  if (changes.state !== "ready") return null;
  if (!changes.files.some((file) => file.path === input.path)) return null;
  const range = rangeOf(input.baseBranch ?? "HEAD", input.branch);
  const diff = await git(input.checkout, ["diff", "--no-renames", range, "--", input.path]);
  return diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n… afgekapt` : diff;
}

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
