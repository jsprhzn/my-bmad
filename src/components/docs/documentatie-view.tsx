"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fetchParsedFileContent } from "@/actions/repo-actions";

interface DocumentatieViewProps {
  owner: string;
  repo: string;
  /** Repo path of the index page; spec links are resolved against its folder. */
  indexPath: string;
  html: string;
}

export function DocumentatieView({ owner, repo, indexPath, html }: DocumentatieViewProps) {
  const folder = indexPath.slice(0, indexPath.lastIndexOf("/") + 1);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Pages opened from the index, so "Terug" can return to the one before.
  const [history, setHistory] = useState<{ html: string; title: string }[]>([]);
  const [current, setCurrent] = useState({ html, title: "Documentatie" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function onMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; href?: unknown } | null;
      if (data?.type !== "open-doc" || typeof data.href !== "string") return;
      // Only plain file names in the index folder; anything else is ignored.
      if (!/^[\w.-]+\.html$/.test(data.href)) return;

      setLoading(true);
      setError(null);
      const result = await fetchParsedFileContent({ owner, name: repo, path: folder + data.href });
      setLoading(false);
      if (!result.success) {
        setError(result.error);
        return;
      }
      setHistory((prev) => [...prev, current]);
      setCurrent({ html: result.data.body, title: data.href });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [owner, repo, folder, current]);

  function back() {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((prev) => prev.slice(0, -1));
    setCurrent(previous);
  }

  function openInBrowser() {
    // A blob URL opens the page in its own tab, outside the app.
    const url = URL.createObjectURL(new Blob([current.html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    // Give the new tab time to load before the URL is released.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {history.length > 0 && (
          <Button variant="ghost" size="sm" onClick={back}>
            <ArrowLeft className="size-4" aria-hidden="true" />
            Terug
          </Button>
        )}
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Laden" />}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="ml-auto">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={openInBrowser} aria-label="Open in browser">
                <ExternalLink className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open in browser</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <iframe
        ref={frameRef}
        title={current.title}
        srcDoc={current.html}
        // Scripts may run (the index has a filter and sends link clicks to the app),
        // but without same-origin access they cannot reach the app.
        sandbox="allow-scripts"
        className="w-full h-[80vh] rounded-lg border bg-background"
      />
    </div>
  );
}
