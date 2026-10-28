"use client";

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function DocumentatieView({
  html,
  title,
}: {
  html: string;
  title: string;
}) {
  function openInBrowser() {
    // A blob URL opens the page in its own tab, outside the app.
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    // Give the new tab time to load before the URL is released.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={openInBrowser}
              aria-label="Open in browser"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in browser</TooltipContent>
        </Tooltip>
      </div>
      <iframe
        title={title}
        srcDoc={html}
        // Scripts may run (the index has a filter), but without same-origin
        // access they cannot reach the app.
        sandbox="allow-scripts"
        className="w-full h-[80vh] rounded-lg border bg-background"
      />
    </div>
  );
}
