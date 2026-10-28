import { redirect, notFound } from "next/navigation";
import { DocumentatieView } from "@/components/docs/documentatie-view";
import {
  fetchBmadFiles,
  fetchParsedFileContent,
} from "@/actions/repo-actions";
import {
  getAuthenticatedUserId,
  getAuthenticatedRepoConfig,
} from "@/lib/db/helpers";
import type { FileTreeNode } from "@/lib/bmad/types";

interface DocumentatiePageProps {
  params: Promise<{ owner: string; repo: string }>;
}

const INDEX_SUFFIX = "implementation-artifacts/index.html";

function findIndexPath(nodes: FileTreeNode[]): string | null {
  for (const node of nodes) {
    if (node.type === "file" && node.path.endsWith(INDEX_SUFFIX)) return node.path;
    if (node.children) {
      const found = findIndexPath(node.children);
      if (found) return found;
    }
  }
  return null;
}

export default async function DocumentatiePage({ params }: DocumentatiePageProps) {
  const { owner, repo: repoName } = await params;
  const userId = await getAuthenticatedUserId();
  if (!userId) redirect("/login");

  const repoConfig = await getAuthenticatedRepoConfig(userId, owner, repoName);
  if (!repoConfig) return notFound();

  const files = await fetchBmadFiles({ owner, name: repoName });
  const indexPath = files.success ? findIndexPath(files.data.fileTree) : null;

  const page = indexPath
    ? await fetchParsedFileContent({ owner, name: repoName, path: indexPath })
    : null;

  return (
    <div className="space-y-8 pb-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Documentation</h1>
        <p className="text-muted-foreground mt-1">
          Index of all specs, per epic
        </p>
      </div>
      {page?.success ? (
        <DocumentatieView owner={owner} repo={repoName} indexPath={indexPath!} html={page.data.body} />
      ) : (
        <div
          className="flex items-center justify-center h-64 text-muted-foreground"
          role="status"
        >
          <p>
            No documentation index found. Run{" "}
            <code>python3 _bmad/scripts/build_spec_index.py</code>.
          </p>
        </div>
      )}
    </div>
  );
}
