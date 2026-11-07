import { describe, expect, it } from "vitest";
import { parseStoryDependencies } from "@/lib/bmad/story-graph";
import {
  MAX_REPAIRS,
  planRepairs,
  repairPrompt,
  type Problem,
  awaitsReview,
  decisionNote,
  failedBuildStories,
  isTemporaryLimit,
  nextStories,
  readSprintStories,
  retryAt,
  retryFirst,
} from "../autorunner-queue";

const SPRINT = `
development_status:
  epic-1: in-progress
  1-1-scaffold: done
  1-2-sign-in: backlog
  1-3-first-admin: ready-for-dev
  1-4-invite: backlog
  2-1-chart: backlog
`;

const GRAPH = parseStoryDependencies(`
epic-1:
  1-1-scaffold:
  1-2-sign-in:
    - 1-1-scaffold
  1-3-first-admin:
    - 1-2-sign-in
  1-4-invite:
    - 1-3-first-admin
epic-2:
  2-1-chart:
    - 1-3-first-admin
`);

describe("readSprintStories", () => {
  it("keeps the story entries, in file order, with their numbers", () => {
    const stories = readSprintStories(SPRINT);
    expect(stories.map((s) => [s.number, s.status])).toEqual([
      ["1.1", "done"],
      ["1.2", "backlog"],
      ["1.3", "ready-for-dev"],
      ["1.4", "backlog"],
      ["2.1", "backlog"],
    ]);
  });

  it("returns nothing for a file without development_status", () => {
    expect(readSprintStories("other: 1")).toEqual([]);
  });
});

describe("nextStories", () => {
  const stories = readSprintStories(SPRINT);

  it("starts only stories whose needs are all done", () => {
    const picked = nextStories({ stories, graph: GRAPH, busy: new Set(), slots: 3 });
    // 1.2 needs 1.1 (done); 1.3 needs 1.2 (not done); 1.4 and 2.1 need 1.3.
    expect(picked.map((s) => s.number)).toEqual(["1.2"]);
  });

  it("does not start a story that is busy", () => {
    const picked = nextStories({ stories, graph: GRAPH, busy: new Set(["1.2"]), slots: 3 });
    expect(picked).toEqual([]);
  });

  it("starts stories that do not need each other, up to the slots", () => {
    const done = stories.map((s) => (s.number === "1.2" ? { ...s, status: "done" } : s));
    const picked = nextStories({ stories: done, graph: GRAPH, busy: new Set(), slots: 1 });
    expect(picked.map((s) => s.number)).toEqual(["1.3"]);
  });

  it("never picks two stories in one round that need each other", () => {
    const done = stories.map((s) =>
      s.number === "1.2" || s.number === "1.3" ? { ...s, status: "done" } : s,
    );
    const picked = nextStories({ stories: done, graph: GRAPH, busy: new Set(), slots: 3 });
    // 1.4 and 2.1 both need 1.3 only; they do not need each other, so both may start.
    expect(picked.map((s) => s.number)).toEqual(["1.4", "2.1"]);
  });

  it("starts the stories that were waiting for a story this queue finished", () => {
    // 1.2 is done and the queue finished it itself, so it is in `busy`: 1.3 may still start.
    const done = stories.map((s) => (s.number === "1.2" ? { ...s, status: "done" } : s));
    const picked = nextStories({ stories: done, graph: GRAPH, busy: new Set(["1.2"]), slots: 3 });
    expect(picked.map((s) => s.number)).toEqual(["1.3"]);
  });

  it("keeps a subtask's own number apart from its parent's", () => {
    const split = readSprintStories(
      "development_status:\n  6-3a-pain-001-xml: split\n  6-3aa-payment-storage: backlog\n  6-3ab-xsds: backlog\n",
    );
    expect(split.map((s) => [s.number, s.status])).toEqual([
      ["6.3a", "split"],
      ["6.3aa", "backlog"],
      ["6.3ab", "backlog"],
    ]);
  });

  it("starts the subtasks of a split story: a split need counts as met", () => {
    const split = [
      { number: "6.3a", key: "6-3a-pain-001-xml", status: "split" },
      { number: "6.3aa", key: "6-3aa-payment-storage", status: "backlog" },
    ];
    const graph = parseStoryDependencies("epic-6:\n  6-3a-pain-001-xml:\n  6-3aa-payment-storage:\n    - 6-3a-pain-001-xml\n");
    const picked = nextStories({ stories: split, graph, busy: new Set(), slots: 3 });
    expect(picked.map((s) => s.number)).toEqual(["6.3aa"]);
  });

  it("treats a need missing from sprint-status as not done", () => {
    const partial = stories.filter((s) => s.number !== "1.1");
    const picked = nextStories({ stories: partial, graph: GRAPH, busy: new Set(), slots: 3 });
    expect(picked).toEqual([]);
  });
});

describe("failed builds", () => {
  const stories = readSprintStories(SPRINT);
  const run = (storyId: string, status: string, kind = "dev") => ({ kind, status, storyId });

  it("finds the stories whose build failed, and leaves out a story that failed twice", () => {
    const runs = [run("1.4", "failed"), run("1.2", "completed"), run("1.3", "failed"), run("1.3", "failed")];
    expect(failedBuildStories(runs)).toEqual(["1.4"]);
  });

  it("ignores failed runs that are not builds", () => {
    expect(failedBuildStories([run("1.3", "failed", "review")])).toEqual([]);
  });

  it("puts a story with a failed build before new stories", () => {
    const ordered = retryFirst(stories, ["1.3"]);
    expect(ordered.map((s) => s.number)).toEqual(["1.3", "1.1", "1.2", "1.4", "2.1"]);
  });

  it("retries a failed story before a new one, but still skips one that is not open", () => {
    const done = stories.map((s) => (s.number === "1.2" ? { ...s, status: "done" } : s));
    const ordered = retryFirst(done, ["1.3", "1.1"]);
    const picked = nextStories({ stories: ordered, graph: GRAPH, busy: new Set(), slots: 2 });
    // 1.1 is done, so it is not retried; 1.3 is open and its needs are done, and 1.4 and 2.1 need 1.3.
    expect(picked.map((s) => s.number)).toEqual(["1.3"]);
  });
});

describe("decisionNote", () => {
  const base = {
    failure: null,
    throttled: false,
    limited: false,
    load: 0.3,
    allowance: 3,
    mode: "parallel" as const,
    active: [],
    openLeft: 0,
    waitingAt: null,
  };

  it("says why it runs two stories at once: both are large", () => {
    const note = decisionNote({
      ...base,
      active: [
        { key: "8-3", large: true, retry: false },
        { key: "4-1d", large: true, retry: false },
      ],
    });
    expect(note).toBe("2 runs: large: 8-3, 4-1d.");
  });

  it("says when tokens are nearly used up", () => {
    const note = decisionNote({
      ...base,
      limited: true,
      load: 0.8,
      allowance: 2,
      active: [{ key: "8-3", large: false, retry: false }],
      openLeft: 3,
    });
    expect(note).toBe("1 run: tokens nearly used up (80%), at most 2 at once; other open stories wait on dependencies.");
  });

  it("says when a failed story is tried again first", () => {
    const note = decisionNote({ ...base, active: [{ key: "8-2", large: false, retry: true }] });
    expect(note).toBe("1 run: retrying first: 8-2.");
  });

  it("says when it waits for the token limit with nothing running", () => {
    const note = decisionNote({ ...base, active: [], waitingAt: "12:30" });
    expect(note).toBe("Waiting for the token limit; continuing at 12:30.");
  });
});

describe("token limit", () => {
  it("recognises a limit and an overload, not an ordinary failure", () => {
    expect(isTemporaryLimit("Claude AI usage limit reached|1793200000")).toBe(true);
    expect(isTemporaryLimit("API Error: 429 rate limit")).toBe(true);
    expect(isTemporaryLimit("Overloaded")).toBe(true);
    expect(isTemporaryLimit("TypeError: cannot read properties of undefined")).toBe(false);
  });

  it("retries at the reset time plus a minute", () => {
    const now = new Date("2026-10-28T10:00:00Z");
    const reset = Math.floor(new Date("2026-10-28T12:00:00Z").getTime() / 1000);
    const at = retryAt(`usage limit reached|${reset}`, now);
    expect(at.toISOString()).toBe("2026-10-28T12:01:00.000Z");
  });

  it("waits half an hour when the reset time is not given", () => {
    const now = new Date("2026-10-28T10:00:00Z");
    expect(retryAt("rate limit", now).toISOString()).toBe("2026-10-28T10:30:00.000Z");
  });

  it("recognises the five-hour limit message", () => {
    expect(isTemporaryLimit("You've hit your 5-hour limit · resets 1:50pm (Europe/Amsterdam)")).toBe(true);
  });

  it("reads a reset time of the day in the zone it names", () => {
    // 1:50pm in Amsterdam on 30 October 2026 is 12:50 UTC (CET, after the clocks went back).
    const now = new Date("2026-10-30T10:36:38Z");
    const text = "You've hit your 5-hour limit · resets 1:50pm (Europe/Amsterdam)";
    expect(retryAt(text, now).toISOString()).toBe("2026-10-30T12:51:00.000Z");
  });

  it("reads a reset date and time, and moves a passed time to the next day", () => {
    const text = "usage limit · resets Nov 2 at 4am (Europe/Amsterdam)";
    expect(retryAt(text, new Date("2026-10-30T10:00:00Z")).toISOString()).toBe("2026-11-02T03:01:00.000Z");
    const later = new Date("2026-10-30T13:00:00Z");
    expect(retryAt("You've hit your 5-hour limit · resets 1:50pm (Europe/Amsterdam)", later).toISOString()).toBe(
      "2026-10-31T12:51:00.000Z",
    );
  });
});

describe("stories left in review", () => {
  const sprint = readSprintStories(`
development_status:
  1-1-scaffold: done
  1-2-sign-in: review
  1-3-first-admin: backlog
  1-4-invite: backlog
`);

  it("is not picked up as a story to build", () => {
    const picked = nextStories({ stories: sprint, graph: GRAPH, busy: new Set(), slots: 3 });
    expect(picked.map((s) => s.number)).toEqual([]);
  });

  it("is picked up for a review when its needs are done", () => {
    const picked = nextStories({
      stories: sprint,
      graph: GRAPH,
      busy: new Set(),
      slots: 3,
      startable: awaitsReview,
    });
    expect(picked.map((s) => s.number)).toEqual(["1.2"]);
  });

  it("is not reviewed again while a run is on it", () => {
    const picked = nextStories({
      stories: sprint,
      graph: GRAPH,
      busy: new Set(["1.2"]),
      slots: 3,
      startable: awaitsReview,
    });
    expect(picked).toEqual([]);
  });
});

describe("repairing what goes wrong", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  const problem = (over: Partial<Problem> = {}): Problem => ({
    number: "10.1b",
    key: "10-1b-ledger",
    phase: "review",
    message: "10-1b-ledger: sprint-status says \"review\" after the review.",
    failedRunId: "run-1",
    repairable: true,
    ...over,
  });

  it("queues a repair instead of stopping", () => {
    const plan = planRepairs({ problems: [problem()], repairs: undefined, stopRequested: false, waiting: [], now });
    expect(plan.failure).toBeNull();
    expect(plan.repairs).toEqual({ "10.1b": 1 });
    expect(plan.queue).toHaveLength(1);
    expect(plan.queue[0]).toMatchObject({ number: "10.1b", phase: "repair", at: now.toISOString() });
    expect(plan.queue[0].repair?.failedRunId).toBe("run-1");
  });

  it("stops after the story has been repaired the maximum number of times", () => {
    const plan = planRepairs({
      problems: [problem()],
      repairs: { "10.1b": MAX_REPAIRS },
      stopRequested: false,
      waiting: [],
      now,
    });
    expect(plan.queue).toEqual([]);
    expect(plan.failure).toContain(`still failing after ${MAX_REPAIRS} repairs`);
  });

  it("stops for what an AI cannot repair, and when the user stopped the queue", () => {
    const limit = planRepairs({ problems: [problem({ repairable: false })], repairs: {}, stopRequested: false, waiting: [], now });
    expect(limit.queue).toEqual([]);
    expect(limit.failure).toBe(problem().message);
    const stopped = planRepairs({ problems: [problem()], repairs: {}, stopRequested: true, waiting: [], now });
    expect(stopped.queue).toEqual([]);
    expect(stopped.failure).not.toBeNull();
  });

  it("queues one repair per story, and keeps the first failure for the rest", () => {
    const plan = planRepairs({
      problems: [problem(), problem({ message: "again" }), problem({ number: "2.1", key: "2-1-x", repairable: false, message: "2-1-x: limit" })],
      repairs: {},
      stopRequested: false,
      waiting: [],
      now,
    });
    expect(plan.queue.map((w) => w.number)).toEqual(["10.1b"]);
    expect(plan.failure).toBe("2-1-x: limit");
  });

  it("tells the repair the failure, the logs and the state to leave the story in", () => {
    const prompt = repairPrompt({
      number: "10.1b",
      key: "10-1b-ledger",
      info: { message: "boom", failedRunId: "run-1" },
      runsDir: "/runs",
      attempt: 1,
    });
    expect(prompt).toContain("boom");
    expect(prompt).toContain("/runs");
    expect(prompt).toContain("run-1.jsonl");
    expect(prompt).toContain("Never leave it \"blocked\"");
    expect(prompt).toContain(`attempt 1 of ${MAX_REPAIRS}`);
  });

  it("shows a repair in the queue's note", () => {
    const note = decisionNote({
      failure: null,
      throttled: false,
      limited: false,
      load: null,
      allowance: 3,
      mode: "parallel",
      active: [{ key: "10-1b-ledger", large: false, retry: false, repair: true }],
      openLeft: 1,
      waitingAt: null,
    });
    expect(note).toContain("repairing: 10-1b-ledger");
  });
});
