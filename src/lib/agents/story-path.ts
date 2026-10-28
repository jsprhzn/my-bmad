import type { ModelTier, StoryModelAdvice, StoryStatus } from "@/lib/bmad/types";
import { devModelFor, recommendedModel, type AgentRunKind } from "./models";

/**
 * The route a story takes from here, and the actions that belong on it:
 * - brainstorm → plan → dev: a large story without a spec; first settle the design questions.
 * - plan → dev: no spec, and the spec holds decisions the plan model must make.
 * - fastlane: no spec and no hard decisions: dev builds directly.
 * - dev: the spec is in place; build it.
 * - review: built and waiting for review.
 * - done: built; a review is still offered.
 */
export type StoryPath = "brainstorm" | "plan" | "fastlane" | "dev" | "review" | "done";

export interface StoryPathStep {
  kind: AgentRunKind;
  primary: boolean;
  /** Why this step, in one line, for the UI. */
  why: string;
}

export interface StoryPathInput {
  status: StoryStatus;
  /** A spec file exists for the story (its markdown is in the project). */
  hasSpec: boolean;
  advice?: StoryModelAdvice;
}

export interface StoryPathResult {
  path: StoryPath;
  summary: string;
  steps: StoryPathStep[];
}

/** Complexity from story-complexity.md that counts as large. */
export const LARGE_COMPLEXITY = new Set(["L", "XL"]);

const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

export function storyPathFor({ status, hasSpec, advice }: StoryPathInput): StoryPathResult {
  if (status === "review") {
    return {
      path: "review",
      summary: "Built and waiting for review.",
      steps: [{ kind: "review", primary: true, why: "The build is in place: review it." }],
    };
  }
  if (status === "done") {
    return {
      path: "done",
      summary: "Done.",
      steps: [{ kind: "review", primary: false, why: "Review again if the code changed." }],
    };
  }

  const dev: StoryPathStep = {
    kind: "dev",
    primary: false,
    why: "Build the story with the build model.",
  };

  if (hasSpec) {
    return {
      path: "dev",
      summary: "Spec is in place: build it.",
      steps: [{ ...dev, primary: true }],
    };
  }

  const plan: StoryPathStep = {
    kind: "plan",
    primary: false,
    why: "The plan model writes the spec first.",
  };
  const devTier = devModelFor(advice);
  const planTier = recommendedModel("plan", advice);
  const largeStory = LARGE_COMPLEXITY.has(advice?.complexity ?? "");
  // Opus builds touch invariants (posting, RLS, fiscal rules): always spec them first.
  const specNeeded =
    TIER_RANK[planTier] > TIER_RANK[devTier] || devTier === "opus";

  if (largeStory) {
    return {
      path: "brainstorm",
      summary: "Large story without a spec: explore the open design questions first.",
      steps: [
        {
          kind: "brainstorm",
          primary: true,
          why: "Large story: settle the design questions before writing the spec.",
        },
        { ...plan, primary: false },
        { ...dev, primary: false },
      ],
    };
  }
  if (specNeeded) {
    return {
      path: "plan",
      summary: "No spec yet, and the spec holds decisions the plan model must make.",
      steps: [{ ...plan, primary: true }, { ...dev, primary: false }],
    };
  }
  return {
    path: "fastlane",
    summary: "No spec needed: the plan model equals the build model. Build directly.",
    steps: [{ ...dev, primary: true, why: "Fastlane: no spec, build directly." }],
  };
}
