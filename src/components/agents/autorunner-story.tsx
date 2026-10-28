"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ModelTierBadge } from "@/components/shared/model-badge";
import { formatTime } from "@/lib/agents/format";
import type { StageView } from "@/lib/agents/run-stages";
import { cn } from "@/lib/utils";
import { setAgentRunPaused, stopAgentRun, type AutorunnerStoryView } from "@/actions/agent-actions";

function barClass(stage: StageView, paused: boolean): string {
  switch (stage.state) {
    case "done":
      return "bg-success";
    case "active":
      return paused ? "bg-primary/50" : "relative overflow-hidden bg-primary/15";
    case "skipped":
      return "bg-muted/50";
    default:
      return "bg-muted";
  }
}

function labelClass(stage: StageView): string {
  switch (stage.state) {
    case "active":
      return "font-medium text-foreground";
    case "done":
      return "text-foreground";
    case "skipped":
      return "text-muted-foreground/60";
    default:
      return "text-muted-foreground";
  }
}

/** The stages of one story in the queue: the model above each stage, a bar that moves while it runs. */
function StageTrack({ stages, paused }: { stages: StageView[]; paused: boolean }) {
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {stages.map((stage) => (
        <div key={stage.id} className="flex min-w-0 flex-col gap-1">
          <span className="flex h-4 items-center">
            {stage.model && stage.state !== "skipped" && <ModelTierBadge tier={stage.model} compact />}
          </span>
          <span
            className={cn("h-1.5 rounded-full", barClass(stage, paused))}
            aria-label={`${stage.label}: ${stage.state}`}
          >
            {stage.state === "active" && !paused && <span className="queue-sweep" aria-hidden="true" />}
          </span>
          <span className={cn("truncate text-xs", labelClass(stage))}>
            {stage.state === "skipped" ? `${stage.label} · niet gedaan` : stage.label}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One story the autorunner is working on, with its run's pause and stop. */
export function AutorunnerStoryRow({
  owner,
  repo,
  story,
  onChanged,
}: {
  owner: string;
  repo: string;
  story: AutorunnerStoryView;
  onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = story.stages.find((s) => s.state === "active");
  const phaseLabel = active?.label ?? "Wacht";

  const act = async (run: () => Promise<{ success: boolean; error?: string }>) => {
    setPending(true);
    setError(null);
    const result = await run();
    setPending(false);
    if (result.success) {
      await onChanged();
    } else {
      setError(result.error ?? "Actie mislukt");
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {story.number} · {story.title}
          </p>
          <p className="text-xs text-muted-foreground">
            {phaseLabel} · gestart {formatTime(story.startedAt)}
            {story.paused && " · gepauzeerd"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              void act(() =>
                setAgentRunPaused({ owner, name: repo, runId: story.runId, paused: !story.paused }),
              )
            }
          >
            {story.paused ? "Hervatten" : "Pauzeren"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void act(() => stopAgentRun({ owner, name: repo, runId: story.runId }))}
          >
            Stoppen
          </Button>
        </div>
      </div>

      <StageTrack stages={story.stages} paused={story.paused} />

      <pre className="min-h-16 overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {story.logTail.length > 0 ? story.logTail.join("\n") : "Nog geen uitvoer."}
      </pre>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
