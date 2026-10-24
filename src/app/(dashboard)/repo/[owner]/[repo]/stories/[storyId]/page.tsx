import { redirect, notFound } from "next/navigation";
import { getCachedBmadProject } from "@/lib/bmad/cached-project";
import { getGitHubToken } from "@/lib/github/client";
import { StoryDetailView } from "@/components/epics/story-detail-view";
import {
  getAuthenticatedUserId,
  getAuthenticatedRepoConfig,
} from "@/lib/db/helpers";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { StoryAgentsCard } from "@/components/agents/story-agents-card";
import { agentRunsEnabled } from "@/lib/agents/run-store";
import { listAgentRuns } from "@/actions/agent-actions";
import { claudeAccounts } from "@/lib/agents/accounts";
import { listProjectSkills } from "@/lib/agents/project-skills";

interface StoryPageProps {
  params: Promise<{ owner: string; repo: string; storyId: string }>;
}

export default async function StoryPage({ params }: StoryPageProps) {
  const { owner, repo: repoName, storyId } = await params;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");

  const repoConfig = await getAuthenticatedRepoConfig(userId, owner, repoName);
  if (!repoConfig) return notFound();

  const isLocal = repoConfig.sourceType === "local";
  const token = isLocal ? undefined : (await getGitHubToken(userId)) ?? undefined;
  const project = await getCachedBmadProject(repoConfig, token, userId);
  if (!project) return notFound();

  const story = project.stories.find((s) => s.id === storyId);
  if (!story) return notFound();

  const storiesUrl = `/repo/${owner}/${repoName}/stories`;
  const agentsUnavailable = !isLocal
    ? "Agents run in a local project folder; this project comes from GitHub."
    : !agentRunsEnabled()
      ? "Set ENABLE_AGENT_RUNS=true in .env and restart MyBMAD to start agents from here."
      : null;
  const runsResult = agentsUnavailable
    ? null
    : await listAgentRuns({ owner, name: repoName, storyId: story.id });
  const skills =
    agentsUnavailable || !repoConfig.localPath ? [] : await listProjectSkills(repoConfig.localPath);

  return (
    <div className="space-y-8 pb-8">
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href={storiesUrl}>
            <ChevronLeft className="size-4" />
            <span className="sr-only">Back to stories</span>
          </Link>
        </Button>
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">{story.title}</h1>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center rounded-md bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">
              Story {story.id}
            </span>
            <StatusBadge status={story.status} />
            {story.epicTitle && (
              <span className="text-sm text-muted-foreground">{story.epicTitle}</span>
            )}
          </div>
        </div>
      </div>
      <StoryAgentsCard
        owner={owner}
        repo={repoName}
        storyId={story.id}
        storyStatus={story.status}
        modelAdvice={story.modelAdvice}
        unavailableReason={agentsUnavailable}
        initialRuns={runsResult?.success ? runsResult.data : []}
        accounts={claudeAccounts().map((a) => a.name)}
        skills={skills}
      />
      <StoryDetailView story={story} showHeader={false} />
    </div>
  );
}
