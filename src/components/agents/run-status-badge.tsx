import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AgentRunStatus } from "@/lib/agents/run-store";

const statusConfig: Record<AgentRunStatus, { label: string; className: string }> = {
  running: {
    label: "Running",
    className: "bg-info/15 text-info-foreground border-info/25",
  },
  completed: {
    label: "Completed",
    className: "bg-success/15 text-success-foreground border-success/25",
  },
  failed: {
    label: "Failed",
    className: "bg-destructive/15 text-destructive-foreground border-destructive/25",
  },
  cancelled: {
    label: "Stopped",
    className: "bg-muted text-muted-foreground border-border",
  },
};

export function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  const config = statusConfig[status];
  return (
    <Badge variant="outline" className={cn("min-w-20 justify-center", config.className)}>
      {config.label}
    </Badge>
  );
}
