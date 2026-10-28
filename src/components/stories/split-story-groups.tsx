"use client";

import { StatusBadge } from "@/components/shared/status-badge";
import type { StoryDetail } from "@/lib/bmad/types";

interface SplitStoryGroupsProps {
  stories: StoryDetail[];
}

/**
 * A story split into subtasks (4.1 → 4.1a, 4.1b, …) shows as one group: the parent with how many
 * subtasks are done, and the subtasks indented below it.
 */
export function SplitStoryGroups({ stories }: SplitStoryGroupsProps) {
  const parents = stories.filter((story) => story.status === "split");
  if (parents.length === 0) return null;

  return (
    <div className="space-y-4">
      {parents.map((parent) => {
        const pattern = new RegExp(`^${parent.id.replace(/\./g, "\\.")}[a-z]$`);
        const subtasks = stories
          .filter((story) => pattern.test(story.id))
          .sort((a, b) => a.id.localeCompare(b.id));
        const done = subtasks.filter((story) => story.status === "done").length;

        return (
          <section key={parent.id} className="rounded-lg border border-border/60 bg-card p-4">
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium">
                <span className="font-mono text-sm text-muted-foreground">{parent.id}</span> {parent.title}
              </h3>
              <span className="text-sm text-muted-foreground">
                {done} / {subtasks.length} done
              </span>
            </header>
            <ul className="mt-3 space-y-2 border-l border-border/60 pl-4">
              {subtasks.map((story) => (
                <li key={story.id} className="flex items-center gap-3">
                  <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{story.id}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{story.title}</span>
                  <StatusBadge status={story.status} compact />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
