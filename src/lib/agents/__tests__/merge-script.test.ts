import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { mergeScript, startScript } from "../run-store";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const SPRINT = "_bmad-output/implementation-artifacts/sprint-status.yaml";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

describe("agent run scripts", () => {
  let root: string;
  let checkout: string;

  /** Runs a generated script from the temp root, so it never dirties the checkout. */
  function sh(script: string, file: string): void {
    writeFileSync(path.join(root, file), script, "utf8");
    execFileSync("sh", [path.join(root, file)], { cwd: checkout, env: GIT_ENV });
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "agent-scripts-"));
    checkout = path.join(root, "checkout");
    mkdirSync(checkout);
    git(checkout, "init", "-q", "-b", "main");
    mkdirSync(path.join(checkout, path.dirname(SPRINT)), { recursive: true });
    writeFileSync(path.join(checkout, SPRINT), "development_status:\n  3-4-book-line: ready-for-dev\n");
    writeFileSync(path.join(checkout, "file.txt"), "base\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "-q", "-m", "base");
  });

  function storyWorktree(): string {
    const worktree = path.join(root, "worktree");
    git(checkout, "worktree", "add", "-q", "-b", "agent/3.4-run", worktree, "HEAD");
    return worktree;
  }

  function mergeFor(worktree: string, resolveCommand: string) {
    const result = path.join(root, "merge.txt");
    const script = mergeScript({
      checkout,
      worktree,
      branch: "agent/3.4-run",
      result,
      storyPrefix: "3-4-",
      resolveCommand,
      conflictPromptFile: path.join(root, "prompt.txt"),
      conflictLog: path.join(root, "conflict.log"),
    });
    writeFileSync(path.join(root, "prompt.txt"), "resolve", "utf8");
    return { result, script };
  }

  it("sets the story to in-progress in the checkout before the branch is cut", () => {
    sh(startScript({ checkout, storyPrefix: "3-4-" }), "start.sh");

    const sprint = readFileSync(path.join(checkout, SPRINT), "utf8");
    expect(sprint).toContain("  3-4-book-line: in-progress");
    expect(git(checkout, "log", "-1", "--format=%s")).toBe(
      "chore: set 3-4-book-line to in-progress in sprint-status\n",
    );
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  it("leaves a sprint-status the user is editing by hand alone", () => {
    writeFileSync(path.join(checkout, SPRINT), "development_status:\n  3-4-book-line: backlog\n");
    sh(startScript({ checkout, storyPrefix: "3-4-" }), "start.sh");

    expect(readFileSync(path.join(checkout, SPRINT), "utf8")).toContain("3-4-book-line: backlog");
    expect(git(checkout, "log", "--oneline")).not.toContain("in-progress");
  });

  it("merges a story whose rebase conflicts once the agent resolves them", () => {
    const worktree = storyWorktree();
    writeFileSync(path.join(worktree, "file.txt"), "story\n");
    git(worktree, "commit", "-q", "-am", "story");
    writeFileSync(path.join(checkout, "file.txt"), "main\n");
    git(checkout, "commit", "-q", "-am", "main");

    // A stand-in for the agent: it resolves the conflict and continues the rebase.
    const resolver = path.join(root, "resolve.sh");
    writeFileSync(
      resolver,
      [
        "printf 'resolved\\n' > file.txt",
        "git add file.txt",
        "GIT_EDITOR=true git rebase --continue",
        "",
      ].join("\n"),
    );
    const { result, script } = mergeFor(worktree, `sh ${resolver}`);
    sh(script, "merge.sh");

    expect(readFileSync(result, "utf8").trim()).toBe("merged");
    expect(readFileSync(path.join(checkout, "file.txt"), "utf8")).toBe("resolved\n");
  });

  it("has the agent commit changes a build left behind, then merges", () => {
    const worktree = storyWorktree();
    writeFileSync(path.join(worktree, "file.txt"), "story\n");
    git(worktree, "commit", "-q", "-am", "story");
    writeFileSync(path.join(worktree, "leftover.txt"), "unfinished\n");

    // A stand-in for the agent that finishes the build: it commits what was left.
    const finisher = path.join(root, "finish.sh");
    writeFileSync(finisher, "git add -A\ngit commit -q -m 'finish the build'\n");
    const result = path.join(root, "merge.txt");
    const finishPromptFile = path.join(root, "finish.prompt.txt");
    writeFileSync(finishPromptFile, "finish", "utf8");
    const script = mergeScript({
      checkout,
      worktree,
      branch: "agent/3.4-run",
      result,
      storyPrefix: "3-4-",
      resolveCommand: `sh ${finisher}`,
      conflictPromptFile: path.join(root, "prompt.txt"),
      conflictLog: path.join(root, "conflict.log"),
      finishPromptFile,
    });
    sh(script, "merge.sh");

    expect(readFileSync(result, "utf8").trim()).toBe("merged");
    expect(readFileSync(path.join(checkout, "leftover.txt"), "utf8")).toBe("unfinished\n");
  });

  it("does not merge when the agent leaves the conflict unresolved", () => {
    const worktree = storyWorktree();
    writeFileSync(path.join(worktree, "file.txt"), "story\n");
    git(worktree, "commit", "-q", "-am", "story");
    writeFileSync(path.join(checkout, "file.txt"), "main\n");
    git(checkout, "commit", "-q", "-am", "main");

    const { result, script } = mergeFor(worktree, "true");
    // The script exits 1 when it does not merge.
    expect(() => sh(script, "merge.sh")).toThrow();

    expect(readFileSync(result, "utf8")).toContain("that the AI could not resolve");
    expect(readFileSync(path.join(checkout, "file.txt"), "utf8")).toBe("main\n");
  });
});
