import { describe, expect, it } from "vitest";
import { groupOf, parseChanges } from "../run-changes";
import { parseUnifiedDiff } from "../unified-diff";

describe("parseUnifiedDiff", () => {
  it("numbers the lines of each hunk and drops the file header", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "index 1..2 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10,3 +10,4 @@ function run() {",
      " keep",
      "-old",
      "+new",
      "+extra",
      " end",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([
      {
        context: "function run() {",
        lines: [
          { kind: "context", oldNumber: 10, newNumber: 10, text: "keep" },
          { kind: "del", oldNumber: 11, newNumber: null, text: "old" },
          { kind: "add", oldNumber: null, newNumber: 11, text: "new" },
          { kind: "add", oldNumber: null, newNumber: 12, text: "extra" },
          { kind: "context", oldNumber: 12, newNumber: 13, text: "end" },
        ],
      },
    ]);
  });

  it("keeps a removed line that starts with dashes", () => {
    const hunks = parseUnifiedDiff("@@ -1 +1 @@\n---yaml\n+x");
    expect(hunks[0].lines[0]).toMatchObject({ kind: "del", text: "--yaml" });
  });

  it("returns no hunks for a plain message", () => {
    expect(parseUnifiedDiff("Geen diff beschikbaar.")).toEqual([]);
  });
});

describe("parseChanges", () => {
  it("joins name-status and numstat by path, in path order", () => {
    const nameStatus = ["M\tbackend/src/Payroll.java", "A\tbackend/src/New.java", "D\told/Gone.ts"].join("\n");
    const numstat = ["12\t3\tbackend/src/Payroll.java", "40\t0\tbackend/src/New.java", "0\t25\told/Gone.ts"].join("\n");
    expect(parseChanges(nameStatus, numstat)).toEqual([
      { path: "backend/src/New.java", status: "added", additions: 40, deletions: 0, group: "code" },
      { path: "backend/src/Payroll.java", status: "modified", additions: 12, deletions: 3, group: "code" },
      { path: "old/Gone.ts", status: "deleted", additions: 0, deletions: 25, group: "code" },
    ]);
  });

  it("reports binary files without counts", () => {
    const files = parseChanges("M\tlogo.png", "-\t-\tlogo.png");
    expect(files).toEqual([{ path: "logo.png", status: "modified", additions: null, deletions: null, group: "code" }]);
  });

  it("skips lines it does not understand", () => {
    expect(parseChanges("R100\ta\tb\n\n", "")).toEqual([]);
  });

  it("keeps paths with tabs intact", () => {
    const files = parseChanges("A\tdir/odd\tname.md", "1\t0\tdir/odd\tname.md");
    expect(files[0]).toMatchObject({ path: "dir/odd\tname.md", additions: 1, group: "specs" });
  });
});

describe("groupOf", () => {
  it("puts specs and docs apart from code", () => {
    expect(groupOf("_bmad-output/implementation-artifacts/sprint-status.yaml")).toBe("specs");
    expect(groupOf("docs/API.md")).toBe("specs");
    expect(groupOf("src/lib/agents/run-changes.ts")).toBe("code");
    expect(groupOf("README.md")).toBe("specs");
  });
});

describe("runChanges against a git checkout", () => {
  it("lists the branch's changes, shows one file's diff, and reports a merged branch", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { currentBranch, runChanges, runFileDiff } = await import("../run-changes");

    const dir = mkdtempSync(path.join(tmpdir(), "run-changes-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");

    git("checkout", "-q", "-b", "agent/6.2-1-abc");
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(path.join(dir, "notes.md"), "# notes\n");
    git("add", ".");
    git("commit", "-q", "-m", "build");
    git("checkout", "-q", "main");

    expect(await currentBranch(dir)).toBe("main");

    const changes = await runChanges({ checkout: dir, branch: "agent/6.2-1-abc", baseBranch: "main" });
    expect(changes).toEqual({
      state: "ready",
      files: [
        { path: "a.txt", status: "modified", additions: 1, deletions: 0, group: "code" },
        { path: "notes.md", status: "added", additions: 1, deletions: 0, group: "specs" },
      ],
    });

    const diff = await runFileDiff({ checkout: dir, branch: "agent/6.2-1-abc", baseBranch: "main", path: "a.txt" });
    expect(diff).toContain("+two");

    // A path the branch did not change is refused, so git is never asked for it.
    expect(
      await runFileDiff({ checkout: dir, branch: "agent/6.2-1-abc", baseBranch: "main", path: "../../etc/passwd" }),
    ).toBeNull();

    git("merge", "-q", "--ff-only", "agent/6.2-1-abc");
    git("branch", "-q", "-d", "agent/6.2-1-abc");
    expect(await runChanges({ checkout: dir, branch: "agent/6.2-1-abc", baseBranch: "main" })).toEqual({
      state: "merged",
    });
    expect(await runChanges({ checkout: dir, branch: null, baseBranch: null })).toEqual({ state: "no-branch" });
  });
});
