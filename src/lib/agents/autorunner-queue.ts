import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { requiredStories, type StoryGraph } from "../bmad/story-graph";
import { storyNumber } from "../bmad/story-number";
import { runsDir } from "./run-store";
import type { PlannedModels } from "./run-stages";

/**
 * The autorunner: a queue that takes open stories from the project one by
 * one (or up to a few at once) and runs their builds, and reviews, in auto
 * mode until nothing is left or it is stopped.
 *
 * The queue is a state file in .agent-runs/autorunners/. The driver process
 * (scripts/autorunner.ts) reads it every tick, so "stop" in the UI is a flag
 * the driver sees, and the queue survives a restart of MyBMAD.
 */

export interface QueueStory {
  /** Story number, "1.2" (the id runs use). */
  number: string;
  /** Sprint-status key, "1-2-sign-up-and-sign-in". */
  key: string;
  status: string;
}

/** Stories the queue may start: not begun yet. */
const OPEN = new Set(["backlog", "ready-for-dev"]);
/** A story a failed or stopped run left in progress: picked up again, unless a run is still on it. */
const LEFT_BEHIND = new Set(["in-progress"]);

/** Whether the queue may start this story: it is open, or a run left it in progress. */
export function canStart(status: string): boolean {
  return OPEN.has(status) || LEFT_BEHIND.has(status);
}

export const MAX_PARALLEL = 3;
/** A story that keeps hitting the token limit is given up after this many tries. */
export const MAX_ATTEMPTS = 6;
const FALLBACK_WAIT_MS = 30 * 60 * 1000;
const RESET_MARGIN_MS = 60 * 1000;

/** The sprint-status entries that are stories, in file order. */
export function readSprintStories(content: string): QueueStory[] {
  let document: unknown;
  try {
    document = yaml.load(content);
  } catch {
    return [];
  }
  const development = (document as { development_status?: unknown } | null)?.development_status;
  if (!development || typeof development !== "object") return [];
  const stories: QueueStory[] = [];
  for (const [key, value] of Object.entries(development as Record<string, unknown>)) {
    const number = /^\d+-/.test(key) ? storyNumber(key) : null;
    if (!number) continue;
    stories.push({ number, key, status: String(value).trim() });
  }
  return stories;
}

/**
 * Open stories that can start now, in file order: every story they need is
 * done, none is busy, and no two picked in one round need each other.
 */
export function nextStories(input: {
  stories: QueueStory[];
  graph: StoryGraph;
  /** Story numbers that are already running, waiting or done. */
  busy: Set<string>;
  slots: number;
}): QueueStory[] {
  const statusOf = new Map(input.stories.map((s) => [s.number, s.status]));
  const taken: string[] = [...input.busy];
  const picked: QueueStory[] = [];
  for (const story of input.stories) {
    if (picked.length >= input.slots) break;
    if (!canStart(story.status) || input.busy.has(story.number)) continue;
    const needs = requiredStories(story.number, input.graph);
    // A need that is missing from sprint-status counts as not done: never start blind.
    if ([...needs].some((need) => statusOf.get(need) !== "done")) continue;
    const related = taken.some(
      (other) =>
        needs.has(other) || requiredStories(other, input.graph).has(story.number),
    );
    if (related) continue;
    picked.push(story);
    taken.push(story.number);
  }
  return picked;
}

/** Output that means the account hit a limit that resets on its own. */
const TEMPORARY_LIMIT = /usage limit|rate limit|rate_limit|overloaded|\b429\b|\b529\b/i;

export function isTemporaryLimit(text: string): boolean {
  return TEMPORARY_LIMIT.test(text);
}

/**
 * When to try again after a limit. Claude Code reports the reset as
 * "...limit reached|<unix seconds>"; without it, wait half an hour.
 */
export function retryAt(text: string, now: Date): Date {
  const reset = text.match(/reached\|(\d{9,11})/);
  if (reset) {
    const at = new Date(Number(reset[1]) * 1000 + RESET_MARGIN_MS);
    if (at.getTime() > now.getTime()) return at;
  }
  return new Date(now.getTime() + FALLBACK_WAIT_MS);
}

export type Phase = "build" | "review";

export interface ActiveStory {
  key: string;
  number: string;
  phase: Phase;
  runId: string;
  /** The models planned for the story's actions, shown before their run starts. */
  models?: PlannedModels;
  /** For a review: the build run whose held branch it works on. */
  buildRunId?: string;
}

export interface WaitingStory {
  key: string;
  number: string;
  phase: Phase;
  /** ISO time to start the run again. */
  at: string;
  attempts: number;
  /** For a review: the build run whose held branch it works on. */
  buildRunId?: string;
}

export interface AutorunnerState {
  id: string;
  /** "owner/name" of the project and the user who started the queue. */
  repoKey: string;
  userId: string;
  localPath: string;
  /** Claude account the runs use (AGENT_CLAUDE_ACCOUNTS name); null is the default. */
  account: string | null;
  mode: "serial" | "parallel";
  /** Review each story after its build. */
  review: boolean;
  status: "running" | "stopped" | "completed" | "failed";
  /** Set by "Stop": no new story starts; the running ones finish. */
  stopRequested: boolean;
  /** Set when a story failed for a reason that is not a limit. */
  failed: boolean;
  driverPid: number | null;
  startedAt: string;
  endedAt: string | null;
  active: ActiveStory[];
  waiting: WaitingStory[];
  done: string[];
  /** Stories stopped by hand from the queue: not taken up again. */
  skipped: string[];
  /** Every run the queue started, in order: its tokens and cost are summed from these. */
  runIds: string[];
  /** Why the queue is waiting, stopped or failed, for the UI. */
  note: string | null;
}

function autorunnersDir(): string {
  return path.join(runsDir(), "autorunners");
}

export function autorunnerFile(id: string): string {
  if (!/^\d{13}-[0-9a-f]{8}$/.test(id)) throw new Error("Invalid autorunner id");
  return path.join(autorunnersDir(), `${id}.json`);
}

export async function readAutorunner(file: string): Promise<AutorunnerState | null> {
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as AutorunnerState;
    // Queues started before run ids were kept have none.
    return { ...state, runIds: state.runIds ?? [], skipped: state.skipped ?? [] };
  } catch {
    return null;
  }
}

/** Write through a temp file, so the driver never reads half a state. */
export async function writeAutorunner(file: string, state: AutorunnerState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/** Every queue of a project for one user, newest first. */
export async function listAutorunners(repoKey: string, userId: string): Promise<AutorunnerState[]> {
  const dir = autorunnersDir();
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const states: AutorunnerState[] = [];
  for (const file of files) {
    const state = await readAutorunner(path.join(dir, file));
    if (state && state.repoKey === repoKey && state.userId === userId) states.push(state);
  }
  return states.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
