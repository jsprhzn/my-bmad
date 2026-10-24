import { describe, expect, it } from "vitest";
import {
  devModelFor,
  recommendedModel,
  reviewModelFor,
  runKindsFor,
  runsConflict,
} from "../models";
import { buildAgentPrompt } from "../prompts";
import { formatStream, readStreamResult } from "../stream-format";
import type { StoryModelAdvice } from "@/lib/bmad/types";

function advice(model: string, tiers: StoryModelAdvice["tiers"]): StoryModelAdvice {
  return { id: "1.2", model, tiers };
}

describe("model choice", () => {
  it("builds with the first tier named and reviews one tier higher", () => {
    const mixed = advice("Opus (core) · Haiku (theme)", ["opus", "haiku"]);
    expect(devModelFor(mixed)).toBe("opus");
    expect(reviewModelFor(mixed)).toBe("opus");
    expect(recommendedModel("review", advice("Haiku", ["haiku"]))).toBe("sonnet");
    expect(recommendedModel("review", advice("Sonnet", ["sonnet"]))).toBe("opus");
  });

  it("plans with the build model", () => {
    expect(recommendedModel("plan", advice("Haiku", ["haiku"]))).toBe("haiku");
    expect(recommendedModel("plan", undefined)).toBe("sonnet");
  });

  it("never runs plan and dev, or two of a kind, at once", () => {
    expect(runsConflict("plan", "dev")).toBe(true);
    expect(runsConflict("review", "review")).toBe(true);
    expect(runsConflict("plan", "review")).toBe(false);
    expect(runsConflict("dev", "review")).toBe(false);
  });

  it("offers review only after the story was built", () => {
    expect(runKindsFor("backlog")).toEqual(["plan", "dev"]);
    expect(runKindsFor("ready-for-dev")).toEqual(["dev"]);
    expect(runKindsFor("in-progress")).toEqual(["dev"]);
    expect(runKindsFor("review")).toEqual(["review"]);
    expect(runKindsFor("done")).toEqual(["review"]);
  });

  it("falls back to Sonnet to build and Opus to review", () => {
    expect(devModelFor(undefined)).toBe("sonnet");
    expect(reviewModelFor(undefined)).toBe("opus");
  });
});

describe("buildAgentPrompt", () => {
  const base = {
    storyId: "1.4",
    storyTitle: "Invite my accountant",
    sourcePaths: ["_bmad-output/implementation-artifacts/spec-1-4-invite.md"],
    fixFindings: true,
  };

  it("starts bmad-build-auto with the story and its spec", () => {
    const prompt = buildAgentPrompt({ ...base, kind: "dev", skill: "bmad-build-auto" });
    expect(prompt.split("\n")[0]).toBe("/bmad-build-auto Build story 1.4 (Invite my accountant).");
    expect(prompt).toContain("spec-1-4-invite.md");
  });

  it("plans with bmad-build-auto and halts at ready-for-dev", () => {
    const prompt = buildAgentPrompt({ ...base, kind: "plan", skill: "bmad-build-auto" });
    expect(prompt.split("\n")[0]).toBe(
      "/bmad-build-auto Plan story 1.4 (Invite my accountant). Halt after planning.",
    );
    expect(prompt).toContain("do not implement");
  });

  it("starts with the chosen skill or agent", () => {
    const prompt = buildAgentPrompt({ ...base, kind: "review", skill: "bmad-review" });
    expect(prompt.split("\n")[0]).toBe("/bmad-review Review the changes for story 1.4 (Invite my accountant).");
  });

  it("lets a review fix or only report its findings", () => {
    expect(buildAgentPrompt({ ...base, kind: "review", skill: "bmad-code-review" })).toContain("Resolve every finding");
    const reportOnly = buildAgentPrompt({
      ...base,
      kind: "review",
      skill: "bmad-code-review",
      fixFindings: false,
    });
    expect(reportOnly.split("\n")[0]).toMatch(/^\/bmad-code-review /);
    expect(reportOnly).toContain("Do not change code.");
  });
});

describe("stream formatting", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "abc", model: "claude-haiku-5-5" }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running tests." },
          { type: "tool_use", name: "Bash", input: { command: "./mvnw verify" } },
        ],
      },
    }),
    JSON.stringify({
      type: "result",
      is_error: false,
      num_turns: 4,
      total_cost_usd: 0.1234,
      result: "Done.",
    }),
  ].join("\n");

  it("formats events into readable lines", () => {
    expect(formatStream(stream)).toBe(
      [
        "[claude] session abc · model claude-haiku-5-5",
        "Running tests.",
        "→ Bash ./mvnw verify",
        "[claude] done after 4 turns · $0.1234",
      ].join("\n"),
    );
  });

  it("reads the result, including a failed sign-in", () => {
    expect(readStreamResult(stream)).toEqual({
      isError: false,
      numTurns: 4,
      costUsd: 0.1234,
      text: "Done.",
    });
    const failed = JSON.stringify({ type: "result", is_error: true, result: "Failed to authenticate" });
    expect(readStreamResult(failed)?.isError).toBe(true);
    expect(readStreamResult("still running")).toBeNull();
  });
});

describe("parseClaudeAccounts", () => {
  it("reads named config folders and expands ~", async () => {
    const { parseClaudeAccounts } = await import("../accounts");
    const os = await import("node:os");
    expect(parseClaudeAccounts("work=~/.claude, personal=/opt/claude-2")).toEqual([
      { name: "work", configDir: `${os.homedir()}/.claude` },
      { name: "personal", configDir: "/opt/claude-2" },
    ]);
  });

  it("skips malformed and duplicate entries", async () => {
    const { parseClaudeAccounts } = await import("../accounts");
    expect(parseClaudeAccounts("")).toEqual([]);
    expect(parseClaudeAccounts("=x,bad name=/a,ok=/b,ok=/c").map((a) => a.name)).toEqual(["ok"]);
  });
});

describe("agentEnvironment", () => {
  it("drops server and MyBMAD variables and keeps the user's own", async () => {
    const { agentEnvironment } = await import("../environment");
    const env = agentEnvironment(
      {
        PATH: "/usr/bin",
        JAVA_HOME: "/jdk",
        HTTPS_PROXY: "http://proxy",
        PKG_EXECPATH: "/x/safe-chain",
        npm_lifecycle_event: "dev",
        NODE_OPTIONS: "--inspect",
        __NEXT_PRIVATE_ORIGIN: "x",
        DATABASE_URL: "postgres://secret",
        BETTER_AUTH_SECRET: "secret",
      },
      { CLAUDE_CONFIG_DIR: "/home/.claude" },
      new Set(["DATABASE_URL", "BETTER_AUTH_SECRET"]),
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      JAVA_HOME: "/jdk",
      HTTPS_PROXY: "http://proxy",
      CLAUDE_CONFIG_DIR: "/home/.claude",
    });
  });

  it("reads keys from dotenv content", async () => {
    const { dotenvKeys } = await import("../environment");
    expect(dotenvKeys("# c\nA=1\nexport B = 2\n  C=\nnot a key\n")).toEqual(["A", "B", "C"]);
  });
});

describe("skills per action", () => {
  const installed = [
    { name: "bmad-agent-dev", description: "Amelia", persona: true },
    { name: "bmad-build", description: "", persona: false },
    { name: "bmad-build-auto", description: "", persona: false },
    { name: "bmad-code-review", description: "", persona: false },
    { name: "bmad-help", description: "", persona: false },
  ];

  it("defaults to the preferred installed skill and lists the rest", async () => {
    const { defaultSkillFor, skillsForAction } = await import("../action-skills");
    expect(defaultSkillFor("plan", installed)).toBe("bmad-build-auto");
    expect(defaultSkillFor("review", installed)).toBe("bmad-code-review");
    const dev = skillsForAction("dev", installed);
    expect(dev.suggested.map((s) => s.name)).toEqual(["bmad-build-auto", "bmad-build", "bmad-agent-dev"]);
    expect(dev.other.map((s) => s.name)).toEqual(["bmad-code-review", "bmad-help"]);
  });

  it("has no default when nothing fits", async () => {
    const { defaultSkillFor } = await import("../action-skills");
    expect(defaultSkillFor("review", [{ name: "bmad-help", description: "", persona: false }])).toBeNull();
  });
});

describe("recommendModel", () => {
  it("uses Plan and Review model columns when present, and says so", async () => {
    const { recommendModel } = await import("../models");
    const row: StoryModelAdvice = {
      ...advice("Haiku", ["haiku"]),
      planModel: "Opus",
      planTiers: ["opus"],
      reviewModel: "Sonnet",
      reviewTiers: ["sonnet"],
    };
    expect(recommendModel("plan", row)).toEqual({ model: "opus", source: "Plan model in story-complexity.md" });
    expect(recommendModel("dev", row).model).toBe("haiku");
    expect(recommendModel("review", row)).toEqual({ model: "sonnet", source: "Review model in story-complexity.md" });
  });

  it("explains the fallback rules", async () => {
    const { recommendModel } = await import("../models");
    expect(recommendModel("plan", advice("Haiku", ["haiku"])).source).toBe("build model (no Plan model column)");
    expect(recommendModel("review", advice("Haiku", ["haiku"]))).toEqual({
      model: "sonnet",
      source: "one tier above the build model",
    });
    expect(recommendModel("dev", undefined).source).toBe("default (no row in story-complexity.md)");
  });
});

describe("skill check in the log", () => {
  it("says whether Claude loaded the skill the run starts with", () => {
    const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m", skills: ["bmad-build-auto"] });
    expect(formatStream(init, { skill: "bmad-build-auto" })).toContain("✓ /bmad-build-auto found");
    expect(formatStream(init, { skill: "bmad-spec" })).toContain("✗ /bmad-spec is not among the 1 skills");
  });
});
