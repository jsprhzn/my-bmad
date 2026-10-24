import { Epic, FileTreeNode, StoryStatus } from "./types";

/**
 * Canonical normalizeStoryStatus used across all BMAD parsers.
 * Default fallback is "backlog".
 */
export function normalizeStoryStatus(raw: string | undefined): StoryStatus {
  if (!raw) return "backlog";
  const s = raw.toLowerCase().trim();
  if (s === "done" || s === "complete" || s === "completed") return "done";
  if (s.includes("progress") || s === "started") return "in-progress";
  if (s === "review" || s.includes("review")) return "review";
  if (s === "blocked") return "blocked";
  if (s === "ready-for-dev" || s === "ready") return "ready-for-dev";
  if (s === "backlog" || s === "todo" || s === "pending") return "backlog";
  if (s === "optional") return "backlog";
  return "backlog";
}

export function buildFileTree(paths: string[], basePath: string): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  const filtered = paths
    .filter((p) => p.startsWith(basePath))
    .map((p) => p.slice(basePath.length).replace(/^\//, ""));

  for (const relativePath of filtered) {
    const parts = relativePath.split("/");
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const fullPath = basePath + "/" + parts.slice(0, i + 1).join("/");

      let existing = currentLevel.find((n) => n.name === part);
      if (!existing) {
        existing = {
          name: part,
          path: fullPath,
          type: isFile ? "file" : "directory",
          children: isFile ? undefined : [],
        };
        currentLevel.push(existing);
      }

      if (!isFile && existing.children) {
        currentLevel = existing.children;
      }
    }
  }

  return sortTree(root);
}

function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((n) => ({
      ...n,
      children: n.children ? sortTree(n.children) : undefined,
    }));
}

export function normalizeStoryId(raw: string): string {
  return raw
    .replace(/^(?:story|S)[_-]?/i, "")
    .replace(/[._]/, ".")
    .trim();
}

/**
 * Prefix some BMAD workflows put in front of a story key in the filename,
 * e.g. "spec-1-2-sign-in.md" from the quick-spec / build workflow.
 */
export const STORY_FILE_PREFIX = /^spec[-_]/i;

/**
 * Artifacts that are named after an epic or story but are not stories
 * themselves: "review-1-2.md", "epic-1-context.md", "retro-epic-1.md".
 */
export const NON_STORY_FILE_PREFIX =
  /^(?:epic|bmad|review|reviews|retro|retrospective|deferred|context|validation)[-_]/i;

export interface NumericStoryKey {
  epicId: string;
  /** Story number within the epic, with an optional letter suffix ("3c"). */
  storyNum: string;
  /** Part label when the key names one part of a story ("1", "2-5"). */
  part?: string;
}

/**
 * Parse a numeric story key as used in filenames and sprint-status keys:
 * "1-2-title", "1-3c-title", "1-2-part-1-title", "1-2-parts-2-5-title".
 */
export function parseNumericStoryKey(key: string): NumericStoryKey | null {
  const m = key.match(
    /^(\d+)-(\d+[a-z]?)(?:-parts?-(\d+(?:-\d+)?))?(?=-|\.|$)/i,
  );
  if (!m) return null;
  return {
    epicId: m[1],
    storyNum: m[2].toLowerCase(),
    part: m[3],
  };
}

export function normalizeAlphanumericId(raw: string): string {
  return raw.trim().toLowerCase().replace(/\//g, "-");
}

export function compareIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function getEpicShortId(epic: Epic): string {
  if (/^\d+$/.test(epic.id)) return epic.id;

  const firstStoryId = epic.stories[0];
  const prefix = firstStoryId?.split(".")[0];
  if (prefix && prefix.length <= 4 && /[a-z]/i.test(prefix)) {
    return prefix.toUpperCase();
  }

  return epic.id.slice(0, 2).toUpperCase();
}

export function getStoryShortId(storyId: string): string {
  const parts = storyId.split(".");
  if (parts.length > 1) return parts.slice(1).join(".");
  return storyId;
}
