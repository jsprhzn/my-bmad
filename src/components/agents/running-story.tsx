"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { listRunningStoryIds } from "@/actions/agent-actions";

/** Reload the running stories this often while the page is open. */
const RUNNING_POLL_MS = 10000;

const REPO_PATH = /^\/repo\/([^/]+)\/([^/]+)/;

/**
 * Story id -> href of the run in progress for it, in the project of the current page
 * (read from /repo/{owner}/{name}). Empty outside a project page.
 */
export function useRunningStoryIds(): Map<string, string> {
  const pathname = usePathname();
  const match = pathname.match(REPO_PATH);
  const owner = match ? decodeURIComponent(match[1]) : null;
  const repo = match ? decodeURIComponent(match[2]) : null;
  const [runHrefs, setRunHrefs] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!owner || !repo) return;
    let active = true;
    const load = async () => {
      const result = await listRunningStoryIds({ owner, name: repo });
      if (!active || !result.success) return;
      setRunHrefs(
        new Map(
          result.data.map(({ storyId, runId }) => [
            storyId,
            `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/runs/${encodeURIComponent(runId)}`,
          ]),
        ),
      );
    };
    void load();
    const timer = setInterval(() => void load(), RUNNING_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [owner, repo]);

  return runHrefs;
}

/** Shown next to a story's status while an agent run works on it; links to that run when href is set. */
export function RunningBadge({ href }: { href?: string }) {
  const badge = (
    <Badge variant="outline" className="gap-1 border-info/25 bg-info/15 text-info-foreground">
      <Loader2 className="size-3 animate-spin" />
      Running
    </Badge>
  );
  if (!href) return badge;
  return (
    <Link href={href} onClick={(e) => e.stopPropagation()} className="hover:underline">
      {badge}
    </Link>
  );
}
