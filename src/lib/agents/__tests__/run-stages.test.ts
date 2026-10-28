import { describe, expect, it } from "vitest";
import { logTail, reachedStages, stagesOf } from "../run-stages";

function toolUse(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
}

describe("reachedStages", () => {
  it("follows the build skill's step files and its test runs", () => {
    const stream = [
      toolUse("Read", { file_path: "/p/.claude/skills/bmad-build-auto/step-02-plan.md" }),
      toolUse("Read", { file_path: "/p/.claude/skills/bmad-build-auto/step-03-implement.md" }),
      toolUse("Bash", { command: "./mvnw -pl backend test" }),
      toolUse("Read", { file_path: "/p/.claude/skills/bmad-build-auto/step-04-review.md" }),
    ].join("\n");
    expect(reachedStages(stream)).toEqual(["plan", "build", "test", "review"]);
  });

  it("does not count a test run before implementing", () => {
    const stream = toolUse("Bash", { command: "pnpm test" });
    expect(reachedStages(stream)).toEqual([]);
  });

  it("reads a review run from its skill call", () => {
    const stream = toolUse("Skill", { skill: "bmad-code-review" });
    expect(reachedStages(stream)).toEqual(["review"]);
  });

  it("ignores lines that are not events", () => {
    expect(reachedStages("not json\n\n")).toEqual([]);
  });
});

describe("logTail", () => {
  it("returns the last lines of the formatted log", () => {
    const stream = [
      toolUse("Read", { file_path: "a.ts" }),
      toolUse("Read", { file_path: "b.ts" }),
      toolUse("Read", { file_path: "c.ts" }),
      toolUse("Read", { file_path: "d.ts" }),
    ].join("\n");
    const tail = logTail(stream, 2);
    expect(tail).toHaveLength(2);
    expect(tail[1]).toContain("d.ts");
  });
});

describe("stagesOf", () => {
  const models = { build: "sonnet" as const, review: "opus" as const };

  it("marks brainstorming and planning skipped when the queue did not run them", () => {
    const stages = stagesOf({
      current: "build",
      reached: ["build"],
      buildDone: false,
      models,
      hasBrainstorm: false,
      hasPlan: false,
    });
    expect(stages.map((s) => [s.id, s.state])).toEqual([
      ["brainstorm", "skipped"],
      ["plan", "skipped"],
      ["build", "active"],
      ["test", "pending"],
      ["review", "pending"],
    ]);
  });

  it("shows the build model for test and the review model for review", () => {
    const stages = stagesOf({
      current: "review",
      reached: [],
      buildDone: true,
      models,
      hasBrainstorm: false,
      hasPlan: false,
    });
    expect(stages.find((s) => s.id === "test")).toMatchObject({ state: "done", model: "sonnet" });
    expect(stages.find((s) => s.id === "review")).toMatchObject({ state: "active", model: "opus" });
  });

  it("shows a brainstorm run that was made for the story", () => {
    const stages = stagesOf({
      current: null,
      reached: [],
      buildDone: false,
      models: { ...models, brainstorm: "opus" },
      hasBrainstorm: true,
      hasPlan: false,
    });
    expect(stages[0]).toMatchObject({ id: "brainstorm", state: "pending", model: "opus" });
  });
});
