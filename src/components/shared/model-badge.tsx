import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ModelTier, StoryModelAdvice } from "@/lib/bmad/types";

const tierConfig: Record<ModelTier, { label: string; className: string }> = {
  opus: {
    label: "Opus",
    className: "bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/25",
  },
  sonnet: {
    label: "Sonnet",
    className: "bg-info/15 text-info-foreground border-info/25",
  },
  haiku: {
    label: "Haiku",
    className: "bg-success/15 text-success-foreground border-success/25",
  },
};

export function ModelTierBadge({ tier, compact }: { tier: ModelTier; compact?: boolean }) {
  const config = tierConfig[tier];
  return (
    <Badge
      variant="outline"
      className={cn(config.className, compact && "px-1.5 py-0 text-[10px] leading-4")}
    >
      {config.label}
    </Badge>
  );
}

interface ModelBadgeProps {
  advice?: StoryModelAdvice;
  compact?: boolean;
  /** Show the complexity (S/M/L/XL) next to the model. */
  showComplexity?: boolean;
}

/** The recommended model(s) for a story, with the full advice as tooltip. */
export function ModelBadge({ advice, compact, showComplexity = true }: ModelBadgeProps) {
  if (!advice || advice.tiers.length === 0) return null;
  const tooltip = [advice.model, advice.reason].filter(Boolean).join(" — ");
  return (
    <span className="inline-flex items-center gap-1" title={tooltip}>
      {advice.tiers.map((tier) => (
        <ModelTierBadge key={tier} tier={tier} compact={compact} />
      ))}
      {showComplexity && advice.complexity && (
        <span className="text-xs font-medium text-muted-foreground">{advice.complexity}</span>
      )}
    </span>
  );
}
