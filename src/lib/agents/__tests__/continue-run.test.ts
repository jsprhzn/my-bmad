import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRun, startRun, type StartRunInput } from "../run-store";

// A stand-in for Claude: it reads the prompt, prints a session and a result, and fails when FAKE_ERR is "true".
const FAKE_TEMPLATE =
  "cat >/dev/null; printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-1\"}' " +
  "'{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":'\"$FAKE_ERR\"',\"num_turns\":1,\"total_cost_usd\":0,\"result\":\"done\"}'; true";

function input(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    repoKey: "owner/repo",
    userId: "user-1",
    localPath: mkdtempSync(path.join(tmpdir(), "continue-run-project-")),
    storyId: "5.3",
    storyTitle: "Receipts",
    kind: "dev",
    skill: "bmad-build-auto",
    model: "sonnet",
    prompt: "build the story",
    account: null,
    permissionMode: "bypassPermissions",
    ...overrides,
  };
}

/** Wait until the run has written its outcome (exit file), then read the record back. */
async function settle(id: string) {
  for (let i = 0; i < 300; i++) {
    if (existsSync(path.join(process.env.AGENT_RUNS_DIR!, `${id}.exit`))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const found = await getRun(id, { repoKey: "owner/repo", userId: "user-1" });
  if (!found) throw new Error("run not found");
  return found.run;
}

describe("continuing a run", () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(path.join(tmpdir(), "continue-run-records-"));
    process.env.AGENT_RUNS_DIR = runsDir;
    process.env.AGENT_COMMAND_TEMPLATE = FAKE_TEMPLATE;
  });

  afterEach(() => {
    delete process.env.AGENT_RUNS_DIR;
    delete process.env.AGENT_COMMAND_TEMPLATE;
    delete process.env.FAKE_ERR;
  });

  it("keeps the same record, appends the log and resumes the session", async () => {
    process.env.FAKE_ERR = "true";
    const first = await startRun(input());
    const failed = await settle(first.id);
    expect(failed.status).toBe("failed");

    process.env.FAKE_ERR = "false";
    const again = await startRun(input({ continueRunId: first.id, prompt: "carry on" }));

    expect(again.id).toBe(first.id);
    const records = readdirSync(runsDir).filter((name) => name.endsWith(".json"));
    expect(records).toHaveLength(1);

    const continued = await settle(first.id);
    expect(continued.status).toBe("completed");
    expect(continued.error).toBeNull();

    const log = readFileSync(path.join(runsDir, `${first.id}.jsonl`), "utf8");
    expect(log.match(/"subtype":"init"/g)).toHaveLength(2);
  });

  it("refuses to continue a run that has no session", async () => {
    await expect(startRun(input({ continueRunId: "1700000000000-deadbeef" }))).rejects.toThrow("Run not found");
  });
});
