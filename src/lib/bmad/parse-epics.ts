import { Epic, EpicStatus } from "./types";
import { normalizeAlphanumericId } from "./utils";

export function parseEpics(content: string): { epics: Epic[]; error?: string } {
  try {
    const epics: Epic[] = [];
    const lines = content.split("\n");

    let currentEpic: Partial<Epic> | null = null;
    let descLines: string[] = [];
    let storyIds: string[] = [];
    // Stories declared as "### Story N.M: Title" headings or "- Story N.M"
    // list items. When an epic has any, they are its story list; loose
    // "story N" mentions in prose are only a fallback for epics without them.
    let headingStoryIds: string[] = [];
    let storyTitles: Record<string, string> = {};

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      const epicMatch = line.match(
        /^##\s+(?:(?:Epic\s+)?(\d+)|Epic\s+([A-Za-z][A-Za-z0-9_/-]*))[\s:.—-]+(.+)/i
      );
      if (epicMatch) {
        if (currentEpic && currentEpic.id) {
          epics.push(
            finalizeEpic(currentEpic, descLines, storyIds, headingStoryIds, storyTitles)
          );
        }
        const rawId = epicMatch[1] ?? epicMatch[2];
        currentEpic = {
          id: epicMatch[1] ? rawId : normalizeAlphanumericId(rawId),
          title: epicMatch[3].trim(),
        };
        descLines = [];
        storyIds = [];
        headingStoryIds = [];
        storyTitles = {};
        continue;
      }

      if (currentEpic) {
        const storyHeading = line.match(
          /^#{3,4}\s+Story\s+([A-Za-z0-9_-]*\d*\.\d+[a-z]?)\s*[:.—-]\s*(.+)/i
        );
        const storyListItem = line.match(
          /^\s*[-*]\s+Story\s+([A-Za-z0-9_-]*\d*\.\d+[a-z]?)\b/i
        );
        if (storyHeading) {
          const id = storyHeading[1].toLowerCase();
          if (!headingStoryIds.includes(id)) headingStoryIds.push(id);
          storyTitles[id] = storyHeading[2].trim();
        } else if (storyListItem) {
          const id = storyListItem[1].toLowerCase();
          if (!headingStoryIds.includes(id)) headingStoryIds.push(id);
        }

        const storyRef = line.matchAll(
          /(?:story|S)[\s-]*((?:\d+(?:\.\d+[a-z]?)?)|(?:[A-Za-z][A-Za-z0-9_-]*\.\d+(?:\.\d+)?))\b/gi
        );
        for (const match of storyRef) {
          const raw = match[1];
          const id = /[A-Za-z]/.test(raw) ? raw.toLowerCase() : raw;
          if (id && !storyIds.includes(id)) {
            storyIds.push(id);
          }
        }

        // The epic's description is the text before its first story heading;
        // what follows belongs to the stories.
        if (line.trim() && !line.startsWith("#") && Object.keys(storyTitles).length === 0) {
          descLines.push(line);
        }
      }
    }

    if (currentEpic && currentEpic.id) {
      epics.push(
        finalizeEpic(currentEpic, descLines, storyIds, headingStoryIds, storyTitles)
      );
    }

    return { epics };
  } catch (e) {
    console.error("[BMAD Parse] parseEpics failed:", e);
    return { epics: [], error: e instanceof Error ? e.message : "Unknown error parsing epics" };
  }
}

function finalizeEpic(
  partial: Partial<Epic>,
  descLines: string[],
  looseStoryIds: string[],
  headingStoryIds: string[] = [],
  storyTitles: Record<string, string> = {}
): Epic {
  const storyIds = headingStoryIds.length > 0 ? headingStoryIds : looseStoryIds;
  return {
    id: partial.id || "0",
    title: partial.title || "Untitled Epic",
    description: descLines.join("\n").trim().slice(0, 500),
    status: "not-started" as EpicStatus,
    stories: storyIds,
    ...(Object.keys(storyTitles).length > 0 ? { storyTitles } : {}),
    totalStories: storyIds.length,
    completedStories: 0,
    progressPercent: 0,
  };
}
