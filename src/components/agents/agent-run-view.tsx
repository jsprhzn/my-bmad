"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { RunLog } from "./run-log";
import { RunStatusBadge } from "./run-status-badge";
import { getAgentRun, replyAgentRun, stopAgentRun } from "@/actions/agent-actions";
import type { AgentRun } from "@/lib/agents/run-store";

const POLL_MS = 3000;

interface AgentRunViewProps {
  owner: string;
  repo: string;
  initial: { run: AgentRun; log: string; prompt: string; sessionId: string | null };
}

/** A run's status and log, refreshed while it runs, with a stop button and a reply box once it ends. */
export function AgentRunView({ owner, repo, initial }: AgentRunViewProps) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [replying, setReplying] = useState(false);
  const logScroll = useRef<HTMLDivElement>(null);
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
    const scroll = logScroll.current;
    if (run.status === "running" && scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [data.log, run.status]);

  const stop = async () => {
    setStopping(true);
    setError(null);
    const result = await stopAgentRun({ owner, name: repo, runId: run.id });
    if (result.success) await reload();
    else setError(result.error);
    setStopping(false);
  };

  const reply = async (text = answer) => {
    setReplying(true);
    setError(null);
    const result = await replyAgentRun({ owner, name: repo, runId: run.id, answer: text });
    if (result.success) router.push(`/repo/${owner}/${repo}/runs/${result.data.id}`);
    else setError(result.error);
    setReplying(false);
  };

  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[32rem] flex-col gap-4">
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

      <Card className="glass-card shrink-0 gap-0 py-0">
        <CardContent className="p-4">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Prompt
          </h4>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {data.prompt}
          </pre>
        </CardContent>
      </Card>

      <Card className="glass-card min-h-0 flex-1 gap-0 py-0">
        <CardContent className="flex min-h-0 flex-1 flex-col p-4">
          <h4 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Log
            {run.status === "running" && (
              <span
                role="status"
                aria-label="Bezig"
                title="Bezig"
                className="size-2 animate-pulse rounded-full bg-success"
              />
            )}
          </h4>
          <div ref={logScroll} className="min-h-0 flex-1 overflow-y-scroll pr-2">
            <RunLog
              log={data.log}
              emptyText={run.status === "running" ? "Waiting for output…" : "No output."}
              onChoose={
                run.status !== "running" && data.sessionId && !replying
                  ? (text) => void reply(text)
                  : undefined
              }
            />
          </div>
        </CardContent>
      </Card>

      {run.status !== "running" && data.sessionId && (
        <Card className="glass-card shrink-0 gap-0 py-0">
          <CardContent className="p-4">
            <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Answer
            </h4>
            <div className="flex flex-col gap-3">
              <Textarea
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="Reply to Claude; the run continues in the same session."
                rows={3}
                disabled={replying}
              />
              <div>
                <Button onClick={() => void reply()} disabled={replying || !answer.trim()}>
                  {replying && <Loader2 className="animate-spin" />}
                  Send answer
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
