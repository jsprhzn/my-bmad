"use client";

import { useEffect, useState } from "react";
import { getAgentUsage } from "@/actions/agent-actions";
import type { Quota, QuotaWindow } from "@/lib/agents/quota";

/** Reload the plan limit this often while the page is open. */
const POLL_MS = 10000;

/** The plan limit as Claude Code reports it: the session and the week, as compact chips with when each resets. */
export function AgentQuota({ owner, repo }: { owner: string; repo: string }) {
  const [quota, setQuota] = useState<Quota | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const result = await getAgentUsage({ owner, name: repo });
      if (alive && result.success) setQuota(result.data);
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [owner, repo]);

  if (!quota) return null;
  const chip = (label: string, w: QuotaWindow | null) =>
    w && (
      <span className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{w.usedPercent}%</span>
        <span className="text-muted-foreground">reset {w.resets}</span>
      </span>
    );
  return (
    <div className="flex flex-wrap gap-2">
      {chip("Sessie", quota.session)}
      {chip("Week", quota.week)}
    </div>
  );
}
