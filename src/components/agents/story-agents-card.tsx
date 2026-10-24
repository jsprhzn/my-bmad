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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelBadge } from "@/components/shared/model-badge";
import { RunStatusBadge } from "./run-status-badge";
import { listAgentRuns, startAgentRun } from "@/actions/agent-actions";
import {
  AGENT_RUN_LABELS,
  MODEL_TIERS,
  recommendModel,
  runKindsFor,
  type AgentRunKind,
} from "@/lib/agents/models";
import {
  defaultSkillFor,
  skillsForAction,
  type ProjectSkill,
} from "@/lib/agents/action-skills";
import type { AgentRun } from "@/lib/agents/run-store";
import type { ModelTier, StoryModelAdvice, StoryStatus } from "@/lib/bmad/types";

const POLL_MS = 5000;

const ACTIONS: { kind: AgentRunKind; label: string; button: string }[] = [
  { kind: "plan", label: "Plan", button: "Plan" },
  { kind: "dev", label: "Dev", button: "Start dev" },
  { kind: "review", label: "Review", button: "Start review" },
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
  /** Claude accounts to run as (AGENT_CLAUDE_ACCOUNTS); a choice shows when there are several. */
  accounts: string[];
  /** Skills and BMAD agents installed in the project folder. */
  skills: ProjectSkill[];
}

function SkillLabel({ skill }: { skill: ProjectSkill }) {
  return (
    <>
      /{skill.name}
      {skill.persona && <span className="ml-1 text-xs text-muted-foreground">agent</span>}
    </>
  );
}

/** Start a plan, dev or review run with a chosen skill and model, and follow the story's runs. */
export function StoryAgentsCard({
  owner,
  repo,
  storyId,
  storyStatus,
  modelAdvice,
  unavailableReason,
  initialRuns,
  accounts,
  skills,
}: StoryAgentsCardProps) {
  const recommendations = {
    plan: recommendModel("plan", modelAdvice),
    dev: recommendModel("dev", modelAdvice),
    review: recommendModel("review", modelAdvice),
  };
  const [models, setModels] = useState<Record<AgentRunKind, ModelTier>>({
    plan: recommendations.plan.model,
    dev: recommendations.dev.model,
    review: recommendations.review.model,
  });
  const [chosenSkills, setChosenSkills] = useState<Record<AgentRunKind, string | null>>({
    plan: defaultSkillFor("plan", skills),
    dev: defaultSkillFor("dev", skills),
    review: defaultSkillFor("review", skills),
  });
  const [fixFindings, setFixFindings] = useState(true);
  const [account, setAccount] = useState<string | undefined>(accounts[0]);
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
    const skill = chosenSkills[kind];
    if (!skill) return;
    setPending(kind);
    setError(null);
    const result = await startAgentRun({
      owner,
      name: repo,
      storyId,
      kind,
      skill,
      model: models[kind],
      fixFindings,
      account,
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
          {!unavailableReason && accounts.length > 1 && (
            <Select value={account} onValueChange={setAccount} disabled={pending !== null}>
              <SelectTrigger className="ml-auto w-36" aria-label="Claude account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {unavailableReason ? (
          <p className="text-sm text-muted-foreground">{unavailableReason}</p>
        ) : (
          <>
            <div className="space-y-4">
              {actions.map(({ kind, label, button }) => {
                const { suggested, other } = skillsForAction(kind, skills);
                const skill = skills.find((s) => s.name === chosenSkills[kind]);
                return (
                  <div key={kind} className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-16 text-sm font-medium">{label}</span>
                      <Select
                        value={chosenSkills[kind] ?? undefined}
                        onValueChange={(value) =>
                          setChosenSkills((prev) => ({ ...prev, [kind]: value }))
                        }
                        disabled={pending !== null || skills.length === 0}
                      >
                        <SelectTrigger className="w-64" aria-label={`Skill for ${label.toLowerCase()}`}>
                          <SelectValue placeholder="No skill installed" />
                        </SelectTrigger>
                        <SelectContent>
                          {suggested.length > 0 && (
                            <SelectGroup>
                              <SelectLabel>Suggested for {label.toLowerCase()}</SelectLabel>
                              {suggested.map((s) => (
                                <SelectItem key={s.name} value={s.name}>
                                  <SkillLabel skill={s} />
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          )}
                          {other.length > 0 && (
                            <SelectGroup>
                              <SelectLabel>Other installed skills</SelectLabel>
                              {other.map((s) => (
                                <SelectItem key={s.name} value={s.name}>
                                  <SkillLabel skill={s} />
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          )}
                        </SelectContent>
                      </Select>
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
                      <Button
                        onClick={() => void start(kind)}
                        disabled={pending !== null || !chosenSkills[kind]}
                      >
                        {pending === kind && <Loader2 className="animate-spin" />}
                        {button}
                      </Button>
                    </div>
                    <p className="pl-18 text-xs text-muted-foreground">
                      Recommended model: {recommendations[kind].model} ({recommendations[kind].source})
                      {skill?.description && (
                        <>
                          <br />/{skill.name}: {skill.description}
                        </>
                      )}
                    </p>
                    {kind === "review" && (
                      <label className="flex items-center gap-2 pl-18 text-sm text-muted-foreground">
                        <Checkbox
                          checked={fixFindings}
                          onCheckedChange={(checked) => setFixFindings(checked === true)}
                        />
                        Review fixes its findings
                      </label>
                    )}
                  </div>
                );
              })}
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
                      {AGENT_RUN_LABELS[run.kind]}
                      {run.skill && ` · /${run.skill}`} · {run.model}
                      {run.account && accounts.length > 1 && ` · ${run.account}`}
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
