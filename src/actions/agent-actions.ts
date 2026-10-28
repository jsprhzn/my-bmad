"use server";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
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
  isAlive,
  listRuns,
  readRunStream,
  setRunPaused,
  startRun,
  stopRun,
  type AgentRun,
} from "@/lib/agents/run-store";
import { readQuota, type Quota } from "@/lib/agents/quota";
import {
  autorunnerFile,
  listAutorunners,
  readAutorunner,
  writeAutorunner,
  type AutorunnerState,
} from "@/lib/agents/autorunner-queue";
import {
  logTail,
  type LogLine,
  reachedStages,
  stagesOf,
  type StageView,
} from "@/lib/agents/run-stages";
import { runChanges, runFileDiff, type RunChanges } from "@/lib/agents/run-changes";
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
  /** Leave out the running runs an autorunner queue shows itself. */
  withoutAutorun: z.boolean().optional(),
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

    // A run uses the account chosen for it, else the project's account, else the first one.
    const requestedAccount = parsed.data.account ?? repo?.agentAccount ?? undefined;
    const account = findClaudeAccount(requestedAccount);
    if (requestedAccount && !account) {
      return { success: false, error: "Unknown Claude account", code: "VALIDATION_ERROR" };
    }

    const model =
      (parsed.data.model as AgentRun["model"] | undefined) ??
      recommendedModel(kind, story.modelAdvice);
    // One at a time waits for every agent of the project that is running now, not only this story's.
    const waitForPids = repo?.agentOneAtATime
      ? (await listRuns({ repoKey, userId }))
          .filter((r) => r.status === "running" && r.pid)
          .map((r) => r.pid as number)
      : [];
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
      permissionMode: repo?.agentAutorunner ? "auto" : "bypassPermissions",
      waitForPids,
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
    if (!parsed.data.withoutAutorun) return { success: true, data: runs };
    const queued = new Set(
      (await listAutorunners(access.data.repoKey, access.data.userId)).flatMap((state) =>
        state.active.map((story) => story.runId),
      ),
    );
    return {
      success: true,
      data: runs.filter((run) => !(run.status === "running" && queued.has(run.id))),
    };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

const projectAccountSchema = repoSchema.extend({
  account: z.string().min(1).max(40).nullable(),
});

/** Save which Claude account this project's agent runs use; null resets to the first one. */
export async function setProjectAgentAccount(
  input: z.infer<typeof projectAccountSchema>,
): Promise<ActionResult<{ account: string | null }>> {
  const parsed = projectAccountSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  const { account } = parsed.data;
  if (account !== null && !findClaudeAccount(account)) {
    return { success: false, error: "Unknown Claude account", code: "VALIDATION_ERROR" };
  }
  try {
    await prisma.repo.updateMany({
      where: { userId: access.data.userId, owner: parsed.data.owner, name: parsed.data.name },
      data: { agentAccount: account },
    });
    revalidatePath(`/repo/${parsed.data.owner}/${parsed.data.name}`);
    return { success: true, data: { account } };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "DB_ERROR"), code: "DB_ERROR" };
  }
}

const agentSettingsSchema = repoSchema.extend({
  autorunner: z.boolean(),
  oneAtATime: z.boolean(),
});

/** Save the project's agent settings: auto mode for its runs, and whether they wait for each other. */
export async function setProjectAgentSettings(
  input: z.infer<typeof agentSettingsSchema>,
): Promise<ActionResult<{ autorunner: boolean; oneAtATime: boolean }>> {
  const parsed = agentSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  const { autorunner, oneAtATime } = parsed.data;
  try {
    await prisma.repo.updateMany({
      where: { userId: access.data.userId, owner: parsed.data.owner, name: parsed.data.name },
      data: { agentAutorunner: autorunner, agentOneAtATime: oneAtATime },
    });
    revalidatePath(`/repo/${parsed.data.owner}/${parsed.data.name}`);
    return { success: true, data: { autorunner, oneAtATime } };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "DB_ERROR"), code: "DB_ERROR" };
  }
}

/** Stories with a run that is still running, with the run to open for each, so the overview can show them as active. */
export async function listRunningStoryIds(
  input: z.infer<typeof repoSchema>,
): Promise<ActionResult<{ storyId: string; runId: string }[]>> {
  const parsed = repoSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const runs = await listRuns({ repoKey: access.data.repoKey, userId: access.data.userId });
    const byStory = new Map<string, string>();
    for (const run of runs) {
      if (run.status === "running" && !byStory.has(run.storyId)) {
        byStory.set(run.storyId, run.id);
      }
    }
    const data = [...byStory].map(([storyId, runId]) => ({ storyId, runId }));
    return { success: true, data };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

const replySchema = runSchema.extend({
  answer: z.string().trim().min(1).max(4000),
});

/** Answer a finished run: a new run that resumes the same Claude session with the answer. */
export async function replyAgentRun(
  input: z.infer<typeof replySchema>,
): Promise<ActionResult<AgentRun>> {
  const parsed = replySchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const found = await getRun(parsed.data.runId, access.data);
    if (!found) return { success: false, error: "Run not found", code: "NOT_FOUND" };
    const { run, sessionId } = found;
    if (run.status === "running") {
      return {
        success: false,
        error: "Wait until the run has finished before answering.",
        code: "ALREADY_RUNNING",
      };
    }
    if (!sessionId) {
      return { success: false, error: "This run has no session to answer in.", code: "NO_SESSION" };
    }
    const account = findClaudeAccount(run.account ?? undefined) ?? null;
    if (run.account && !account) {
      return { success: false, error: "Unknown Claude account", code: "VALIDATION_ERROR" };
    }
    const reply = await startRun({
      repoKey: access.data.repoKey,
      userId: access.data.userId,
      localPath: access.data.localPath,
      storyId: run.storyId,
      storyTitle: run.storyTitle,
      kind: run.kind,
      skill: run.skill,
      model: run.model,
      account,
      permissionMode: run.permissionMode ?? "bypassPermissions",
      prompt: parsed.data.answer,
      resumeSessionId: sessionId,
      parentRunId: run.id,
    });
    return { success: true, data: reply };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

export async function getAgentRun(
  input: z.infer<typeof runSchema>,
): Promise<ActionResult<{ run: AgentRun; log: string; prompt: string; sessionId: string | null }>> {
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

/** The files a run changed on its branch, and whether the run is still going. */
export async function getAgentRunChanges(
  input: z.infer<typeof runSchema>,
): Promise<ActionResult<RunChanges & { branch: string | null; baseBranch: string | null; running: boolean }>> {
  const parsed = runSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const found = await getRun(parsed.data.runId, access.data);
    if (!found) return { success: false, error: "Run not found", code: "NOT_FOUND" };
    const { run } = found;
    const changes = await runChanges({
      checkout: access.data.localPath,
      branch: run.branch,
      baseBranch: run.baseBranch,
    });
    return {
      success: true,
      data: {
        ...changes,
        branch: run.branch ?? null,
        baseBranch: run.baseBranch ?? null,
        running: run.status === "running",
      },
    };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

const IMPLEMENTATION_DIR = "_bmad-output/implementation-artifacts";

/**
 * The markdown artifacts of one story in the project's implementation folder:
 * its spec and its build result. Story "11.1" has the files "spec-11-1-…".
 */
export async function getStoryArtifacts(input: {
  owner: string;
  name: string;
  storyNumber: string;
}): Promise<ActionResult<string[]>> {
  const parsed = z
    .object({
      owner: z.string().min(1),
      name: z.string().min(1),
      storyNumber: z.string().regex(/^\d+[.\da-z]*$/),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  const key = parsed.data.storyNumber.replace(/\./g, "-");
  const prefixes = [`spec-${key}-`, `bmad-build-auto-result-${key}-`];
  try {
    const dir = path.join(access.data.localPath, IMPLEMENTATION_DIR);
    const names = existsSync(dir) ? await readdir(dir) : [];
    const files = names
      .filter((name) => name.endsWith(".md") && prefixes.some((prefix) => name.startsWith(prefix)))
      .sort()
      .map((name) => `${IMPLEMENTATION_DIR}/${name}`);
    return { success: true, data: files };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

/** The diff of one file the run changed on its branch. */
export async function getAgentRunFileDiff(
  input: z.infer<typeof runSchema> & { path: string },
): Promise<ActionResult<string | null>> {
  const parsed = runSchema.extend({ path: z.string().min(1).max(1024) }).safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const found = await getRun(parsed.data.runId, access.data);
    if (!found) return { success: false, error: "Run not found", code: "NOT_FOUND" };
    const { run } = found;
    if (!run.branch) return { success: true, data: null };
    const diff = await runFileDiff({
      checkout: access.data.localPath,
      branch: run.branch,
      baseBranch: run.baseBranch,
      path: parsed.data.path,
    });
    return { success: true, data: diff };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

/** Pause a running agent, or resume a paused one. */
export async function setAgentRunPaused(
  input: z.infer<typeof runSchema> & { paused: boolean },
): Promise<ActionResult<AgentRun>> {
  const parsed = runSchema.extend({ paused: z.boolean() }).safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const run = await setRunPaused(parsed.data.runId, access.data, parsed.data.paused);
    if (!run) return { success: false, error: "Run not found", code: "NOT_FOUND" };
    return { success: true, data: run };
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

const autorunnerStartSchema = repoSchema.extend({
  mode: z.enum(["serial", "parallel"]),
  review: z.boolean(),
});

/** The queue's state as the page shows it: whether its driver is still alive. */
/** A story the queue is working on now: its stages, models and the last lines of its run. */
export interface AutorunnerStoryView {
  key: string;
  number: string;
  title: string;
  phase: "build" | "review";
  runId: string;
  /** The run whose changes the story shows: the build's own branch, also during its review. */
  changesRunId: string;
  paused: boolean;
  branch: string | null;
  startedAt: string;
  stages: StageView[];
  /** Whether the story's run is still going: its last line is then the one in progress. */
  running: boolean;
  logTail: LogLine[];
}

export interface AutorunnerView extends Omit<AutorunnerState, "userId" | "localPath" | "runIds"> {
  driverAlive: boolean;
  /** Runs the queue started, and their totals so far. */
  runCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** The stories in progress; only filled for a running queue. */
  stories: AutorunnerStoryView[];
}

/** The queue as the page shows it; the totals come from the runs it started. */
function viewOf(state: AutorunnerState, runs: AgentRun[]): AutorunnerView {
  const view: Partial<AutorunnerState> = { ...state };
  delete view.userId;
  delete view.localPath;
  delete view.runIds;
  const mine = runs.filter((r) => state.runIds.includes(r.id));
  const sum = (pick: (r: AgentRun) => number | null | undefined) =>
    mine.reduce((total, r) => total + (pick(r) ?? 0), 0);
  return {
    ...(view as Omit<AutorunnerState, "userId" | "localPath" | "runIds">),
    driverAlive: isAlive(state.driverPid),
    runCount: mine.length,
    costUsd: sum((r) => r.costUsd),
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    stories: [],
  };
}

function titleOf(key: string): string {
  const words = key.replace(/^\d+-\d+[a-z]?-/, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The stories the queue has in progress, with their stages read from the runs. Newest runs first in `runs`. */
async function storyViewsOf(state: AutorunnerState, runs: AgentRun[]): Promise<AutorunnerStoryView[]> {
  return Promise.all(
    state.active.map(async (story): Promise<AutorunnerStoryView> => {
      const run = runs.find((r) => r.id === story.runId);
      const stream = await readRunStream(story.runId);
      const reached = story.phase === "review" ? [] : reachedStages(stream);
      const forStory = runs.filter((r) => r.storyId === story.number);
      const latest = (kind: AgentRun["kind"]) => forStory.find((r) => r.kind === kind);
      const build = latest("dev");
      const review = latest("review");
      const brainstorm = latest("brainstorm");
      const plan = latest("plan");
      const running = run?.status === "running";
      const current = !running
        ? null
        : story.phase === "review"
          ? "review"
          : (reached.at(-1) ?? "build");
      // A review works in the checkout, so the story's changes are on the build run's branch.
      const changes =
        story.phase === "review" && story.buildRunId
          ? (runs.find((r) => r.id === story.buildRunId) ?? run)
          : run;
      return {
        key: story.key,
        number: story.number,
        title: titleOf(story.key),
        phase: story.phase,
        runId: story.runId,
        changesRunId: changes?.id ?? story.runId,
        paused: run?.paused ?? false,
        branch: changes?.branch ?? null,
        startedAt: run?.startedAt ?? state.startedAt,
        stages: stagesOf({
          current,
          reached,
          buildDone: story.phase === "review",
          models: {
            brainstorm: brainstorm?.model ?? story.models?.brainstorm,
            plan: plan?.model ?? story.models?.plan,
            build: build?.model ?? story.models?.dev,
            review: review?.model ?? story.models?.review,
          },
          hasBrainstorm: Boolean(brainstorm),
          hasPlan: Boolean(plan),
        }),
        running,
        logTail: logTail(stream, 3),
      };
    }),
  );
}

/** Start the autorunner for the project: it takes open stories one by one, or a few at once, in auto mode. */
export async function startAutorunner(
  input: z.infer<typeof autorunnerStartSchema>,
): Promise<ActionResult<AutorunnerView>> {
  const parsed = autorunnerStartSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  const { userId, repoKey, localPath } = access.data;
  try {
    const existing = await listAutorunners(repoKey, userId);
    if (existing.some((s) => s.status === "running")) {
      return { success: false, error: "The autorunner is already running.", code: "ALREADY_RUNNING" };
    }
    const repo = await getAuthenticatedRepoConfig(userId, parsed.data.owner, parsed.data.name);
    const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const file = autorunnerFile(id);
    const state: AutorunnerState = {
      id,
      repoKey,
      userId,
      localPath,
      account: repo?.agentAccount ?? null,
      mode: parsed.data.mode,
      review: parsed.data.review,
      status: "running",
      stopRequested: false,
      failed: false,
      driverPid: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      active: [],
      waiting: [],
      done: [],
      skipped: [],
      runIds: [],
      note: null,
    };
    await writeAutorunner(file, state);
    // Detached, so it keeps running when this request ends or MyBMAD restarts.
    const child = spawn(
      path.join(process.cwd(), "node_modules", ".bin", "tsx"),
      [path.join(process.cwd(), "scripts", "autorunner.ts"), file],
      { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env },
    );
    child.unref();
    const started = { ...state, driverPid: child.pid ?? null };
    await writeAutorunner(file, started);
    revalidatePath(`/repo/${parsed.data.owner}/${parsed.data.name}`);
    return { success: true, data: viewOf(started, []) };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

/** Ask the autorunner to stop: stories already running finish, no new one starts. */
export async function stopAutorunner(
  input: z.infer<typeof repoSchema> & { id: string; now?: boolean },
): Promise<ActionResult<AutorunnerView>> {
  const parsed = repoSchema
    .extend({ id: z.string().regex(/^\d{13}-[0-9a-f]{8}$/), now: z.boolean().optional() })
    .safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const file = autorunnerFile(parsed.data.id);
    const state = await readAutorunner(file);
    if (!state || state.repoKey !== access.data.repoKey || state.userId !== access.data.userId) {
      return { success: false, error: "Autorunner not found", code: "NOT_FOUND" };
    }
    // "Stop nu" also ends the stories that are running; the driver then sees them cancelled.
    if (parsed.data.now) {
      for (const story of state.active) {
        await stopRun(story.runId, access.data);
      }
    }
    const updated = { ...state, stopRequested: true };
    await writeAutorunner(file, updated);
    const runs = await listRuns({ repoKey: state.repoKey, userId: state.userId });
    return { success: true, data: viewOf(updated, runs) };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

/** Pause or resume every run the queue has in progress. */
export async function setAutorunnerPaused(
  input: z.infer<typeof repoSchema> & { id: string; paused: boolean },
): Promise<ActionResult<void>> {
  const parsed = repoSchema
    .extend({ id: z.string().regex(/^\d{13}-[0-9a-f]{8}$/), paused: z.boolean() })
    .safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const state = await readAutorunner(autorunnerFile(parsed.data.id));
    if (!state || state.repoKey !== access.data.repoKey || state.userId !== access.data.userId) {
      return { success: false, error: "Autorunner not found", code: "NOT_FOUND" };
    }
    for (const story of state.active) {
      await setRunPaused(story.runId, access.data, parsed.data.paused);
    }
    return { success: true, data: undefined };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

/** The project's autorunner queues, newest first. */
export async function listAutorunnerViews(
  input: z.infer<typeof repoSchema>,
): Promise<ActionResult<AutorunnerView[]>> {
  const parsed = repoSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const states = await listAutorunners(access.data.repoKey, access.data.userId);
    const runs = await listRuns({ repoKey: access.data.repoKey, userId: access.data.userId });
    const views = await Promise.all(
      states.slice(0, 5).map(async (state) => {
        const view = viewOf(state, runs);
        if (state.status === "running") view.stories = await storyViewsOf(state, runs);
        return view;
      }),
    );
    return { success: true, data: views };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}

/** The plan limit of the project's Claude account: the session and the week, as Claude Code reports them. */
export async function getAgentUsage(
  input: z.infer<typeof repoSchema>,
): Promise<ActionResult<Quota | null>> {
  const parsed = repoSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid data", code: "VALIDATION_ERROR" };
  }
  const access = await requireAgentProject(parsed.data.owner, parsed.data.name);
  if (!access.success) return access;
  try {
    const repo = await getAuthenticatedRepoConfig(access.data.userId, parsed.data.owner, parsed.data.name);
    const account = findClaudeAccount(repo?.agentAccount ?? undefined);
    return { success: true, data: await readQuota(account?.configDir) };
  } catch (error) {
    return { success: false, error: sanitizeError(error, "AGENT_ERROR"), code: "AGENT_ERROR" };
  }
}
