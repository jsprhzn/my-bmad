"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RunStatusBadge } from "./run-status-badge";
import { getAgentRun, stopAgentRun } from "@/actions/agent-actions";
import type { AgentRun } from "@/lib/agents/run-store";

const POLL_MS = 3000;

interface AgentRunViewProps {
  owner: string;
  repo: string;
  initial: { run: AgentRun; log: string; prompt: string };
}

/** A run's status and log, refreshed while it runs, with a stop button. */
export function AgentRunView({ owner, repo, initial }: AgentRunViewProps) {
  const [data, setData] = useState(initial);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logEnd = useRef<HTMLSpanElement>(null);
  const { run } = data;

  const reload = useCallback(async () => {
    const result = await getAgentRun({ owner, name: repo, runId: run.id });
    if (result.success) setData(result.data);
  }, [owner, repo, run.id]);

  useEffect(() => {
    if (run.status !== "running") return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [run.status, reload]);

  useEffect(() => {
    if (run.status === "running") logEnd.current?.scrollIntoView({ block: "end" });
  }, [data.log, run.status]);

  const stop = async () => {
    setStopping(true);
    setError(null);
    const result = await stopAgentRun({ owner, name: repo, runId: run.id });
    if (result.success) await reload();
    else setError(result.error);
    setStopping(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <RunStatusBadge status={run.status} />
        <span className="text-sm text-muted-foreground">
          Started {new Date(run.startedAt).toLocaleString()}
          {run.endedAt && ` · ended ${new Date(run.endedAt).toLocaleString()}`}
          {run.numTurns !== null && ` · ${run.numTurns} turns`}
          {run.costUsd !== null && ` · $${run.costUsd.toFixed(4)}`}
        </span>
        {run.status === "running" && (
          <Button variant="outline" size="sm" onClick={() => void stop()} disabled={stopping}>
            {stopping ? <Loader2 className="animate-spin" /> : <Square />}
            Stop
          </Button>
        )}
      </div>

      {(run.error || error) && (
        <p className="text-sm text-destructive" role="alert">
          {error ?? run.error}
        </p>
      )}

      <Card className="glass-card">
        <CardContent className="p-5">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Log
          </h4>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
            {data.log || (run.status === "running" ? "Waiting for output…" : "No output.")}
            <span ref={logEnd} />
          </pre>
        </CardContent>
      </Card>

      <Card className="glass-card">
        <CardContent className="p-5">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Prompt
          </h4>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {data.prompt}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
