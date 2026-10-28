import type { ModelTier, StoryModelAdvice, StoryStatus } from "@/lib/bmad/types";

export const MODEL_TIERS: ModelTier[] = ["haiku", "sonnet", "opus"];

/**
 * brainstorm settles the open design questions before a spec; plan writes the
 * spec and stops at ready-for-dev; dev plans (if needed) and builds.
 */
export type AgentRunKind = "brainstorm" | "plan" | "dev" | "review";

export const AGENT_RUN_LABELS: Record<AgentRunKind, string> = {
  brainstorm: "Brainstorm",
  plan: "Plan",
  dev: "Dev",
  review: "Review",
};

/**
 * Which actions fit a story's status: plan before there is a spec, build
 * until it is in review, review only after it was built.
 */
const KINDS_BY_STATUS: Record<StoryStatus, AgentRunKind[]> = {
  backlog: ["plan", "dev"],
  unknown: ["plan", "dev"],
  "ready-for-dev": ["dev"],
  "in-progress": ["dev"],
  blocked: ["dev"],
  review: ["review"],
  done: ["review"],
  // A split story is worked on through its subtasks, so the parent offers no action.
  split: [],
};

export function runKindsFor(status: StoryStatus): AgentRunKind[] {
  return KINDS_BY_STATUS[status] ?? ["plan", "dev"];
}

/** Kinds that write the same spec and code, so two of them must not run at once. */
export function runsConflict(a: AgentRunKind, b: AgentRunKind): boolean {
  const builds = (k: AgentRunKind) => k !== "review";
  return a === b || (builds(a) && builds(b));
}

/** Model used when the project has no advice for the story. */
export const DEFAULT_DEV_MODEL: ModelTier = "sonnet";

/** Build with the first model the advice names. */
export function devModelFor(advice?: StoryModelAdvice): ModelTier {
  return advice?.tiers[0] ?? DEFAULT_DEV_MODEL;
}

/** Review one tier above the build model, so a cheap build gets a stronger check. */
export function reviewModelFor(advice?: StoryModelAdvice): ModelTier {
  const dev = MODEL_TIERS.indexOf(devModelFor(advice));
  return MODEL_TIERS[Math.min(dev + 1, MODEL_TIERS.length - 1)];
}

export interface ModelRecommendation {
  model: ModelTier;
  /** Where the recommendation comes from, for the UI. */
  source: string;
}

/**
 * The model for an action. story-complexity.md may name one per action
 * (Plan model / Review model columns); otherwise planning uses the build
 * model (the spec decides what gets built) and review one tier above it.
 */
export function recommendModel(
  kind: AgentRunKind,
  advice?: StoryModelAdvice,
): ModelRecommendation {
  if (kind === "brainstorm") {
    // Brainstorming settles the design the spec records: the plan model decides it.
    const plan = recommendModel("plan", advice);
    return { model: plan.model, source: `same as plan: ${plan.source}` };
  }
  if (kind === "plan" && advice?.planTiers?.[0]) {
    return { model: advice.planTiers[0], source: "Plan model in story-complexity.md" };
  }
  if (kind === "review" && advice?.reviewTiers?.[0]) {
    return { model: advice.reviewTiers[0], source: "Review model in story-complexity.md" };
  }
  if (!advice?.tiers[0]) {
    return {
      model: kind === "review" ? reviewModelFor(advice) : DEFAULT_DEV_MODEL,
      source: "default (no row in story-complexity.md)",
    };
  }
  if (kind === "review") {
    return { model: reviewModelFor(advice), source: "one tier above the build model" };
  }
  return {
    model: devModelFor(advice),
    source: kind === "plan" ? "build model (no Plan model column)" : "Model in story-complexity.md",
  };
}

export function recommendedModel(kind: AgentRunKind, advice?: StoryModelAdvice): ModelTier {
  return recommendModel(kind, advice).model;
}
