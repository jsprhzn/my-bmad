import type { ModelTier, StoryModelAdvice, StoryStatus } from "@/lib/bmad/types";

export const MODEL_TIERS: ModelTier[] = ["haiku", "sonnet", "opus"];

/** plan writes the spec and stops at ready-for-dev; dev plans (if needed) and builds. */
export type AgentRunKind = "plan" | "dev" | "review";

export const AGENT_RUN_LABELS: Record<AgentRunKind, string> = {
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
};

export function runKindsFor(status: StoryStatus): AgentRunKind[] {
  return KINDS_BY_STATUS[status] ?? ["plan", "dev"];
}

/** Kinds that write the same spec and code, so two of them must not run at once. */
export function runsConflict(a: AgentRunKind, b: AgentRunKind): boolean {
  const builds = (k: AgentRunKind) => k === "plan" || k === "dev";
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

/** Planning uses the build model: the spec decides what gets built. */
export function recommendedModel(kind: AgentRunKind, advice?: StoryModelAdvice): ModelTier {
  return kind === "review" ? reviewModelFor(advice) : devModelFor(advice);
}
