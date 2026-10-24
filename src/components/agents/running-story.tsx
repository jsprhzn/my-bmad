"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { listRunningStoryIds } from "@/actions/agent-actions";

/** Reload the running stories this often while the page is open. */
const RUNNING_POLL_MS = 10000;

const REPO_PATH = /^\/repo\/([^/]+)\/([^/]+)/;

/**
 * Story ids with an agent run in progress in the project of the current page
 * (read from /repo/{owner}/{name}). Empty outside a project page.
 */
export function useRunningStoryIds(): Set<string> {
  const pathname = usePathname();
  const match = pathname.match(REPO_PATH);
  const owner = match ? decodeURIComponent(match[1]) : null;
  const repo = match ? decodeURIComponent(match[2]) : null;
  const [ids, setIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!owner || !repo) return;
    let active = true;
    const load = async () => {
      const result = await listRunningStoryIds({ owner, name: repo });
      if (active && result.success) setIds(new Set(result.data));
    };
    void load();
    const timer = setInterval(() => void load(), RUNNING_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [owner, repo]);

  return ids;
}

/** Shown next to a story's status while an agent run works on it. */
export function RunningBadge() {
  return (
    <Badge variant="outline" className="gap-1 border-info/25 bg-info/15 text-info-foreground">
      <Loader2 className="size-3 animate-spin" />
      Running
    </Badge>
  );
}
