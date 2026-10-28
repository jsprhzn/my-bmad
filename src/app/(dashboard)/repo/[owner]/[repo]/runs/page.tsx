import { redirect, notFound } from "next/navigation";
import { AgentQuota } from "@/components/agents/agent-quota";
import { AgentRunsList } from "@/components/agents/agent-runs-list";
import { AutorunnerControl } from "@/components/agents/autorunner-control";
import { agentRunsEnabled } from "@/lib/agents/run-store";
import {
  getAuthenticatedUserId,
  getAuthenticatedRepoConfig,
} from "@/lib/db/helpers";

interface AgentsPageProps {
  params: Promise<{ owner: string; repo: string }>;
}

export default async function AgentsPage({ params }: AgentsPageProps) {
  const { owner, repo: repoName } = await params;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");

  const repoConfig = await getAuthenticatedRepoConfig(userId, owner, repoName);
  if (!repoConfig) return notFound();

  return (
    <div className="space-y-8 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground mt-1">Agent runs for this project</p>
        </div>
        {agentRunsEnabled() && repoConfig.sourceType === "local" && (
          <AgentQuota owner={owner} repo={repoName} />
        )}
      </div>
      {agentRunsEnabled() ? (
        <>
          {repoConfig.sourceType === "local" && (
            <AutorunnerControl owner={owner} repo={repoName} />
          )}
          <AgentRunsList owner={owner} repo={repoName} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Set ENABLE_AGENT_RUNS=true in .env and restart MyBMAD to run agents.
        </p>
      )}
    </div>
  );
}
