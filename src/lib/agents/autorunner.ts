import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseModelAdvice } from "../bmad/parse-model-advice";
import { parseStoryDependencies, type StoryGraph } from "../bmad/story-graph";
import type { ModelAdviceRow, ModelTier } from "../bmad/types";
import { defaultSkillFor } from "./action-skills";
import { findClaudeAccount, type ClaudeAccount } from "./accounts";
import {
  MAX_ATTEMPTS,
  MAX_PARALLEL,
  awaitsReview,
  canStart,
  decisionNote,
  failedBuildStories,
  nextStories,
  readAutorunner,
  readSprintStories,
  retryAt,
  planRepairs,
  repairPrompt,
  retryFirst,
  isTemporaryLimit,
  writeAutorunner,
  type ActiveStory,
  type AutorunnerState,
  type Problem,
  type Phase,
  type QueueStory,
  type WaitingStory,
} from "./autorunner-queue";
import { buildAgentPrompt } from "./prompts";
import { listProjectSkills } from "./project-skills";
import { recommendedModel, type AgentRunKind } from "./models";
import type { PlannedModels } from "./run-stages";
import { LARGE_COMPLEXITY } from "./story-path";
import { listRuns, runsDir, startRun, type AgentRun, type HeldBranch } from "./run-store";
import { allowanceFor, quotaLoad, readQuota } from "./quota";

const TICK_MS = 15_000;
const IMPLEMENTATION = "_bmad-output/implementation-artifacts";

/**
 * Drives one autorunner queue until it is done, stopped or failed. Started
 * detached (scripts/autorunner.ts), so it keeps going when the browser closes.
 */
export async function runAutorunner(file: string): Promise<void> {
  const boot = await readAutorunner(file);
  if (!boot) throw new Error(`No autorunner state at ${file}`);
  const skills = await listProjectSkills(boot.localPath);
  const buildSkill = defaultSkillFor("dev", skills);
  const reviewSkill = defaultSkillFor("review", skills);
  if (!buildSkill || !reviewSkill) {
    await finish(file, {
      status: "failed",
      failed: true,
      note: "The project has no build or review skill installed.",
    });
    return;
  }
  // A split runs as a plan run; without a plan skill the build skill still carries the run.
  const splitSkill = defaultSkillFor("plan", skills) ?? buildSkill;
  const account = findClaudeAccount(boot.account ?? undefined);
  if (boot.account && !account) {
    await finish(file, { status: "failed", failed: true, note: `Unknown Claude account ${boot.account}.` });
    return;
  }

  for (;;) {
    const state = await readAutorunner(file);
    if (!state) return;
    let project = await readProject(state.localPath);
    const runs = await listRuns({ repoKey: state.repoKey, userId: state.userId });
    const runById = new Map(runs.map((r) => [r.id, r]));
    const failedIds = failedBuildStories(runs);
    const now = new Date();
    // Runs this tick starts; saved with the state so the queue can total their tokens and cost.
    const started: string[] = [];

    // 1. Settle the runs that ended.
    const active: ActiveStory[] = [];
    // Every waiting entry stays: the ones whose time has come start below, when a slot is free.
    const waiting: WaitingStory[] = [...state.waiting];
    let failure: string | null = null;
    // What went wrong, per story. An AI repairs it when it can; the queue stops when it cannot.
    const problems: Problem[] = [];
    const report = (
      story: Pick<ActiveStory, "number" | "key" | "phase">,
      run: AgentRun,
      message: string,
      repairable = true,
    ) =>
      problems.push({
        number: story.number,
        key: story.key,
        phase: story.phase,
        message: `${story.key}: ${message}`,
        failedRunId: run.id,
        // A repair that went wrong itself is not repaired again.
        repairable: repairable && story.phase !== "repair",
      });
    for (const story of state.active) {
      const run = runById.get(story.runId);
      if (!run || run.status === "running") {
        active.push(story);
        continue;
      }
      // Stopped on purpose ("Stop now"): neither done nor a failure.
      // Stopped by hand: the queue does not take the story up again.
      if (run.status === "cancelled") {
        if (!state.skipped.includes(story.number)) state.skipped.push(story.number);
        continue;
      }
      if (run.status === "completed") {
        if (story.phase === "repair") {
          // The story is picked up again from its sprint status: built, reviewed or left as done.
          if (project.statusOf.get(story.number) === "blocked") report(story, run, "still blocked after the repair.", false);
          continue;
        }
        if (story.phase === "build" && run.held) {
          // The build's branch is kept: its review works on it and merges it, which sets the sprint status.
          const held = heldBranch(run);
          if (!held) {
            report(story, run, "the build has no branch to review.");
            continue;
          }
          if (await buildBlocked(run, story)) {
            report(story, run, "the build is blocked.");
            continue;
          }
          const runId = await startStoryRun(started, state, account, "review", story, project, reviewSkill, {
            reuse: held,
          });
          active.push({ ...story, phase: "review", runId, buildRunId: run.id });
          continue;
        }
        if (story.phase === "split") {
          // The split merged into the checkout: re-read the backlog so its subtasks can start this tick.
          // A story left unsplit is not split again; it is built as it is.
          project = await readProject(state.localPath);
          continue;
        }
        if (story.phase === "build") {
          const sprint = project.statusOf.get(story.number) ?? "unknown";
          if (sprint === "blocked" || (sprint !== "review" && sprint !== "done")) {
            report(story, run, `sprint-status says "${sprint}" after the build.`);
            continue;
          }
          if (state.review) {
            const runId = await startStoryRun(started, state, account, "review", story, project, reviewSkill);
            active.push({ ...story, phase: "review", runId });
            continue;
          }
        }
        if (story.leftInReview && (project.statusOf.get(story.number) ?? "unknown") !== "done") {
          report(story, run, `sprint-status says "${project.statusOf.get(story.number) ?? "unknown"}" after the review.`);
          continue;
        }
        if (!state.done.includes(story.number)) state.done.push(story.number);
        continue;
      }
      // A limit that resets on its own: try the same step again later.
      const text = run.error ?? "";
      if (isTemporaryLimit(text)) {
        const attempts = (state.waiting.find((w) => w.number === story.number)?.attempts ?? 0) + 1;
        if (attempts > MAX_ATTEMPTS) {
          report(story, run, `still hitting the token limit after ${MAX_ATTEMPTS} tries.`, false);
          continue;
        }
        waiting.push({
          key: story.key,
          number: story.number,
          phase: story.phase,
          at: retryAt(text, now).toISOString(),
          attempts,
          buildRunId: story.buildRunId,
          runId: story.runId,
          leftInReview: story.leftInReview,
          repair: story.repair,
        });
        continue;
      }
      report(story, run, text.split("\n")[0] || "the run failed");
    }
    const plan = planRepairs({
      problems,
      repairs: state.repairs,
      stopRequested: state.stopRequested,
      waiting,
      now,
    });
    state.repairs = plan.repairs;
    waiting.push(...plan.queue);
    failure = plan.failure;

    // 2. Start what the slots allow: retries that are due first, then new stories.
    const stopping = state.stopRequested || failure !== null;
    // The plan's limit decides how many runs may be in flight.
    const load = quotaLoad(await readQuota(account?.configDir));
    const allowance = allowanceFor(load, state.mode === "serial" ? 1 : MAX_PARALLEL);
    const throttled = !stopping && allowance === 0;
    // The plan's limit holds back runs below the mode's full allowance.
    const limited = !stopping && !throttled && allowance < (state.mode === "serial" ? 1 : MAX_PARALLEL);
    const slots = allowance - active.length;
    const busy = new Set<string>([
      ...active.map((a) => a.number),
      ...waiting.map((w) => w.number),
      ...state.done,
      ...state.skipped,
      ...runs.filter((r) => r.status === "running").map((r) => r.storyId),
    ]);
    const due = waiting.filter((w) => Date.parse(w.at) <= now.getTime());
    let free = slots;
    if (!stopping) {
      for (const retry of due) {
        if (free <= 0) break;
        const story = project.stories.find((s) => s.number === retry.number);
        if (!story) continue;
        // A review retry goes on the held build's branch; without it there is nothing to review.
        const held = retry.phase === "review" && retry.buildRunId ? heldBranch(runById.get(retry.buildRunId)) : null;
        if (retry.phase === "review" && retry.buildRunId && !held) {
          failure = `${retry.key}: the build's branch is gone; the review cannot start again.`;
          continue;
        }
        const skill =
          retry.phase === "build" || retry.phase === "repair" ? buildSkill : retry.phase === "split" ? splitSkill : reviewSkill;
        const options: StartOptions = {
          hold: retry.phase === "build" && state.review,
          reuse: held,
          // A repair starts from the failure, and uses the stronger of the story's models.
          ...(retry.phase === "repair" && retry.repair
            ? {
                prompt: repairPrompt({
                  number: story.number,
                  key: story.key,
                  info: retry.repair,
                  runsDir: runsDir(),
                  attempt: state.repairs?.[story.number] ?? 1,
                }),
                model: recommendedModel("review", project.advice.get(story.number)),
              }
            : {}),
        };
        // A retry after a limit continues the same run; a new run only when that run has no session to continue.
        const start = (extra: { continueRunId?: string }) =>
          startStoryRun(started, state, account, retry.phase, story, project, skill, { ...options, ...extra });
        const runId = retry.runId
          ? await start({ continueRunId: retry.runId }).catch(() => start({}))
          : await start({});
        active.push({
          key: story.key,
          number: story.number,
          phase: retry.phase,
          runId,
          models: plannedModels(project.advice.get(story.number)),
          buildRunId: retry.buildRunId,
          leftInReview: retry.leftInReview,
          repair: retry.repair,
        });
        waiting.splice(waiting.findIndex((w) => w.number === retry.number), 1);
        busy.add(story.number);
        free -= 1;
      }
      // A story left in review, with no run on it, goes first: its dependents wait for it to be done.
      if (state.review) {
        const reviewable = nextStories({
          stories: project.stories,
          graph: project.graph,
          busy,
          slots: free,
          startable: awaitsReview,
        });
        for (const story of reviewable) {
          const runId = await startStoryRun(started, state, account, "review", story, project, reviewSkill);
          active.push({
            key: story.key,
            number: story.number,
            phase: "review",
            runId,
            models: plannedModels(project.advice.get(story.number)),
            leftInReview: true,
          });
          busy.add(story.number);
          free -= 1;
        }
      }
      // Stories whose build failed go before new ones; nextStories still skips any that are not open.
      const ordered = retryFirst(project.stories, failedIds);
      const fresh = nextStories({ stories: ordered, graph: project.graph, busy, slots: free });
      for (const story of fresh) {
        // A large story is split into subtasks first; the subtasks are built, not the story itself.
        const alreadySplit = state.split ?? [];
        if (
          state.splitLarge === true &&
          LARGE_COMPLEXITY.has(project.advice.get(story.number)?.complexity ?? "") &&
          !alreadySplit.includes(story.number)
        ) {
          state.split = [...alreadySplit, story.number];
          const runId = await startStoryRun(started, state, account, "split", story, project, splitSkill, {
            prompt: splitPrompt(story),
          });
          active.push({
            key: story.key,
            number: story.number,
            phase: "split",
            runId,
            models: plannedModels(project.advice.get(story.number)),
          });
          continue;
        }
        const runId = await startStoryRun(started, state, account, "build", story, project, buildSkill, {
          hold: state.review,
        });
        active.push({
          key: story.key,
          number: story.number,
          phase: "build",
          runId,
          models: plannedModels(project.advice.get(story.number)),
        });
      }
    }

    // 3. Save the state, or finish when nothing is left to do. Once stopping, pending retries are dropped.
    const failed = state.failed || failure !== null;
    const failNote = failure ?? (state.failed ? state.note : null);
    const pending = stopping ? [] : waiting;
    const openLeft = project.stories.filter((s) => canStart(s.status) || (state.review && awaitsReview(s.status)));
    const nextWait = Math.min(...pending.map((w) => Date.parse(w.at)));

    // Stories that wait on a dependency are not a reason to stop: someone may finish or merge that dependency
    // while the queue idles, and the Mac stays awake meanwhile. The queue ends when everything is done, on a
    // failure or on a stop request.
    const stillOpen = !stopping && openLeft.some((s) => !state.done.includes(s.number) && !state.skipped.includes(s.number));
    if (active.length === 0 && (stopping || pending.length === 0) && !stillOpen) {
      const status = failed ? "failed" : "stopped";
      await finish(file, {
        status: failed || state.stopRequested || openLeft.length > 0 ? status : "completed",
        note: failed
          ? failNote
          : state.stopRequested
            ? "Stopped."
            : openLeft.length === 0
              ? "All stories are done."
              : `${openLeft.length} stories are waiting on dependencies that are not done yet.`,
        active,
        waiting: pending,
        done: state.done,
        runIds: [...state.runIds, ...started],
      });
      return;
    }

    await writeAutorunner(file, {
      ...state,
      status: "running",
      failed,
      active,
      waiting: pending,
      done: state.done,
      runIds: [...state.runIds, ...started],
      note: decisionNote({
        failure: failNote,
        throttled,
        limited,
        load,
        allowance,
        mode: state.mode,
        active: active.map((a) => ({
          key: a.key,
          large: LARGE_COMPLEXITY.has(project.advice.get(a.number)?.complexity ?? ""),
          retry: failedIds.includes(a.number),
          repair: a.phase === "repair",
        })),
        openLeft: openLeft.length,
        waitingAt: pending.length > 0 ? new Date(nextWait).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : null,
      }),
      driverPid: process.pid,
    });
    await sleep(TICK_MS);
  }
}

interface Project {
  stories: QueueStory[];
  statusOf: Map<string, string>;
  graph: StoryGraph;
  advice: Map<string, ModelAdviceRow>;
}

async function readProject(localPath: string): Promise<Project> {
  const sprint = await readText(path.join(localPath, IMPLEMENTATION, "sprint-status.yaml"));
  const graphText = await readText(path.join(localPath, IMPLEMENTATION, "story-dependencies.yaml"));
  const adviceText = await readText(path.join(localPath, IMPLEMENTATION, "story-complexity.md"));
  const stories = readSprintStories(sprint);
  return {
    stories,
    statusOf: new Map(stories.map((s) => [s.number, s.status])),
    graph: parseStoryDependencies(graphText),
    advice: parseModelAdvice(adviceText),
  };
}

async function readText(file: string): Promise<string> {
  return existsSync(file) ? readFile(file, "utf8") : "";
}

/** A held build's branch, for the review that works on it. */
function heldBranch(run: AgentRun | undefined): HeldBranch | null {
  if (!run?.held || !run.branch) return null;
  return { runId: run.id, branch: run.branch, baseBranch: run.baseBranch ?? null };
}

/** Whether the build left its result as blocked, in its worktree. */
async function buildBlocked(run: AgentRun, story: Pick<QueueStory, "key">): Promise<boolean> {
  const result = path.join(runsDir(), `${run.id}.worktree`, IMPLEMENTATION, `bmad-build-auto-result-${story.key}.md`);
  return /^status: blocked/m.test(await readText(result));
}

/** What a run may be started with besides its phase. */
interface StartOptions {
  hold?: boolean;
  reuse?: HeldBranch | null;
  continueRunId?: string;
  prompt?: string;
  model?: ModelTier;
}

/** Start one build or review run for a story, in auto mode, and return its run id. */
async function startStoryRun(
  started: string[],
  state: AutorunnerState,
  account: ClaudeAccount | null,
  phase: Phase,
  story: Pick<QueueStory, "number" | "key">,
  project: Project,
  skill: string,
  options: StartOptions = {},
): Promise<string> {
  const kind: AgentRunKind = phase === "split" ? "plan" : phase === "build" || phase === "repair" ? "dev" : "review";
  const advice = project.advice.get(story.number);
  const sourcePath = path.join(IMPLEMENTATION, `spec-${story.key}.md`);
  const run = await startRun({
    repoKey: state.repoKey,
    userId: state.userId,
    localPath: state.localPath,
    storyId: story.number,
    storyTitle: titleFromKey(story.key),
    kind,
    skill,
    model: options.model ?? recommendedModel(kind, advice),
    account,
    permissionMode: "auto",
    hold: options.hold,
    reuseBuild: options.reuse ?? undefined,
    continueRunId: options.continueRunId,
    prompt: options.continueRunId
      ? CONTINUE_PROMPT
      : options.prompt ?? buildAgentPrompt({
          kind,
          skill,
          storyId: story.number,
          storyTitle: titleFromKey(story.key),
          sourcePaths: existsSync(path.join(state.localPath, sourcePath)) ? [sourcePath] : [],
          fixFindings: true,
        }),
  });
  // A continued run is already in the queue's list of runs; only a new run is added.
  if (!options.continueRunId) started.push(run.id);
  return run.id;
}

/** What a continued run is told: the limit has reset, so pick up where it stopped. */
const CONTINUE_PROMPT =
  "Pick up where you left off. Finish the task and commit all changes with git commit.";

/** "1-2-sign-up-and-sign-in" → "sign up and sign in", for the prompt. */
function titleFromKey(key: string): string {
  return key.replace(/^\d+-\d+[a-z]?-/, "").replace(/-/g, " ");
}

function plannedModels(advice: ModelAdviceRow | undefined): PlannedModels {
  return {
    brainstorm: recommendedModel("brainstorm", advice),
    plan: recommendedModel("plan", advice),
    dev: recommendedModel("dev", advice),
    review: recommendedModel("review", advice),
  };
}

/** A large story is split into subtasks before it is built; the parent is then marked split. */
function splitPrompt(story: Pick<QueueStory, "number" | "key">): string {
  return [
    `Split story ${story.number} (${titleFromKey(story.key)}) into smaller stories where its parts can be built apart. Follow the project's story-splitting approach.`,
    "",
    "Started from MyBMAD; nobody is watching to answer questions.",
    `- If the story is already one small piece of work, change nothing and halt with a note that says so.`,
    `- Otherwise add the subtasks as ${story.number}a, ${story.number}b, … in the backlog, with their dependencies in story-dependencies.yaml and their complexity in story-complexity.md.`,
    `- Set story ${story.number} to "split" in sprint-status.yaml; its subtasks are the work from now on.`,
    "- Commit the changes on this branch. Do not implement anything.",
  ].join("\n");
}

async function finish(
  file: string,
  result: {
    status: AutorunnerState["status"];
    failed?: boolean;
    note: string | null;
    active?: ActiveStory[];
    waiting?: WaitingStory[];
    done?: string[];
    runIds?: string[];
  },
): Promise<void> {
  const state = await readAutorunner(file);
  if (!state) return;
  await writeAutorunner(file, {
    ...state,
    status: result.status,
    failed: result.failed ?? state.failed,
    active: result.active ?? state.active,
    waiting: result.waiting ?? state.waiting,
    done: result.done ?? state.done,
    runIds: result.runIds ?? state.runIds,
    note: result.note,
    endedAt: new Date().toISOString(),
    driverPid: null,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
