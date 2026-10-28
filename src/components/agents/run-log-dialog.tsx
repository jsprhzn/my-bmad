"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAgentRun } from "@/actions/agent-actions";
import { RunLog } from "./run-log";

/** The full log of one run, read when the dialog opens. */
export function RunLogDialog({
  owner,
  repo,
  runId,
  title,
  open,
  onOpenChange,
}: {
  owner: string;
  repo: string;
  runId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      const result = await getAgentRun({ owner, name: repo, runId });
      if (!alive) return;
      if (result.success) {
        setLog(result.data.log);
        setError(null);
      } else {
        setError(result.error);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [open, owner, repo, runId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-[95vw] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Full log</DialogTitle>
          <DialogDescription className="truncate">{title}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : log === null ? (
          <p className="text-sm text-muted-foreground">Laden…</p>
        ) : (
          <RunLog log={log} emptyText="No output." />
        )}
      </DialogContent>
    </Dialog>
  );
}
