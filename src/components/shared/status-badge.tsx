import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StoryStatus, EpicStatus } from "@/lib/bmad/types";

const statusConfig: Record<string, { label: string; className: string }> = {
  done: {
    label: "Done",
    className: "bg-success/15 text-success-foreground border-success/25",
  },
  "in-progress": {
    label: "In Progress",
    className: "bg-info/15 text-info-foreground border-info/25",
  },
  review: {
    label: "Review",
    className: "bg-warning/15 text-warning-foreground border-warning/25",
  },
  blocked: {
    label: "Blocked",
    className: "bg-destructive/15 text-destructive-foreground border-destructive/25",
  },
  "ready-for-dev": {
    label: "Ready for Dev",
    className: "bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/25",
  },
  backlog: {
    label: "Backlog",
    className: "bg-muted text-muted-foreground border-border",
  },
  split: {
    label: "Split",
    className: "bg-muted text-muted-foreground border-dashed border-border",
  },
  "not-started": {
    label: "Not Started",
    className: "bg-muted text-muted-foreground border-border",
  },
  unknown: {
    label: "Unknown",
    className: "bg-muted text-muted-foreground border-border",
  },
};

interface StatusBadgeProps {
  status: StoryStatus | EpicStatus;
  compact?: boolean;
  /** A split story whose subtasks are all done: shown green, still dashed and labelled Split. */
  complete?: boolean;
}

export function StatusBadge({ status, compact, complete }: StatusBadgeProps) {
  const config =
    status === "split" && complete
      ? { ...statusConfig.split, className: "bg-success/15 text-success-foreground border-dashed border-success/25" }
      : statusConfig[status] || statusConfig.unknown;
  return (
    <Badge
      variant="outline"
      className={cn("min-w-24 justify-center", config.className, compact && "px-1.5 py-0 text-[10px] leading-4")}
    >
      {config.label}
    </Badge>
  );
}
