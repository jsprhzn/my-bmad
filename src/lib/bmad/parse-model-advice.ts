import { ModelAdviceRow, ModelTier, StoryDetail } from "./types";

/** Files that hold a per-story model table, e.g. "story-complexity.md". */
export const MODEL_ADVICE_FILE = /(?:^|\/)[^/]*(?:complexity|model-routing)[^/]*\.md$/i;

const TIERS: ModelTier[] = ["haiku", "sonnet", "opus"];

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function findColumn(headers: string[], pattern: RegExp): number {
  return headers.findIndex((h) => pattern.test(h));
}

export function parseModelTiers(model: string): ModelTier[] {
  const found = TIERS.map((tier) => ({
    tier,
    at: model.toLowerCase().indexOf(tier),
  })).filter((t) => t.at >= 0);
  return found.sort((a, b) => a.at - b.at).map((t) => t.tier);
}

/**
 * Parse markdown tables with a "Story" and a "Model" column into rows keyed
 * by story id. Other tables in the file are ignored.
 */
export function parseModelAdvice(content: string): Map<string, ModelAdviceRow> {
  const rows = new Map<string, ModelAdviceRow>();
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length - 1; i++) {
    const headers = splitRow(lines[i]);
    const separator = splitRow(lines[i + 1]);
    if (!headers || !separator || !separator.every((c) => /^:?-+:?$/.test(c))) {
      continue;
    }

    const storyCol = findColumn(headers, /^(?:story|id|story id)$/i);
    // "Model" is the build model; "Dev model" / "Build model" names it explicitly.
    const devCol = findColumn(headers, /^(?:dev|build)(?:\s+model)?$/i);
    const modelCol = devCol >= 0 ? devCol : findColumn(headers, /^model/i);
    const planCol = findColumn(headers, /^plan(?:ning)?(?:\s+model)?$/i);
    const reviewCol = findColumn(headers, /^review(?:\s+model)?$/i);
    if (storyCol < 0 || modelCol < 0) continue;
    const titleCol = findColumn(headers, /^(?:title|name)$/i);
    const complexityCol = findColumn(headers, /^(?:cx|complexity|size)$/i);
    const reasonCol = findColumn(headers, /^(?:reason|why|rationale|notes?)$/i);

    let j = i + 2;
    for (; j < lines.length; j++) {
      const cells = splitRow(lines[j]);
      if (!cells) break;
      const id = cells[storyCol]?.replace(/^(?:story\s+|s)/i, "").toLowerCase();
      const model = cells[modelCol];
      if (!id || !model) continue;
      const planModel = planCol >= 0 ? cells[planCol] || undefined : undefined;
      const reviewModel = reviewCol >= 0 ? cells[reviewCol] || undefined : undefined;
      rows.set(id, {
        id,
        title: titleCol >= 0 ? cells[titleCol] || undefined : undefined,
        complexity: complexityCol >= 0 ? cells[complexityCol] || undefined : undefined,
        model,
        tiers: parseModelTiers(model),
        reason: reasonCol >= 0 ? cells[reasonCol] || undefined : undefined,
        ...(planModel ? { planModel, planTiers: parseModelTiers(planModel) } : {}),
        ...(reviewModel ? { reviewModel, reviewTiers: parseModelTiers(reviewModel) } : {}),
      });
    }
    i = j - 1;
  }

  return rows;
}

/**
 * Attach model advice to stories. A row whose id is a letter variant of a
 * story ("1.2a" for story 1.2) and is not a story itself becomes a part of
 * that story's advice.
 */
export function attachModelAdvice(
  stories: StoryDetail[],
  rows: Map<string, ModelAdviceRow>,
): StoryDetail[] {
  if (rows.size === 0) return stories;
  const storyIds = new Set(stories.map((s) => s.id));
  const partsByStory = new Map<string, ModelAdviceRow[]>();
  for (const row of rows.values()) {
    const variant = row.id.match(/^(.+\.\d+)[a-z]$/);
    if (!variant || storyIds.has(row.id) || !storyIds.has(variant[1])) continue;
    const parts = partsByStory.get(variant[1]) ?? [];
    parts.push(row);
    partsByStory.set(variant[1], parts);
  }

  return stories.map((story) => {
    const row = rows.get(story.id);
    const parts = partsByStory.get(story.id);
    if (!row && !parts) return story;
    const base = row ?? {
      id: story.id,
      model: parts!.map((p) => p.model).join(" · "),
      tiers: [...new Set(parts!.flatMap((p) => p.tiers))],
    };
    return { ...story, modelAdvice: parts ? { ...base, parts } : base };
  });
}
