import { describe, expect, it } from "vitest";
import { parseStoryDependencies } from "@/lib/bmad/story-graph";
import {
  isTemporaryLimit,
  nextStories,
  readSprintStories,
  retryAt,
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

  it("treats a need missing from sprint-status as not done", () => {
    const partial = stories.filter((s) => s.number !== "1.1");
    const picked = nextStories({ stories: partial, graph: GRAPH, busy: new Set(), slots: 3 });
    expect(picked).toEqual([]);
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
