"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, FileText, GitBranch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { ChangedFile, RunChanges } from "@/lib/agents/run-changes";
import { addedFileContent, parseUnifiedDiff } from "@/lib/agents/unified-diff";
import { getAgentRunChanges, getAgentRunFileDiff, getStoryArtifacts } from "@/actions/agent-actions";
import { fetchFileContent } from "@/actions/repo-actions";
import { MarkdownRenderer } from "@/components/docs/markdown-renderer";

/** Reload the changes this often while the run is going. */
const POLL_MS = 10000;

type Filter = "all" | ChangedFile["group"];

const FILTER_LABELS: Record<Filter, string> = { all: "Alles", code: "Code", specs: "Specs" };

const STATUS_LETTER: Record<ChangedFile["status"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-success-foreground" },
  modified: { letter: "M", className: "text-warning-foreground" },
  deleted: { letter: "D", className: "text-destructive" },
};

type Loaded = RunChanges & { branch: string | null; baseBranch: string | null; running: boolean };

/**
 * Open the already-rendered markdown in a new tab as a standalone HTML page. The app's stylesheets are copied
 * over (absolute URLs, so they still load from a blob page) and the theme class is kept.
 */
function openRenderedInBrowser(node: HTMLElement, title: string) {
  const styles = Array.from(document.querySelectorAll<HTMLElement>('style, link[rel="stylesheet"]'))
    .map((el) => (el instanceof HTMLLinkElement ? `<link rel="stylesheet" href="${el.href}">` : `<style>${el.textContent}</style>`))
    .join("");
  const page =
    `<!doctype html><html lang="nl" class="${document.documentElement.className}"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title.replace(/[<>&]/g, "")}</title>${styles}</head>` +
    `<body><main style="max-width:880px;margin:0 auto;padding:24px">${node.innerHTML}</main></body></html>`;
  const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
  // Give the new tab time to load before the URL is released.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * A new markdown file shows as rendered text, with the diff one click away. Other files, and markdown that
 * the diff only partly shows, show the diff.
 */
function FileDiffView({
  path,
  diff,
  preview,
  onPreviewChange,
}: {
  path: string;
  diff: string;
  preview: boolean;
  onPreviewChange: (preview: boolean) => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const content = path.endsWith(".md") ? addedFileContent(diff) : null;
  if (content === null) return <DiffView diff={diff} />;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant={preview ? "secondary" : "ghost"} size="sm" onClick={() => onPreviewChange(true)}>
          Voorbeeld
        </Button>
        <Button variant={preview ? "ghost" : "secondary"} size="sm" onClick={() => onPreviewChange(false)}>
          Diff
        </Button>
        {preview && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto h-8 w-8"
                aria-label="Open in browser"
                onClick={() => previewRef.current && openRenderedInBrowser(previewRef.current, path)}
              >
                <ExternalLink className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open in browser</TooltipContent>
          </Tooltip>
        )}
      </div>
      {preview ? (
        <div ref={previewRef}>
          <MarkdownRenderer content={content} filePath={path} />
        </div>
      ) : (
        <DiffView diff={diff} />
      )}
    </div>
  );
}

/** A diff as readable hunks: line numbers in gutters, +/− rows, wrapped text. */
function DiffView({ diff }: { diff: string }) {
  const hunks = parseUnifiedDiff(diff);
  if (hunks.length === 0) {
    return <p className="whitespace-pre-wrap text-muted-foreground">{diff}</p>;
  }
  const added = hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "add").length;
  const removed = hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === "del").length;

  return (
    <div className="space-y-3">
      <p className="font-mono text-xs">
        <span className="text-success-foreground">+{added}</span>{" "}
        <span className="text-destructive">−{removed}</span>
        <span className="text-muted-foreground"> in {hunks.length} {hunks.length === 1 ? "blok" : "blokken"}</span>
      </p>
      {hunks.map((hunk, index) => {
        const from = hunk.lines.find((line) => line.newNumber !== null)?.newNumber;
        const to = [...hunk.lines].reverse().find((line) => line.newNumber !== null)?.newNumber;
        const range =
          from == null || to == null
            ? "verwijderd"
            : from === to
              ? `regel ${from}`
              : `regels ${from}–${to}`;
        return (
          <section key={index} className="overflow-hidden rounded-md border">
            <header className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{range}</span>
              {hunk.context && <span className="truncate font-mono">{hunk.context}</span>}
            </header>
            <div className="overflow-x-auto font-mono text-xs leading-relaxed">
              {hunk.lines.map((line, lineIndex) => (
                <div
                  // A hunk never reorders its lines, so the position is a stable key.
                  key={lineIndex}
                  className={cn(
                    "grid grid-cols-[2.5rem_2.5rem_1rem_1fr] gap-x-1 px-1",
                    line.kind === "add" && "bg-success/15 text-success-foreground",
                    line.kind === "del" && "bg-destructive/10 text-destructive",
                  )}
                >
                  <span className="select-none text-right text-muted-foreground/70">{line.oldNumber ?? ""}</span>
                  <span className="select-none text-right text-muted-foreground/70">{line.newNumber ?? ""}</span>
                  <span className="select-none text-center">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">{line.text || " "}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The context of a run, opened from the right: the files its branch changed,
 * the story's artifacts, and the diff of a changed file. The changes keep
 * updating while the run goes.
 */
export function RunChangesSheet({
  owner,
  repo,
  runId,
  storyNumber,
  title,
  open,
  onOpenChange,
}: {
  owner: string;
  repo: string;
  runId: string | null;
  /** The story's number, e.g. "11.1"; its artifacts are listed when given. */
  storyNumber?: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [preview, setPreview] = useState(true);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [artifact, setArtifact] = useState<{ path: string; content: string | null } | null>(null);

  useEffect(() => {
    if (!open || !storyNumber) return;
    let alive = true;
    void getStoryArtifacts({ owner, name: repo, storyNumber }).then((result) => {
      if (alive && result.success) setArtifacts(result.data);
    });
    return () => {
      alive = false;
    };
  }, [open, owner, repo, storyNumber]);

  const openArtifact = async (path: string) => {
    setArtifact({ path, content: null });
    const result = await fetchFileContent({ owner, name: repo, path });
    setArtifact({ path, content: result.success ? result.data.content : result.error });
  };

  useEffect(() => {
    if (!open || !runId) return;
    let alive = true;
    const load = async () => {
      const result = await getAgentRunChanges({ owner, name: repo, runId });
      if (!alive) return;
      if (result.success) {
        setLoaded(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, owner, repo, runId]);

  const openFile = async (path: string) => {
    if (!runId) return;
    setSelected(path);
    setDiff(null);
    setDiffLoading(true);
    const result = await getAgentRunFileDiff({ owner, name: repo, runId, path });
    setDiffLoading(false);
    if (result.success) {
      setDiff(result.data ?? "Geen diff beschikbaar.");
    } else {
      setDiff(result.error);
    }
  };

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setSelected(null);
      setDiff(null);
      setArtifact(null);
    }
  };

  const files = loaded?.state === "ready" ? loaded.files.filter((f) => filter === "all" || f.group === filter) : [];
  const counts = (group: ChangedFile["group"]) =>
    loaded?.state === "ready" ? loaded.files.filter((f) => f.group === group).length : 0;

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl lg:max-w-5xl">
        <SheetHeader>
          <SheetTitle>Context</SheetTitle>
          <SheetDescription className="truncate">{title}</SheetDescription>
          {loaded?.branch && (
            <p className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {loaded.branch}
                {loaded.baseBranch && ` → ${loaded.baseBranch}`}
              </span>
            </p>
          )}
        </SheetHeader>

        <div className="space-y-3 px-4 pb-6 text-sm">
          {error && (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          )}

          {artifact === null && !loaded && !error && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Wijzigingen laden…
            </p>
          )}

          {artifact === null && loaded?.state === "no-branch" && (
            <p className="text-muted-foreground">
              Deze run werkt in de hoofdwerkboom en heeft geen eigen branch. Er is dus geen aparte lijst van wijzigingen.
            </p>
          )}

          {artifact === null && loaded?.state === "merged" && (
            <p className="text-muted-foreground">
              De branch is samengevoegd en opgeruimd. De wijzigingen staan nu in de basisbranch.
            </p>
          )}

          {artifact === null && loaded?.state === "ready" && selected === null && (
            <>
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Wijzigingen</h3>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(FILTER_LABELS) as Filter[]).map((key) => {
                  const count = key === "all" ? loaded.files.length : counts(key);
                  return (
                    <Button
                      key={key}
                      variant={filter === key ? "secondary" : "outline"}
                      size="sm"
                      onClick={() => setFilter(key)}
                    >
                      {FILTER_LABELS[key]} {count}
                    </Button>
                  );
                })}
              </div>

              {files.length === 0 ? (
                <p className="text-muted-foreground">Nog geen wijzigingen op de branch.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {files.map((file) => (
                    <li key={file.path} className="flex items-center">
                      <button
                        type="button"
                        onClick={() => void openFile(file.path)}
                        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
                      >
                        <span className={cn("w-3 shrink-0 font-mono text-xs font-medium", STATUS_LETTER[file.status].className)}>
                          {STATUS_LETTER[file.status].letter}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {file.additions === null ? "binair" : `+${file.additions} −${file.deletions}`}
                        </span>
                      </button>
                      {file.path.endsWith(".md") && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="mr-1 h-7 w-7 shrink-0"
                              aria-label="Open as HTML"
                              onClick={() => void openFile(file.path)}
                            >
                              <ExternalLink className="size-3.5" aria-hidden="true" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Open as HTML</TooltipContent>
                        </Tooltip>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {artifact === null && selected === null && artifacts.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Artifacts</h3>
              <ul className="divide-y rounded-md border">
                {artifacts.map((path) => (
                  <li key={path}>
                    <button
                      type="button"
                      onClick={() => void openArtifact(path)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{path.split("/").pop()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {artifact && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setArtifact(null)}>
                <ArrowLeft className="size-4" aria-hidden="true" />
                Terug
              </Button>
              <p className="font-mono text-xs break-all">{artifact.path}</p>
              {artifact.content === null ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Laden…
                </p>
              ) : artifact.path.endsWith(".md") ? (
                <MarkdownRenderer content={artifact.content} filePath={artifact.path} />
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-xs">{artifact.content}</pre>
              )}
            </>
          )}

          {artifact === null && selected !== null && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                <ArrowLeft className="size-4" aria-hidden="true" />
                Terug naar bestanden
              </Button>
              <p className="font-mono text-xs break-all">{selected}</p>
              {diffLoading ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Diff laden…
                </p>
              ) : (
                diff && <FileDiffView path={selected} diff={diff} preview={preview} onPreviewChange={setPreview} />
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
