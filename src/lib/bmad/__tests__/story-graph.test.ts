import { describe, expect, it } from "vitest";
import {
  attachStoryGraph,
  parallelStories,
  parseStoryDependencies,
  requiredStories,
  storyNumber,
} from "../story-graph";
import type { StoryDetail } from "../types";

const YAML = `# comment
epic-1:
  1-1-scaffold:
  1-2-sign-up:
    - 1-1-scaffold
  1-3c-change-details:
    - 1-2-sign-up
epic-2:
  2-1-chart:
    - 1-2-sign-up
  2-2-post:
    - 2-1-chart
`;

function story(id: string, status: StoryDetail["status"]): StoryDetail {
  return {
    id,
    title: id,
    status,
    epicId: "1",
    description: "",
    acceptanceCriteria: [],
    tasks: [],
    completedTasks: 0,
    totalTasks: 0,
  };
}

describe("storyNumber", () => {
  it("reads sprint keys and dotted ids", () => {
    expect(storyNumber("1-4-invite-my-accountant")).toBe("1.4");
    expect(storyNumber("1-3c-change-details")).toBe("1.3c");
    expect(storyNumber("1.2")).toBe("1.2");
    expect(storyNumber("epic-1")).toBeNull();
  });
});

describe("parseStoryDependencies", () => {
  const graph = parseStoryDependencies(YAML);

  it("reads every story, including letter variants, and lists without deps", () => {
    expect([...graph.keys()]).toEqual(["1.1", "1.2", "1.3c", "2.1", "2.2"]);
    expect(graph.get("1.1")).toEqual([]);
    expect(graph.get("1.3c")).toEqual(["1.2"]);
  });

  it("returns an empty graph for malformed YAML", () => {
    expect(parseStoryDependencies("epic-1: [").size).toBe(0);
  });
});

describe("requiredStories and parallelStories", () => {
  const graph = parseStoryDependencies(YAML);

  it("follows dependencies transitively", () => {
    expect([...requiredStories("2.2", graph)].sort()).toEqual(["1.1", "1.2", "2.1"]);
  });

  it("finds open stories that are independent and whose needs are done", () => {
    const status = new Map([
      ["1.1", "done"],
      ["1.2", "done"],
      ["1.3c", "backlog"],
      ["2.1", "backlog"],
      ["2.2", "backlog"],
    ]);
    // 1.3c needs only 1.2 (done) and is unrelated to 2.1; 2.2 waits on 2.1.
    expect(parallelStories("2.1", graph, status)).toEqual(["1.3c"]);
    expect(parallelStories("1.3c", graph, status)).toEqual(["2.1"]);
  });

  it("does not offer a story whose needs are still open", () => {
    const status = new Map([
      ["1.1", "review"],
      ["1.2", "backlog"],
      ["1.3c", "backlog"],
      ["2.1", "backlog"],
    ]);
    expect(parallelStories("2.1", graph, status)).toEqual([]);
  });
});

describe("attachStoryGraph", () => {
  it("adds dependsOn and parallelWith to stories in the graph", () => {
    const graph = parseStoryDependencies(YAML);
    const stories = [
      story("1-1-scaffold", "done"),
      story("1-2-sign-up", "done"),
      story("2-1-chart", "backlog"),
      story("2-2-post", "backlog"),
      story("9-9-unknown", "backlog"),
    ];
    const [, , chart, post, unknown] = attachStoryGraph(stories, graph);
    // Only the direct needs: 2.1 needs 1.2, and 1.2 needing 1.1 is not shown again.
    expect(chart.dependsOn).toEqual(["1.2"]);
    expect(post.dependsOn).toEqual(["2.1"]);
    // 2.2 needs 2.1, so only 9.9 (open, unrelated, no listed needs) runs alongside it.
    expect(chart.parallelWith).toEqual(["9.9"]);
    expect(unknown.dependsOn).toBeUndefined();
  });

  it("offers no parallel work for a story that is done or in review", () => {
    const graph = parseStoryDependencies(YAML);
    const stories = [
      story("1-1-scaffold", "done"),
      story("1-2-sign-up", "done"),
      story("2-1-chart", "review"),
      story("9-9-unknown", "backlog"),
    ];
    const [, done, review] = attachStoryGraph(stories, graph);
    expect(done.parallelWith).toEqual([]);
    expect(review.parallelWith).toEqual([]);
  });

  it("leaves stories alone when there is no dependency file", () => {
    const stories = [story("1-1-scaffold", "done")];
    expect(attachStoryGraph(stories, new Map())).toBe(stories);
  });
});
