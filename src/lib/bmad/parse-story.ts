import matter from "gray-matter";
import { StoryDetail, StoryTask } from "./types";
import {
  STORY_FILE_PREFIX,
  normalizeAlphanumericId,
  normalizeStoryStatus,
  parseNumericStoryKey,
} from "./utils";

function normalizeStoryIdentifier(raw: string): string {
  return /[A-Za-z]/.test(raw) ? raw.toLowerCase() : raw;
}

/**
 * Strip a leading "Story 1.2:" / "Story 1.2 (part 1):" / "Story 1.2 part 3:"
 * from a title, returning the part label when one is named.
 */
export function stripStoryTitlePrefix(raw: string): { title: string; part?: string } {
  const m = raw.match(
    /^Story\s+[\w.-]+\s*(?:\(?\s*parts?\s+(\d+(?:\s*(?:,|and|&|-)\s*\d+)*)\s*\)?)?(?:\s*[:\u2014-]\s*|\s+)(.+)$/i,
  );
  if (!m) return { title: raw.trim() };
  const part = m[1]?.replace(/\s*(?:,|and|&|-)\s*/gi, "-");
  return { title: m[2].trim(), part };
}

export function parseStory(
  content: string,
  filename: string
): StoryDetail | null {
  try {
    // Try to extract ID from filename first. A "spec-" prefix (quick-spec /
    // build workflow) wraps the story key: "spec-1-2-title.md".
    const baseName = filename.replace(STORY_FILE_PREFIX, "");
    // Pattern: "N-N-title.md", "N-Nx-title.md", "N-N-part-N-title.md"
    const numericKey = parseNumericStoryKey(baseName);
    // Alphanumeric prefix: "di-1-title.md" or "hk-2-title.md"
    const alphaMatch = !numericKey && !/^story[_-]/i.test(baseName)
      ? baseName.match(/^([A-Za-z][A-Za-z0-9_-]*?)-(\d+)-/)
      : null;
    // Legacy pattern: "story-N.md" or "story_N.md"
    const legacyMatch = !numericKey && !alphaMatch
      ? baseName.match(/story[_-]?(\d+(?:[._-]\d+)?)/i)
      : null;

    let id: string;
    let epicId: string;
    let part = numericKey?.part;

    if (numericKey) {
      id = `${numericKey.epicId}.${numericKey.storyNum}`;
      epicId = numericKey.epicId;
    } else if (alphaMatch) {
      const prefix = normalizeAlphanumericId(alphaMatch[1]);
      id = `${prefix}.${alphaMatch[2]}`;
      epicId = prefix;
    } else if (legacyMatch) {
      id = legacyMatch[1].replace(/[._-]/, ".");
      epicId = id.includes(".") ? id.split(".")[0] : "";
    } else {
      id = filename.replace(/\.md$/i, "");
      epicId = "";
    }

    // Check if content has frontmatter
    const hasFrontmatter = content.trimStart().startsWith("---");
    let body: string;
    let frontmatterStatus: string | undefined;
    let frontmatterTitle: string | undefined;
    let frontmatterEpicId: string | undefined;

    if (hasFrontmatter) {
      const parsed = matter(content);
      body = parsed.content;
      frontmatterStatus = parsed.data.status || parsed.data.state;
      frontmatterTitle = parsed.data.title;
      frontmatterEpicId = parsed.data.epic_id
        ? String(parsed.data.epic_id)
        : parsed.data.epic
          ? String(parsed.data.epic)
          : undefined;
      if (parsed.data.id) id = normalizeStoryIdentifier(String(parsed.data.id));
      if (frontmatterEpicId) epicId = normalizeAlphanumericId(frontmatterEpicId);
    } else {
      body = content;
    }

    // Extract title from heading: "# Story 1.1: Title", "# Story DI.1: Title", or "# Title"
    const headingMatch = body.match(/^#\s+(.+)/m);
    const rawTitle = frontmatterTitle
      ? String(frontmatterTitle)
      : headingMatch?.[1];
    const stripped = rawTitle ? stripStoryTitlePrefix(rawTitle) : null;
    const title = stripped?.title || `Story ${id}`;
    part ??= stripped?.part;

    // Extract status from "Status: done" line (plain text, not frontmatter)
    const statusLineMatch = body.match(/^Status:\s*(.+)/im);
    const rawStatus = frontmatterStatus || statusLineMatch?.[1]?.trim();
    const statusExplicit = Boolean(rawStatus);
    const status = normalizeStoryStatus(rawStatus);

    // Extract acceptance criteria
    const acceptanceCriteria: string[] = [];
    const acSection = body.match(
      /## Acceptance Criteria\s*\n([\s\S]*?)(?=\n##|\n$|$)/i
    );
    if (acSection) {
      // Match numbered items (1. ..., 2. ...) and bullet items (- ..., * ...)
      const items = acSection[1].match(/(?:^|\n)\s*(?:\d+\.\s+|\*\*(?:Given|And|Then)\*\*|[-*]\s+)(.+)/g);
      if (items) {
        for (const item of items) {
          acceptanceCriteria.push(item.replace(/^\s*(?:\d+\.\s+|[-*]\s+)/, "").trim());
        }
      }
    }

    // Extract tasks from checkboxes
    const tasks: StoryTask[] = [];
    const taskMatches = body.matchAll(/- \[([ xX])\]\s+(.+)/g);
    for (const m of taskMatches) {
      tasks.push({
        completed: m[1].toLowerCase() === "x",
        description: m[2].trim(),
      });
    }

    return {
      id,
      title: String(title),
      status,
      statusExplicit,
      ...(part ? { part } : {}),
      epicId,
      description: body.trim().slice(0, 1000),
      acceptanceCriteria,
      tasks,
      completedTasks: tasks.filter((t) => t.completed).length,
      totalTasks: tasks.length,
    };
  } catch (e) {
    console.error(`Failed to parse story ${filename}:`, e);
    return null;
  }
}
