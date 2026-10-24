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
    const prompt = buildAgentPrompt({ ...base, kind: "dev" });
    expect(prompt.split("\n")[0]).toBe("/bmad-build-auto Build story 1.4 (Invite my accountant).");
    expect(prompt).toContain("spec-1-4-invite.md");
  });

  it("plans with bmad-build-auto and halts at ready-for-dev", () => {
    const prompt = buildAgentPrompt({ ...base, kind: "plan" });
    expect(prompt.split("\n")[0]).toBe(
      "/bmad-build-auto Plan story 1.4 (Invite my accountant). Halt after planning.",
    );
    expect(prompt).toContain("do not implement");
  });

  it("lets a review fix or only report its findings", () => {
    expect(buildAgentPrompt({ ...base, kind: "review" })).toContain("Resolve every finding");
    const reportOnly = buildAgentPrompt({ ...base, kind: "review", fixFindings: false });
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
