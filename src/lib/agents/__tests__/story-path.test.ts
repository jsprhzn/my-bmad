import { describe, expect, it } from "vitest";
import { storyPathFor } from "../story-path";
import type { StoryModelAdvice } from "@/lib/bmad/types";

function advice(overrides: Partial<StoryModelAdvice>): StoryModelAdvice {
  return { id: "1.3", model: "Sonnet", tiers: ["sonnet"], ...overrides };
}

describe("storyPathFor", () => {
  it("goes fastlane for a small story whose plan model equals the build model", () => {
    const result = storyPathFor({
      status: "backlog",
      hasSpec: false,
      advice: advice({ complexity: "S", model: "Haiku", tiers: ["haiku"], planTiers: ["haiku"] }),
    });
    expect(result.path).toBe("fastlane");
    expect(result.steps.map((s) => [s.kind, s.primary])).toEqual([["dev", true]]);
  });

  it("plans first when the plan model is heavier than the build model", () => {
    const result = storyPathFor({
      status: "backlog",
      hasSpec: false,
      advice: advice({ complexity: "M", planTiers: ["opus"] }),
    });
    expect(result.path).toBe("plan");
    expect(result.steps.map((s) => [s.kind, s.primary])).toEqual([
      ["plan", true],
      ["dev", false],
    ]);
  });

  it("plans first for an Opus build even when plan and build are both Opus", () => {
    const result = storyPathFor({
      status: "backlog",
      hasSpec: false,
      advice: advice({ complexity: "M", model: "Opus", tiers: ["opus"], planTiers: ["opus"] }),
    });
    expect(result.path).toBe("plan");
  });

  it("brainstorms first for a large story without a spec", () => {
    const result = storyPathFor({
      status: "backlog",
      hasSpec: false,
      advice: advice({ complexity: "L", model: "Opus", tiers: ["opus"], planTiers: ["opus"] }),
    });
    expect(result.path).toBe("brainstorm");
    expect(result.steps.map((s) => s.kind)).toEqual(["brainstorm", "plan", "dev"]);
    expect(result.steps[0].primary).toBe(true);
  });

  it("builds when the spec is in place", () => {
    const result = storyPathFor({
      status: "in-progress",
      hasSpec: true,
      advice: advice({ complexity: "L", planTiers: ["opus"] }),
    });
    expect(result.path).toBe("dev");
    expect(result.steps.map((s) => [s.kind, s.primary])).toEqual([["dev", true]]);
  });

  it("offers review for a story in review", () => {
    expect(storyPathFor({ status: "review", hasSpec: true }).steps).toEqual([
      expect.objectContaining({ kind: "review", primary: true }),
    ]);
  });

  it("keeps a review available for a done story", () => {
    expect(storyPathFor({ status: "done", hasSpec: true }).steps).toEqual([
      expect.objectContaining({ kind: "review", primary: false }),
    ]);
  });

  it("uses the default model when there is no advice", () => {
    const result = storyPathFor({ status: "backlog", hasSpec: false });
    expect(result.path).toBe("fastlane");
  });
});
