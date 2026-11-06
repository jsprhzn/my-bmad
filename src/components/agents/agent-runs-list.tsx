"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { GitBranch, Loader2, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RunStatusBadge } from "@/components/agents/run-status-badge";
import { RunChangesSheet } from "@/components/agents/run-changes-sheet";
import {
  listAgentRuns,
  setAgentRunPaused,
  stopAgentRun,
} from "@/actions/agent-actions";
import { AGENT_RUN_LABELS } from "@/lib/agents/models";
import type { AgentRun } from "@/lib/agents/run-store";
import { Badge } from "@/components/ui/badge";
import { formatDuration, formatTime } from "@/lib/agents/format";

/** Reload the runs this often while the page is open. */
const RUNS_POLL_MS = 10000;
/** Running times are redrawn this often. */
const CLOCK_MS = 15000;

/** Run kind as a badge: one colour per kind, so the row shows at a glance what it did. */
const KIND_BADGE: Record<string, string> = {
  brainstorm: "border-fuchsia-500/40 text-fuchsia-400",
  plan: "border-blue-500/40 text-blue-400",
  dev: "border-teal-500/40 text-teal-400",
  review: "border-indigo-500/40 text-indigo-400",
};

/** Model as a badge: one colour per tier. */
const MODEL_BADGE: Record<string, string> = {
  haiku: "border-emerald-500/40 text-emerald-400",
  sonnet: "border-sky-500/40 text-sky-400",
  opus: "border-violet-500/40 text-violet-400",
};

/** Agent runs of one project, live: the running ones first, finished ones on request. */
export function AgentRunsList({ owner, repo }: { owner: string; repo: string }) {
  const [runs, setRuns] = useState<(AgentRun & { storyDone: boolean })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const [changesRun, setChangesRun] = useState<AgentRun | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Runs with a pause, resume or stop in flight.
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [controlError, setControlError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const result = await listAgentRuns({ owner, name: repo, withoutAutorun: true });
      if (!active) return;
      if (result.success) {
        setRuns(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    };
    void load();
    const timer = setInterval(() => void load(), RUNS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [owner, repo]);

  /** Pause, resume or stop one run, and show its new state at once. */
  const control = async (run: AgentRun, action: "pause" | "resume" | "stop") => {
    setBusy((prev) => new Set(prev).add(run.id));
    const request = { owner, name: repo, runId: run.id };
    const result =
      action === "stop"
        ? await stopAgentRun(request)
        : await setAgentRunPaused({ ...request, paused: action === "pause" });
    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(run.id);
      return next;
    });
    if (result.success) {
      const updated = result.data;
      setRuns((prev) =>
        prev && prev.map((r) => (r.id === updated.id ? { ...updated, storyDone: r.storyDone } : r)),
      );
    } else {
      setControlError(result.error);
    }
  };

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (runs === null) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const runningCount = runs.filter((run) => run.status === "running").length;
  // "Show finished" reveals the completed runs and the failed or stopped ones whose story is done since.
  const visible = showFinished
    ? runs
    : runs.filter(
        (run) => run.status !== "completed" && !((run.status === "failed" || run.status === "cancelled") && run.storyDone),
      );
  const projectPath = `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return (
    <div className="space-y-4">
      <RunChangesSheet
        owner={owner}
        repo={repo}
        runId={changesRun?.id ?? null}
        storyNumber={changesRun?.storyId}
        title={changesRun ? `${changesRun.storyId}: ${changesRun.storyTitle}` : ""}
        open={changesRun !== null}
        onOpenChange={(open) => !open && setChangesRun(null)}
      />
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{runningCount} running</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowFinished((show) => !show)}
          aria-pressed={showFinished}
        >
          {showFinished ? "Hide finished" : "Show finished"}
        </Button>
      </div>

      {controlError && (
        <p className="text-sm text-destructive" role="alert">
          {controlError}
        </p>
      )}

      {visible.length === 0 ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-border/50 text-muted-foreground">
          No agents running right now
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((run) => (
            <li key={run.id}>
              <Card className="glass-card transition-shadow duration-300 hover:shadow-sm">
                <CardContent className="flex items-center gap-3 p-4">
                  {run.status === "running" && !run.paused && (
                    <Loader2 className="size-4 shrink-0 animate-spin text-info" aria-hidden="true" />
                  )}
                  <Link
                    href={`${projectPath}/runs/${encodeURIComponent(run.id)}`}
                    className="min-w-0 flex-1 space-y-1"
                  >
                    <p className="truncate font-medium">
                      {run.storyId}: {run.storyTitle}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <Badge variant="outline" className={KIND_BADGE[run.kind] ?? ""}>
                        {AGENT_RUN_LABELS[run.kind]}
                      </Badge>
                      {run.skill && <span>· /{run.skill}</span>}
                      <Badge variant="outline" className={MODEL_BADGE[run.model] ?? ""}>
                        {run.model}
                      </Badge>
                      <span>
                        · started {formatTime(run.startedAt)}
                        {run.endedAt
                          ? ` · duur ${formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt))}`
                          : ` · loopt ${formatDuration(now - Date.parse(run.startedAt))}`}
                      </span>
                      {run.costUsd !== null && <span>· ${run.costUsd.toFixed(2)}</span>}
                      {run.branch && (
                        <span className="inline-flex min-w-0 items-center gap-1 font-mono text-primary">
                          · <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                          <span className="truncate">{run.branch}</span>
                        </span>
                      )}
                    </p>
                  </Link>
                  {run.kind === "dev" && (
                    <Button variant="outline" size="sm" onClick={() => setChangesRun(run)}>
                      Changes
                    </Button>
                  )}
                  {run.status === "running" && run.paused ? (
                    <Badge variant="outline">Gepauzeerd</Badge>
                  ) : (
                    <RunStatusBadge status={run.status} />
                  )}
                  {run.status === "running" && (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void control(run, run.paused ? "resume" : "pause")}
                        disabled={busy.has(run.id)}
                        aria-label={run.paused ? "Resume" : "Pause"}
                      >
                        {run.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                        {run.paused ? "Resume" : "Pause"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void control(run, "stop")}
                        disabled={busy.has(run.id)}
                      >
                        <Square className="size-4" />
                        Stop
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
