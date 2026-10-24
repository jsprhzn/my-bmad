import { StoryDetail, StoryStatus } from "./types";
import { compareIds } from "./utils";

// Least progressed first: a story is only as far along as its slowest part.
const STATUS_PROGRESS: StoryStatus[] = [
  "blocked",
  "unknown",
  "backlog",
  "ready-for-dev",
  "in-progress",
  "review",
  "done",
];

function leastProgressed(statuses: StoryStatus[]): StoryStatus {
  return statuses.reduce((min, s) =>
    STATUS_PROGRESS.indexOf(s) < STATUS_PROGRESS.indexOf(min) ? s : min,
  );
}

/**
 * Merge stories that share an id into one story. This happens when a story
 * is built in parts, each in its own file ("spec-1-2-part-1-….md",
 * "spec-1-2-part-3-….md"): without merging, the parts would collide on the
 * same id and links would open whichever part was parsed first.
 */
export function mergeStoryParts(stories: StoryDetail[]): StoryDetail[] {
  const groups = new Map<string, StoryDetail[]>();
  for (const s of stories) {
    const group = groups.get(s.id);
    if (group) group.push(s);
    else groups.set(s.id, [s]);
  }

  const merged: StoryDetail[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    const parts = [...group].sort((a, b) =>
      compareIds(a.part ?? "0", b.part ?? "0"),
    );
    const first = parts[0];
    const tasks = parts.flatMap((p) => p.tasks);

    merged.push({
      id: first.id,
      title: first.title,
      status: leastProgressed(parts.map((p) => p.status)),
      statusExplicit: parts.every((p) => p.statusExplicit === true),
      partCount: parts.length,
      sourcePaths: parts.flatMap((p) => p.sourcePaths ?? []),
      epicId: parts.find((p) => p.epicId)?.epicId ?? "",
      description: parts
        .map((p, i) => {
          const label = p.part ? `Part ${p.part}` : `Part ${i + 1}`;
          // The part's own "# Story 1.2 part 3: …" heading repeats the label.
          const body = p.description.replace(/^#\s+.*\n+/, "");
          return `### ${label}: ${p.title} (${p.status})\n\n${body}`;
        })
        .join("\n\n"),
      acceptanceCriteria: parts.flatMap((p) => p.acceptanceCriteria),
      tasks,
      completedTasks: tasks.filter((t) => t.completed).length,
      totalTasks: tasks.length,
    });
  }

  return merged;
}
