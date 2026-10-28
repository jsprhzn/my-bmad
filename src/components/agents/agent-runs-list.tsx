"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RunStatusBadge } from "@/components/agents/run-status-badge";
import { listAgentRuns } from "@/actions/agent-actions";
import { AGENT_RUN_LABELS } from "@/lib/agents/models";
import type { AgentRun } from "@/lib/agents/run-store";
import { formatRelativeTime } from "@/lib/utils";

/** Reload the runs this often while the page is open. */
const RUNS_POLL_MS = 10000;

/** Agent runs of one project, live: the running ones first, finished ones on request. */
export function AgentRunsList({ owner, repo }: { owner: string; repo: string }) {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const result = await listAgentRuns({ owner, name: repo });
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

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (runs === null) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const runningCount = runs.filter((run) => run.status === "running").length;
  const visible = showFinished ? runs : runs.filter((run) => run.status === "running");
  const projectPath = `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return (
    <div className="space-y-4">
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

      {visible.length === 0 ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-border/50 text-muted-foreground">
          No agents running right now
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((run) => (
            <li key={run.id}>
              <Link href={`${projectPath}/runs/${encodeURIComponent(run.id)}`} className="block">
                <Card className="glass-card transition-shadow duration-300 hover:shadow-sm">
                  <CardContent className="flex items-center gap-3 p-4">
                    {run.status === "running" && (
                      <Loader2 className="size-4 shrink-0 animate-spin text-info" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate font-medium">
                        {run.storyId}: {run.storyTitle}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {AGENT_RUN_LABELS[run.kind]}
                        {run.skill && ` · /${run.skill}`} · {run.model} · started{" "}
                        {formatRelativeTime(run.startedAt)}
                      </p>
                    </div>
                    <RunStatusBadge status={run.status} />
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
