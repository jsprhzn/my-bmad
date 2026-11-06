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
/** A story whose build is on the checkout but whose review never ran or never finished. */
const AWAITING_REVIEW = new Set(["review"]);
/** A need counts as met when it is done, or split: a split story is worked on through its subtasks. */
const MET = new Set(["done", "split"]);

/** Whether the queue may start this story: it is open, or a run left it in progress. */
export function canStart(status: string): boolean {
  return OPEN.has(status) || LEFT_BEHIND.has(status);
}

/**
 * Whether a story waits for a review: its build is in, its status is `review`, and no run holds it. Nothing else
 * moves such a story on, and every story that needs it waits for `done`.
 */
export function awaitsReview(status: string): boolean {
  return AWAITING_REVIEW.has(status);
}

export const MAX_PARALLEL = 3;
/** A story that keeps hitting the token limit is given up after this many tries. */
export const MAX_ATTEMPTS = 6;
/** A story whose build failed is tried again before new stories, until it has failed this many times. */
export const MAX_FAILED_BUILDS = 2;
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
  /** Which statuses may start; stories to build by default, `awaitsReview` for stories left in review. */
  startable?: (status: string) => boolean;
}): QueueStory[] {
  const startable = input.startable ?? canStart;
  const statusOf = new Map(input.stories.map((s) => [s.number, s.status]));
  const taken: string[] = [...input.busy];
  const picked: QueueStory[] = [];
  for (const story of input.stories) {
    if (picked.length >= input.slots) break;
    if (!startable(story.status) || input.busy.has(story.number)) continue;
    const needs = requiredStories(story.number, input.graph);
    // A need that is missing from sprint-status counts as not done: never start blind.
    if ([...needs].some((need) => !MET.has(statusOf.get(need) ?? ""))) continue;
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

/** Story numbers whose build run failed and that may still be tried again, in order of first failure. */
export function failedBuildStories(runs: { kind: string; status: string; storyId: string }[]): string[] {
  const failures = new Map<string, number>();
  for (const run of runs) {
    if (run.kind !== "dev" || run.status !== "failed") continue;
    failures.set(run.storyId, (failures.get(run.storyId) ?? 0) + 1);
  }
  return [...failures].filter(([, count]) => count < MAX_FAILED_BUILDS).map(([number]) => number);
}

/** The stories with a failed build first, in that order; the rest keep file order. */
export function retryFirst(stories: QueueStory[], failed: string[]): QueueStory[] {
  const rank = (number: string) => {
    const index = failed.indexOf(number);
    return index === -1 ? failed.length : index;
  };
  return [...stories].sort((a, b) => rank(a.number) - rank(b.number));
}

export interface DecisionInput {
  /** The failure that stops the queue, when there is one. */
  failure: string | null;
  throttled: boolean;
  limited: boolean;
  /** Share of the plan's limit in use, or null when unknown. */
  load: number | null;
  allowance: number;
  mode: "serial" | "parallel";
  /** Runs in flight: their keys, whether the story is large, and whether it is a retry. */
  active: { key: string; large: boolean; retry: boolean }[];
  /** Open stories not running now. */
  openLeft: number;
  /** ISO time the next retry is due, when the queue waits with nothing running. */
  waitingAt: string | null;
}

/** The one line the autorunner shows: what it is doing and why it runs that many at once. */
export function decisionNote(input: DecisionInput): string | null {
  if (input.failure) return input.failure;
  const pct = input.load === null ? null : Math.round(input.load * 100);
  if (input.throttled) return `Token budget at ${pct ?? 100}%: no new run until there is room again.`;
  if (input.active.length === 0 && input.waitingAt) return `Waiting for the token limit; continuing at ${input.waitingAt}.`;
  if (input.active.length === 0 && input.openLeft > 0) {
    return `Waiting: ${input.openLeft} open ${input.openLeft === 1 ? "story waits" : "stories wait"} on dependencies that are not done yet. The queue keeps running and starts them when they are free.`;
  }
  if (input.active.length === 0) return null;
  const why: string[] = [];
  const retries = input.active.filter((a) => a.retry).map((a) => a.key);
  if (retries.length > 0) why.push(`retrying first: ${retries.join(", ")}`);
  const large = input.active.filter((a) => a.large).map((a) => a.key);
  if (large.length > 0) why.push(`large: ${large.join(", ")}`);
  if (input.limited) why.push(`tokens nearly used up (${pct}%), at most ${input.allowance} at once`);
  else if (input.mode === "serial") why.push("serial mode");
  if (input.active.length < input.allowance && input.openLeft > input.active.length) {
    why.push("other open stories wait on dependencies");
  }
  const count = `${input.active.length} ${input.active.length === 1 ? "run" : "runs"}`;
  return why.length > 0 ? `${count}: ${why.join("; ")}.` : `${count}.`;
}

/** Output that means the account hit a limit that resets on its own. */
const TEMPORARY_LIMIT = /usage limit|hit your [^\n]*limit|rate limit|rate_limit|overloaded|\b429\b|\b529\b/i;

export function isTemporaryLimit(text: string): boolean {
  return TEMPORARY_LIMIT.test(text);
}

/** "resets 1:50pm (Europe/Amsterdam)" or "resets Nov 2 at 4am (Europe/Amsterdam)", as Claude Code writes it. */
const RESET_TEXT = /resets (?:([A-Za-z]{3,9}) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

/**
 * When to try again after a limit. Claude Code reports the reset as
 * "...limit reached|<unix seconds>" or as "resets 1:50pm (Europe/Amsterdam)";
 * without either, wait half an hour.
 */
export function retryAt(text: string, now: Date): Date {
  const reset = text.match(/reached\|(\d{9,11})/);
  if (reset) {
    const at = new Date(Number(reset[1]) * 1000 + RESET_MARGIN_MS);
    if (at.getTime() > now.getTime()) return at;
  }
  const named = resetFromText(text, now);
  if (named) return new Date(named.getTime() + RESET_MARGIN_MS);
  return new Date(now.getTime() + FALLBACK_WAIT_MS);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The next wall-clock time in the zone the message names, after now. */
function resetFromText(text: string, now: Date): Date | null {
  const match = text.match(RESET_TEXT);
  if (!match) return null;
  const [, month, day, hour, minute = "0", meridiem, zone] = match;
  let hours = Number(hour) % 12;
  if (meridiem.toLowerCase() === "pm") hours += 12;
  try {
    const today = zoneParts(now, zone);
    if (month) {
      const monthIndex = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
      if (monthIndex < 0) return null;
      let at = zoneDate(today.year, monthIndex + 1, Number(day), hours, Number(minute), zone);
      // A date that has already passed this year means next year.
      if (at.getTime() <= now.getTime()) at = zoneDate(today.year + 1, monthIndex + 1, Number(day), hours, Number(minute), zone);
      return at;
    }
    // A time that has already passed today means tomorrow.
    let at = zoneDate(today.year, today.month, today.day, hours, Number(minute), zone);
    if (at.getTime() <= now.getTime()) at = zoneDate(today.year, today.month, today.day + 1, hours, Number(minute), zone);
    return at;
  } catch {
    return null;
  }
}

/** The calendar date and clock of an instant in a time zone. */
function zoneParts(instant: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** The instant at which a time zone's clock shows the given date and time. */
function zoneDate(year: number, month: number, day: number, hour: number, minute: number, zone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let at = wall;
  // Two passes: the first guess can sit on the other side of a daylight-saving change.
  for (let pass = 0; pass < 2; pass++) {
    const p = zoneParts(new Date(at), zone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    at = wall - (shown - at);
  }
  return new Date(at);
}

export type Phase = "split" | "build" | "review";

export interface ActiveStory {
  key: string;
  number: string;
  phase: Phase;
  runId: string;
  /** The models planned for the story's actions, shown before their run starts. */
  models?: PlannedModels;
  /** For a review: the build run whose held branch it works on. */
  buildRunId?: string;
  /** A review of a story that was left in `review` with no run on it: it must end with the story done. */
  leftInReview?: boolean;
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
  /** The run that hit the limit: the retry continues this run instead of starting a new one. */
  runId?: string;
  /** Carried over from the review that hit the limit. */
  leftInReview?: boolean;
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
  /** Split large stories into subtasks before they are built. */
  splitLarge?: boolean;
  /** Large stories already split, or tried: they are built, not split again. */
  split?: string[];
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
