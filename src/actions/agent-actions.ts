"use server";

import { existsSync } from "node:fs";
import { z } from "zod";
import { getCachedBmadProject } from "@/lib/bmad/cached-project";
import {
  getAuthenticatedRepoConfig,
  getAuthenticatedSession,
} from "@/lib/db/helpers";
import { sanitizeError } from "@/lib/errors";
import {
  AGENT_RUN_LABELS,
  MODEL_TIERS,
  recommendedModel,
  runsConflict,
} from "@/lib/agents/models";
import { buildAgentPrompt } from "@/lib/agents/prompts";
import { findClaudeAccount } from "@/lib/agents/accounts";
import { defaultSkillFor } from "@/lib/agents/action-skills";
import { listProjectSkills } from "@/lib/agents/project-skills";
import {
  agentRunsEnabled,
  getRun,
  listRuns,
  startRun,
  stopRun,
  type AgentRun,
} from "@/lib/agents/run-store";
import type { ActionResult } from "@/lib/types";

const repoSchema = z.object({
  owner: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
});

const startSchema = repoSchema.extend({
  storyId: z.string().min(1).max(50),
  kind: z.enum(["brainstorm", "plan", "dev", "review"]),
  model: z.enum(MODEL_TIERS as [string, ...string[]]).optional(),
  fixFindings: z.boolean().optional(),
  account: z.string().min(1).max(40).optional(),
  skill: z.string().regex(/^[\w.:-]{1,80}$/).optional(),
});

const runSchema = repoSchema.extend({
  runId: z.string().regex(/^\d{13}-[0-9a-f]{8}$/),
});

const listSchema = repoSchema.extend({
  storyId: z.string().min(1).max(50).optional(),
});

/**
 * The signed-in user's local project. Agent runs need ENABLE_AGENT_RUNS and a
 * project imported from a local folder: the agent works in that folder.
 */
async function requireAgentProject(
  owner: string,
  name: string,
): Promise<ActionResult<{ userId: string; repoKey: string; localPath: string }>> {
  if (!agentRunsEnabled()) {
    return {
      success: false,
      error: "Agent runs are disabled. Set ENABLE_AGENT_RUNS=true and restart MyBMAD.",
      code: "AGENTS_DISABLED",
    };
  }
  const session = await getAuthenticatedSession();
  if (!session) {
    return { success: false, error: "Not authenticated", code: "UNAUTHORIZED" };
  }
  const repo = await getAuthenticatedRepoConfig(session.userId, owner, name);
  if (!repo) {
    return { success: false, error: "Project not found", code: "NOT_FOUND" };
  }
  if (repo.sourceType !== "local" || !repo.localPath || !existsSync(repo.localPath)) {
    return {
      success: false,
      error: "Agents can only run for projects imported from a local folder.",
      code: "NOT_LOCAL",
    };
  }
  return {
    success: true,
    data: { userId: session.userId, repoKey: `${owner}/${name}`, localPath: repo.localPath },
  };
}

export async function startAgentRun(
  input: z.infer<typeof startSchema>,
): Promise<ActionResult<AgentRun>> {
  const parsed = startSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const { owner, name, storyId, kind, fixFindings } = parsed.data;

  const access = await requireAgentProject(owner, name);
  if (!access.success) return access;
  const { userId, repoKey, localPath } = access.data;

  try {
    const repo = await getAuthenticatedRepoConfig(userId, owner, name);
    const project = repo ? await getCachedBmadProject(repo, undefined, userId) : null;
    const story = project?.stories.find((s) => s.id === storyId);
    if (!story) {
      return { success: false, error: "Story not found", code: "NOT_FOUND" };
    }

    const runs = await listRuns({ repoKey, userId, storyId });
    const conflict = runs.find((r) => r.status === "running" && runsConflict(r.kind, kind));
    if (conflict) {
      return {
        success: false,
        error: `A ${AGENT_RUN_LABELS[conflict.kind].toLowerCase()} run is already running for story ${storyId}.`,
        code: "ALREADY_RUNNING",
      };
    }

    const installed = await listProjectSkills(localPath);
    const skill = parsed.data.skill ?? defaultSkillFor(kind, installed);
    if (!skill) {
      return {
        success: false,
        error: `This project has no skill installed for ${AGENT_RUN_LABELS[kind].toLowerCase()}.`,
        code: "NO_SKILL",
      };
    }
    if (!installed.some((s) => s.name === skill)) {
      return {
        success: false,
        error: `Skill ${skill} is not installed in this project.`,
        code: "VALIDATION_ERROR",
      };
    }

    const account = findClaudeAccount(parsed.data.account);
    if (parsed.data.account && !account) {
      return { success: false, error: "Unknown Claude account", code: "VALIDATION_ERROR" };
    }

    const model =
      (parsed.data.model as AgentRun["model"] | undefined) ??
      recommendedModel(kind, story.modelAdvice);
    const run = await startRun({
      repoKey,
      userId,
      localPath,
      storyId,
      storyTitle: story.title,
      kind,
      skill,
      model,
      account,
      prompt: buildAgentPrompt({
        kind,
        skill,
        storyId,
        storyTitle: story.title,
        sourcePaths: story.sourcePaths ?? [],
        fixFindings: fixFindings ?? true,
      }),
    });
    return { success: true, data: run };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

export async function listAgentRuns(
  input: z.infer<typeof listSchema>,
): Promise<ActionResult<AgentRun[]>> {
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const runs = await listRuns({
      repoKey: access.data.repoKey,
      userId: access.data.userId,
      storyId: parsed.data.storyId,
    });
    return { success: true, data: runs };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

/** Stories with a run that is still running, so the overview can show them as active. */
export async function listRunningStoryIds(
  input: z.infer<typeof repoSchema>,
): Promise<ActionResult<string[]>> {
  const parsed = repoSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const runs = await listRuns({ repoKey: access.data.repoKey, userId: access.data.userId });
    const ids = [...new Set(runs.filter((r) => r.status === "running").map((r) => r.storyId))];
    return { success: true, data: ids };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

export async function getAgentRun(
  input: z.infer<typeof runSchema>,
): Promise<ActionResult<{ run: AgentRun; log: string; prompt: string }>> {
  const parsed = runSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const found = await getRun(parsed.data.runId, access.data);
    if (!found) return { success: false, error: "Run not found", code: "NOT_FOUND" };
    return { success: true, data: found };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

export async function stopAgentRun(
  input: z.infer<typeof runSchema>,
): Promise<ActionResult<AgentRun>> {
  const parsed = runSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const run = await stopRun(parsed.data.runId, access.data);
    if (!run) return { success: false, error: "Run not found", code: "NOT_FOUND" };
    return { success: true, data: run };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}
