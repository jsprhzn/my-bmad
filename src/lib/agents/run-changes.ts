import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

/**
 * The changes of a build that is still running: its worktree, committed or
 * not. The branch only has the commits the build has made so far.
 */
async function worktreeChanges(worktree: string, base: string): Promise<RunChanges> {
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(worktree, ["diff", "--no-renames", "--name-status", base]),
    git(worktree, ["diff", "--no-renames", "--numstat", base]),
    git(worktree, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const added = untracked.split("\n").filter(Boolean);
  return {
    state: "ready",
    files: parseChanges(
      [nameStatus, ...added.map((file) => `A\t${file}`)].filter(Boolean).join("\n"),
      [numstat, ...added.map((file) => `-\t-\t${file}`)].filter(Boolean).join("\n"),
    ),
  };
}

export async function runChanges(input: {
  checkout: string;
  branch: string | null | undefined;
  baseBranch: string | null | undefined;
  /** The build's worktree, while the build runs. */
  worktree?: string | null;
}): Promise<RunChanges> {
  if (!input.branch) return { state: "no-branch" };
  if (input.worktree && existsSync(input.worktree)) {
    return worktreeChanges(input.worktree, input.baseBranch ?? "HEAD");
  }
  if (!(await branchExists(input.checkout, input.branch))) return { state: "merged" };
  const range = rangeOf(input.baseBranch ?? "HEAD", input.branch);
  const [nameStatus, numstat] = await Promise.all([
    git(input.checkout, ["diff", "--no-renames", "--name-status", range]),
    git(input.checkout, ["diff", "--no-renames", "--numstat", range]),
  ]);
  return { state: "ready", files: parseChanges(nameStatus, numstat) };
}

/** The diff of one file of a running build's worktree, committed or not. */
async function worktreeFileDiff(worktree: string, base: string, file: string): Promise<string> {
  const diff = await git(worktree, ["diff", "--no-renames", base, "--", file]);
  if (diff) return diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n… truncated` : diff;
  // An untracked file has nothing to diff against: show all of it as added.
  const untracked = (await git(worktree, ["ls-files", "--others", "--exclude-standard", "--", file])).trim();
  if (!untracked) return "";
  const lines = (await readFile(path.join(worktree, file), "utf8")).split("\n");
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

/**
 * The diff of one file of a build's branch. The path must be one the branch
 * changed, so a request cannot read any other file through git.
 */
export async function runFileDiff(input: {
  checkout: string;
  branch: string;
  baseBranch: string | null | undefined;
  worktree?: string | null;
  path: string;
}): Promise<string | null> {
  const changes = await runChanges(input);
  if (changes.state !== "ready") return null;
  if (!changes.files.some((file) => file.path === input.path)) return null;
  if (input.worktree && existsSync(input.worktree)) {
    return worktreeFileDiff(input.worktree, input.baseBranch ?? "HEAD", input.path);
  }
  const range = rangeOf(input.baseBranch ?? "HEAD", input.branch);
  const diff = await git(input.checkout, ["diff", "--no-renames", range, "--", input.path]);
  return diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n… truncated` : diff;
}
