"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bot, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelBadge } from "@/components/shared/model-badge";
import { RunStatusBadge } from "./run-status-badge";
import { listAgentRuns, startAgentRun } from "@/actions/agent-actions";
import {
  AGENT_RUN_LABELS,
  MODEL_TIERS,
  recommendedModel,
  runKindsFor,
  type AgentRunKind,
} from "@/lib/agents/models";
import type { AgentRun } from "@/lib/agents/run-store";
import type { ModelTier, StoryModelAdvice, StoryStatus } from "@/lib/bmad/types";

const POLL_MS = 5000;

const ACTIONS: { kind: AgentRunKind; label: string }[] = [
  { kind: "plan", label: "Plan" },
  { kind: "dev", label: "Start dev" },
  { kind: "review", label: "Start review" },
];

interface StoryAgentsCardProps {
  owner: string;
  repo: string;
  storyId: string;
  /** Decides which actions are offered (no review before the story is built). */
  storyStatus: StoryStatus;
  modelAdvice?: StoryModelAdvice;
  /** Why agents cannot run here, or null when they can. */
  unavailableReason: string | null;
  /** The story's runs, loaded with the page. */
  initialRuns: AgentRun[];
}

/** Start a dev or review run for a story with the recommended model, and follow its runs. */
export function StoryAgentsCard({
  owner,
  repo,
  storyId,
  storyStatus,
  modelAdvice,
  unavailableReason,
  initialRuns,
}: StoryAgentsCardProps) {
  const [models, setModels] = useState<Record<AgentRunKind, ModelTier>>({
    plan: recommendedModel("plan", modelAdvice),
    dev: recommendedModel("dev", modelAdvice),
    review: recommendedModel("review", modelAdvice),
  });
  const [fixFindings, setFixFindings] = useState(true);
  const [runs, setRuns] = useState<AgentRun[]>(initialRuns);
  const [pending, setPending] = useState<AgentRunKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    const result = await listAgentRuns({ owner, name: repo, storyId });
    if (result.success) setRuns(result.data);
  }, [owner, repo, storyId]);

  const kinds = runKindsFor(storyStatus);
  const actions = ACTIONS.filter((action) => kinds.includes(action.kind));
  const anyRunning = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void loadRuns(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunning, loadRuns]);

  const start = async (kind: AgentRunKind) => {
    setPending(kind);
    setError(null);
    const result = await startAgentRun({
      owner,
      name: repo,
      storyId,
      kind,
      model: models[kind],
      fixFindings,
    });
    if (result.success) {
      setRuns((prev) => [result.data, ...prev]);
    } else {
      setError(result.error);
    }
    setPending(null);
  };

  return (
    <Card className="glass-card">
      <CardContent className="p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Bot className="size-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Agents
          </h4>
          {modelAdvice && <ModelBadge advice={modelAdvice} compact />}
        </div>

        {unavailableReason ? (
          <p className="text-sm text-muted-foreground">{unavailableReason}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-4">
              {actions.map(({ kind, label }) => (
                <div key={kind} className="flex items-center gap-2">
                  <Select
                    value={models[kind]}
                    onValueChange={(value) =>
                      setModels((prev) => ({ ...prev, [kind]: value as ModelTier }))
                    }
                    disabled={pending !== null}
                  >
                    <SelectTrigger className="w-28" aria-label={`Model for ${label.toLowerCase()}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_TIERS.map((tier) => (
                        <SelectItem key={tier} value={tier} className="capitalize">
                          {tier}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button onClick={() => void start(kind)} disabled={pending !== null}>
                    {pending === kind && <Loader2 className="animate-spin" />}
                    {label}
                  </Button>
                </div>
              ))}
              {kinds.includes("review") && (
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={fixFindings}
                    onCheckedChange={(checked) => setFixFindings(checked === true)}
                  />
                  Review fixes its findings
                </label>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            {runs.length > 0 ? (
              <ul className="space-y-2">
                {runs.map((run) => (
                  <li key={run.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <RunStatusBadge status={run.status} />
                    <Link
                      href={`/repo/${owner}/${repo}/runs/${run.id}`}
                      className="font-medium hover:underline"
                    >
                      {AGENT_RUN_LABELS[run.kind]} · {run.model}
                    </Link>
                    <span className="text-muted-foreground">
                      {new Date(run.startedAt).toLocaleString()}
                      {run.costUsd !== null && ` · $${run.costUsd.toFixed(2)}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No agent runs for this story yet.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
