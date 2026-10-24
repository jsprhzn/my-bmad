import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentRunView } from "@/components/agents/agent-run-view";
import { getAgentRun } from "@/actions/agent-actions";
import { getAuthenticatedUserId } from "@/lib/db/helpers";
import { AGENT_RUN_LABELS } from "@/lib/agents/models";

interface RunPageProps {
  params: Promise<{ owner: string; repo: string; runId: string }>;
}

export default async function AgentRunPage({ params }: RunPageProps) {
  const { owner, repo, runId } = await params;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");

  const result = await getAgentRun({ owner, name: repo, runId });
  if (!result.success) return notFound();
  const { run } = result.data;

  return (
    <div className="space-y-8 pb-8">
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/repo/${owner}/${repo}/stories/${encodeURIComponent(run.storyId)}`}>
            <ChevronLeft className="size-4" />
            <span className="sr-only">Back to story</span>
          </Link>
        </Button>
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">
            {AGENT_RUN_LABELS[run.kind]} run · {run.model}
          </h1>
          <p className="text-sm text-muted-foreground">
            Story {run.storyId}: {run.storyTitle}
          </p>
        </div>
      </div>
      <AgentRunView owner={owner} repo={repo} initial={result.data} />
    </div>
  );
}
