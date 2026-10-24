import type { ModelTier, StoryModelAdvice } from "@/lib/bmad/types";

export const MODEL_TIERS: ModelTier[] = ["haiku", "sonnet", "opus"];

export type AgentRunKind = "dev" | "review";

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

export function recommendedModel(kind: AgentRunKind, advice?: StoryModelAdvice): ModelTier {
  return kind === "dev" ? devModelFor(advice) : reviewModelFor(advice);
}
