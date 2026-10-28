"use client";

import { useState } from "react";
import { CircleCheck, CircleDashed, GitBranch, Loader2, Minus, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RunChangesSheet } from "./run-changes-sheet";
import { RunLogDialog } from "./run-log-dialog";
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
      return paused ? "bg-success/40" : "animate-pulse bg-success";
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

/** The icon at the start of a stage: a check when done, a spinner while it runs, a pause when paused. */
function StageIcon({ stage, paused }: { stage: StageView; paused: boolean }) {
  if (stage.state === "done") return <CircleCheck className="size-4 shrink-0 text-success-foreground" aria-hidden="true" />;
  if (stage.state === "active") {
    return paused ? (
      <Pause className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    ) : (
      <Loader2 className="size-4 shrink-0 animate-spin text-success-foreground" aria-hidden="true" />
    );
  }
  if (stage.state === "skipped") return <Minus className="size-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />;
  return <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

/** The stages of one story in the queue: the model above each stage, then its icon and bar, then its name. */
function StageTrack({ stages, paused }: { stages: StageView[]; paused: boolean }) {
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {stages.map((stage) => (
        <div key={stage.id} className="flex min-w-0 flex-col gap-1">
          <span className="flex h-4 items-center">
            {stage.model && stage.state !== "skipped" && <ModelTierBadge tier={stage.model} compact />}
          </span>
          <span className="flex items-center gap-1.5" aria-label={`${stage.label}: ${stage.state}`}>
            <StageIcon stage={stage} paused={paused} />
            <span className={cn("h-1.5 min-w-0 flex-1 rounded-full", barClass(stage, paused))} />
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
  const [changesOpen, setChangesOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
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
        <div className="flex min-w-0 flex-col items-end gap-2">
          <div className="flex max-w-full min-w-0 items-center gap-2">
            {story.branch && (
              <p className="flex min-w-0 items-center gap-1 font-mono text-xs text-primary">
                <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{story.branch}</span>
              </p>
            )}
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => setChangesOpen(true)}>
              Context…
            </Button>
          </div>
        </div>
      </div>

      <StageTrack stages={story.stages} paused={story.paused} />

      <div className="min-h-16 rounded-md bg-muted/50 p-2 font-mono text-xs leading-relaxed text-muted-foreground">
        {story.logTail.length > 0 ? (
          <ul className="space-y-1">
            {story.logTail.map((line, index) => {
              // The last line of a running story is the one in progress.
              const active = story.running && index === story.logTail.length - 1;
              return (
                <li key={index} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full bg-success",
                      active && "animate-pulse",
                    )}
                  />
                  {line.at && (
                    <time dateTime={line.at} className="shrink-0 tabular-nums">
                      {formatTime(line.at)}
                    </time>
                  )}
                  <span className="min-w-0 break-words whitespace-pre-wrap">{line.text}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          "Nog geen uitvoer."
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" size="sm" onClick={() => setLogOpen(true)}>
          Volledige log…
        </Button>
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

      <RunChangesSheet
        owner={owner}
        repo={repo}
        runId={story.changesRunId}
        storyNumber={story.number}
        title={`${story.number} · ${story.title}`}
        open={changesOpen}
        onOpenChange={setChangesOpen}
      />
      <RunLogDialog
        owner={owner}
        repo={repo}
        runId={story.runId}
        title={`${story.number} · ${story.title}`}
        open={logOpen}
        onOpenChange={setLogOpen}
      />
    </div>
  );
}
