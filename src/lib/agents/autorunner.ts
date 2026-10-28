import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseModelAdvice } from "../bmad/parse-model-advice";
import { parseStoryDependencies, type StoryGraph } from "../bmad/story-graph";
import type { ModelAdviceRow } from "../bmad/types";
import { defaultSkillFor } from "./action-skills";
import { findClaudeAccount, type ClaudeAccount } from "./accounts";
import {
  MAX_ATTEMPTS,
  MAX_PARALLEL,
  nextStories,
  readAutorunner,
  readSprintStories,
  retryAt,
  isTemporaryLimit,
  writeAutorunner,
  type ActiveStory,
  type AutorunnerState,
  type Phase,
  type QueueStory,
  type WaitingStory,
} from "./autorunner-queue";
import { buildAgentPrompt } from "./prompts";
import { listProjectSkills } from "./project-skills";
import { recommendedModel, type AgentRunKind } from "./models";
import { listRuns, startRun } from "./run-store";

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
  const account = findClaudeAccount(boot.account ?? undefined);
  if (boot.account && !account) {
    await finish(file, { status: "failed", failed: true, note: `Unknown Claude account ${boot.account}.` });
    return;
  }

  for (;;) {
    const state = await readAutorunner(file);
    if (!state) return;
    const project = await readProject(state.localPath);
    const runs = await listRuns({ repoKey: state.repoKey, userId: state.userId });
    const runById = new Map(runs.map((r) => [r.id, r]));
    const now = new Date();

    // 1. Settle the runs that ended.
    const active: ActiveStory[] = [];
    const waiting: WaitingStory[] = state.waiting.filter((w) => Date.parse(w.at) > now.getTime());
    let failure: string | null = null;
    for (const story of state.active) {
      const run = runById.get(story.runId);
      if (!run || run.status === "running") {
        active.push(story);
        continue;
      }
      if (run.status === "completed") {
        if (story.phase === "build") {
          const sprint = project.statusOf.get(story.number) ?? "unknown";
          if (sprint === "blocked" || (sprint !== "review" && sprint !== "done")) {
            failure = `${story.key}: sprint-status says "${sprint}" after the build.`;
            continue;
          }
          if (state.review) {
            const runId = await startStoryRun(state, account, "review", story, project, reviewSkill);
            active.push({ ...story, phase: "review", runId });
            continue;
          }
        }
        if (!state.done.includes(story.number)) state.done.push(story.number);
        continue;
      }
      // A limit that resets on its own: try the same step again later.
      const text = run.error ?? "";
      if (isTemporaryLimit(text)) {
        const attempts = (state.waiting.find((w) => w.number === story.number)?.attempts ?? 0) + 1;
        if (attempts > MAX_ATTEMPTS) {
          failure = `${story.key}: still hitting the token limit after ${MAX_ATTEMPTS} tries.`;
          continue;
        }
        waiting.push({
          key: story.key,
          number: story.number,
          phase: story.phase,
          at: retryAt(text, now).toISOString(),
          attempts,
        });
        continue;
      }
      failure = `${story.key}: ${text.split("\n")[0] || "the run failed"}`;
    }

    // 2. Start what the slots allow: retries that are due first, then new stories.
    const stopping = state.stopRequested || failure !== null;
    const slots = (state.mode === "serial" ? 1 : MAX_PARALLEL) - active.length;
    const busy = new Set<string>([
      ...active.map((a) => a.number),
      ...waiting.map((w) => w.number),
      ...state.done,
      ...runs.filter((r) => r.status === "running").map((r) => r.storyId),
    ]);
    const due = waiting.filter((w) => Date.parse(w.at) <= now.getTime());
    let free = slots;
    if (!stopping) {
      for (const retry of due) {
        if (free <= 0) break;
        const story = project.stories.find((s) => s.number === retry.number);
        if (!story) continue;
        const runId = await startStoryRun(state, account, retry.phase, story, project, retry.phase === "build" ? buildSkill : reviewSkill);
        active.push({ key: story.key, number: story.number, phase: retry.phase, runId });
        waiting.splice(waiting.findIndex((w) => w.number === retry.number), 1);
        busy.add(story.number);
        free -= 1;
      }
      const fresh = nextStories({ stories: project.stories, graph: project.graph, busy, slots: free });
      for (const story of fresh) {
        const runId = await startStoryRun(state, account, "build", story, project, buildSkill);
        active.push({ key: story.key, number: story.number, phase: "build", runId });
      }
    }

    // 3. Save the state, or finish when nothing is left to do. Once stopping, pending retries are dropped.
    const failed = state.failed || failure !== null;
    const failNote = failure ?? (state.failed ? state.note : null);
    const pending = stopping ? [] : waiting;
    const openLeft = project.stories.filter((s) => s.status === "backlog" || s.status === "ready-for-dev");
    const nextWait = Math.min(...pending.map((w) => Date.parse(w.at)));

    if (active.length === 0 && (stopping || pending.length === 0)) {
      const status = failed ? "failed" : "stopped";
      await finish(file, {
        status: failed || state.stopRequested || openLeft.length > 0 ? status : "completed",
        note: failed
          ? failNote
          : state.stopRequested
            ? "Gestopt."
            : openLeft.length === 0
              ? "Alle stories zijn af."
              : `${openLeft.length} stories wachten op afhankelijkheden die nu niet klaar zijn.`,
        active,
        waiting: pending,
        done: state.done,
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
      note:
        failNote ??
        (pending.length > 0 && active.length === 0
          ? `Wacht op de token-limiet; verder om ${new Date(nextWait).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}.`
          : null),
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

/** Start one build or review run for a story, in auto mode, and return its run id. */
async function startStoryRun(
  state: AutorunnerState,
  account: ClaudeAccount | null,
  phase: Phase,
  story: Pick<QueueStory, "number" | "key">,
  project: Project,
  skill: string,
): Promise<string> {
  const kind: AgentRunKind = phase === "build" ? "dev" : "review";
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
    model: recommendedModel(kind, advice),
    account,
    permissionMode: "auto",
    prompt: buildAgentPrompt({
      kind,
      skill,
      storyId: story.number,
      storyTitle: titleFromKey(story.key),
      sourcePaths: existsSync(path.join(state.localPath, sourcePath)) ? [sourcePath] : [],
      fixFindings: true,
    }),
  });
  return run.id;
}

/** "1-2-sign-up-and-sign-in" → "sign up and sign in", for the prompt. */
function titleFromKey(key: string): string {
  return key.replace(/^\d+-\d+[a-z]?-/, "").replace(/-/g, " ");
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
    note: result.note,
    endedAt: new Date().toISOString(),
    driverPid: null,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
