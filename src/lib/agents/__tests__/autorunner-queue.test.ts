import { describe, expect, it } from "vitest";
import { parseStoryDependencies } from "@/lib/bmad/story-graph";
import {
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
});
