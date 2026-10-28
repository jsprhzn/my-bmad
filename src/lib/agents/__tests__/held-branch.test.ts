import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRun, startRun, type AgentRun, type StartRunInput } from "../run-store";

/**
 * Runs the real start, build and merge shell flow in a temporary checkout. The
 * agent is replaced by a shell command from AGENT_COMMAND_TEMPLATE, so no Claude
 * is needed.
 */

const RESULT_LINE = `echo '{"type":"result","is_error":false,"num_turns":1,"total_cost_usd":0}'`;
const OWNER = { repoKey: "owner/repo", userId: "user-1" };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

async function finished(id: string): Promise<AgentRun> {
  for (let i = 0; i < 300; i++) {
    const found = await getRun(id, OWNER);
    if (found && found.run.status !== "running") return found.run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${id} did not finish`);
}

function input(overrides: Partial<StartRunInput>): StartRunInput {
  return {
    repoKey: OWNER.repoKey,
    userId: OWNER.userId,
    localPath: "",
    storyId: "7.1",
    storyTitle: "held branch",
    kind: "dev",
    skill: "bmad-build-auto",
    model: "sonnet",
    prompt: "work",
    account: null,
    permissionMode: "auto",
    ...overrides,
  };
}

describe("held builds and branch-based reviews", () => {
  let checkout: string;
  let runsDirectory: string;
  const previousTemplate = process.env.AGENT_COMMAND_TEMPLATE;
  const previousRunsDir = process.env.AGENT_RUNS_DIR;

  beforeEach(() => {
    checkout = mkdtempSync(path.join(tmpdir(), "held-checkout-"));
    runsDirectory = mkdtempSync(path.join(tmpdir(), "held-runs-"));
    process.env.AGENT_RUNS_DIR = runsDirectory;
    git(checkout, "init", "-q", "-b", "main");
    git(checkout, "config", "user.email", "test@example.com");
    git(checkout, "config", "user.name", "Test");
    writeFileSync(path.join(checkout, "base.txt"), "base\n");
    git(checkout, "add", ".");
    git(checkout, "commit", "-q", "-m", "base");
  });

  afterEach(() => {
    if (previousTemplate === undefined) delete process.env.AGENT_COMMAND_TEMPLATE;
    else process.env.AGENT_COMMAND_TEMPLATE = previousTemplate;
    if (previousRunsDir === undefined) delete process.env.AGENT_RUNS_DIR;
    else process.env.AGENT_RUNS_DIR = previousRunsDir;
  });

  it("keeps a held build's branch until its review merges it", async () => {
    process.env.AGENT_COMMAND_TEMPLATE = `echo build > build.txt && git add build.txt && git commit -qm build && ${RESULT_LINE}`;
    const build = await startRun(input({ localPath: checkout, kind: "dev", hold: true }));
    const buildDone = await finished(build.id);

    expect(buildDone.status).toBe("completed");
    expect(buildDone.held).toBe(true);
    expect(buildDone.branch).toBe(build.branch);
    // Not merged yet: main is untouched and the branch still exists.
    expect(git(checkout, "log", "--oneline", "main")).not.toContain("build");
    expect(git(checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${build.branch}`)).toBeTruthy();

    process.env.AGENT_COMMAND_TEMPLATE = `echo reviewed && ${RESULT_LINE}`;
    const review = await startRun(
      input({
        localPath: checkout,
        kind: "review",
        reuseBuild: { runId: build.id, branch: buildDone.branch ?? "", baseBranch: buildDone.baseBranch ?? null },
      }),
    );
    const reviewDone = await finished(review.id);

    expect(reviewDone.status).toBe("completed");
    expect(reviewDone.branch).toBe(build.branch);
    // The review merged the build's commits and removed its branch.
    expect(git(checkout, "log", "--oneline", "main")).toContain("build");
    expect(() => git(checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${build.branch}`)).toThrow();
  }, 60_000);

  it("merges a plan on its own branch", async () => {
    process.env.AGENT_COMMAND_TEMPLATE = `echo spec > spec.md && git add spec.md && git commit -qm plan && ${RESULT_LINE}`;
    const plan = await startRun(input({ localPath: checkout, kind: "plan" }));
    const planDone = await finished(plan.id);

    expect(planDone.status).toBe("completed");
    expect(planDone.branch).toBe(plan.branch);
    expect(planDone.held).toBeFalsy();
    expect(git(checkout, "log", "--oneline", "main")).toContain("plan");
    expect(() => git(checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${plan.branch}`)).toThrow();
  }, 60_000);
});
