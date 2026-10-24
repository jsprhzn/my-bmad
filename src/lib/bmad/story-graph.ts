import yaml from "js-yaml";
import type { StoryDetail } from "./types";

/**
 * Story dependencies from implementation-artifacts/story-dependencies.yaml:
 * `epic-N:` → `<story key>:` → the story keys it needs. A story without a
 * list has no dependencies. Stories are compared by number ("1.2"), so a
 * sprint key and a story id name the same story.
 */
export const STORY_DEPENDENCIES_FILE = /(?:^|\/)story-dependencies\.ya?ml$/i;

/** Story number ("1.2", "1.3c") → the numbers it needs directly. */
export type StoryGraph = Map<string, string[]>;

const STORY_NUMBER = /^(\d+)[-.](\d+[a-z]?)/i;

/** "1-4-invite-my-accountant" or "1.4" → "1.4"; null when there is no number. */
export function storyNumber(storyId: string): string | null {
  const match = storyId.match(STORY_NUMBER);
  return match ? `${match[1]}.${match[2].toLowerCase()}` : null;
}

export function parseStoryDependencies(content: string): StoryGraph {
  const graph: StoryGraph = new Map();
  let document: unknown;
  try {
    document = yaml.load(content);
  } catch {
    return graph;
  }
  if (!document || typeof document !== "object") return graph;

  for (const epic of Object.values(document as Record<string, unknown>)) {
    if (!epic || typeof epic !== "object") continue;
    for (const [key, needs] of Object.entries(epic as Record<string, unknown>)) {
      const id = storyNumber(key);
      if (!id) continue;
      const deps = Array.isArray(needs)
        ? needs.map((d) => storyNumber(String(d))).filter((d): d is string => d !== null)
        : [];
      graph.set(id, deps);
    }
  }
  return graph;
}

/** Every story `id` needs, directly or through others. */
export function requiredStories(id: string, graph: StoryGraph): Set<string> {
  const required = new Set<string>();
  const stack = [...(graph.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (required.has(next)) continue;
    required.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return required;
}

/**
 * Open stories that can be built now alongside `id`: not needed by it, not
 * needing it, and with every story they need already done.
 */
export function parallelStories(
  id: string,
  graph: StoryGraph,
  statusById: Map<string, string>,
): string[] {
  const needed = requiredStories(id, graph);
  const isOpen = (other: string) => statusById.has(other) && statusById.get(other) !== "done";
  return [...statusById.keys()]
    .filter((other) => other !== id)
    .filter((other) => isOpen(other) && statusById.get(other) !== "review")
    .filter((other) => !needed.has(other))
    .filter((other) => !requiredStories(other, graph).has(id))
    .filter((other) => [...requiredStories(other, graph)].every((dep) => !isOpen(dep)))
    .sort();
}

/** Adds `dependsOn` and `parallelWith` (story numbers) to each story. */
export function attachStoryGraph(stories: StoryDetail[], graph: StoryGraph): StoryDetail[] {
  if (graph.size === 0) return stories;
  const statusById = new Map<string, string>();
  for (const story of stories) {
    const id = storyNumber(story.id);
    if (id) statusById.set(id, story.status);
  }

  return stories.map((story) => {
    const id = storyNumber(story.id);
    if (!id || !graph.has(id)) return story;
    return {
      ...story,
      dependsOn: [...requiredStories(id, graph)].sort(),
      parallelWith: parallelStories(id, graph, statusById),
    };
  });
}
