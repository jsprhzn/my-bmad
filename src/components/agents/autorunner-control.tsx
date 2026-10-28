"use client";

import { useEffect, useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDuration, formatTime } from "@/lib/agents/format";
import {
  listAutorunnerViews,
  setAutorunnerPaused,
  startAutorunner,
  stopAutorunner,
  type AutorunnerView,
} from "@/actions/agent-actions";
import { AutorunnerStoryRow } from "./autorunner-story";

/** Reload the queue this often while the page is open. */
const POLL_MS = 10000;

const MODE_LABELS: Record<AutorunnerView["mode"], string> = {
  serial: "Een voor een",
  parallel: "Parallel (max 3)",
};

const STATUS_LABELS: Record<AutorunnerView["status"], string> = {
  running: "draait",
  completed: "klaar",
  stopped: "gestopt",
  failed: "gestopt door een fout",
};

/** The finished queues of the project: when each started and ended, how long it ran, and what it cost. */
function RunnerHistory({ views }: { views: AutorunnerView[] }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">Laatst autorun</p>
      <ul className="space-y-1 text-muted-foreground">
        {views.map((view) => {
          const duration = Date.parse(view.endedAt ?? view.startedAt) - Date.parse(view.startedAt);
          return (
            <li key={view.id}>
              {formatTime(view.startedAt)} → {view.endedAt ? formatTime(view.endedAt) : "?"} · {formatDuration(duration)} · $
              {view.costUsd.toFixed(2)} · {view.runCount} runs · {STATUS_LABELS[view.status]}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function allPaused(view: AutorunnerView): boolean {
  return view.stories.length > 0 && view.stories.every((story) => story.paused);
}

/**
 * Start, follow and stop the autorunner for a project: it takes open stories
 * from the backlog and runs them in auto mode. Shown above the stories board
 * and above the agent runs.
 */
export function AutorunnerControl({ owner, repo }: { owner: string; repo: string }) {
  const [views, setViews] = useState<AutorunnerView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AutorunnerView["mode"]>("parallel");
  const [review, setReview] = useState(true);
  const [keepAwake, setKeepAwake] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const result = await listAutorunnerViews({ owner, name: repo });
      if (alive && result.success) {
        setViews(result.data);
        setLoaded(true);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [owner, repo]);

  const reload = async () => {
    const result = await listAutorunnerViews({ owner, name: repo });
    if (result.success) setViews(result.data);
  };

  const current = views.find((v) => v.status === "running") ?? null;
  const finished = views.filter((v) => v.status !== "running").slice(0, 1);

  const start = async () => {
    setPending(true);
    setError(null);
    const result = await startAutorunner({ owner, name: repo, mode, review, keepAwake });
    setPending(false);
    if (result.success) {
      setOpen(false);
      await reload();
    } else {
      setError(result.error);
    }
  };

  const pauseAll = async (id: string, paused: boolean) => {
    setError(null);
    const result = await setAutorunnerPaused({ owner, name: repo, id, paused });
    if (result.success) {
      await reload();
    } else {
      setError(result.error);
    }
  };

  const stop = async (id: string, now: boolean) => {
    setError(null);
    const result = await stopAutorunner({ owner, name: repo, id, now });
    if (result.success) {
      await reload();
    } else {
      setError(result.error);
    }
  };

  return (
    <div className="space-y-2">
      {current ? (
        <div className="space-y-3 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-medium">Autorunner draait · {MODE_LABELS[current.mode]}</p>
              <p className="text-muted-foreground">
                {current.done.length} klaar · {current.active.length} bezig · {current.runCount} runs uitgevoerd
                {current.waiting.length > 0 && " · wacht op token-limiet"}
                {!current.driverAlive && " · de runner lijkt te zijn onderbroken"}
              </p>
              {current.note && <p className="text-muted-foreground">{current.note}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {current.stories.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void pauseAll(current.id, !allPaused(current))}
                >
                  {allPaused(current) ? "Hervat alles" : "Pauzeer alles"}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void stop(current.id, false)}
                disabled={current.stopRequested}
              >
                {current.stopRequested ? "Stoppen…" : "Stop na huidige"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void stop(current.id, true)}
                disabled={current.stopRequested && current.active.length === 0}
              >
                Stop nu
              </Button>
            </div>
          </div>
          {current.stories.map((story) => (
            <AutorunnerStoryRow
              key={story.runId}
              owner={owner}
              repo={repo}
              story={story}
              onChanged={reload}
            />
          ))}
        </div>
      ) : loaded ? (
        <div className="flex flex-wrap items-center gap-3">
          <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Bot className="size-4" />
                Autorunner starten…
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Autorunner starten</DialogTitle>
                <DialogDescription>
                  De runner pakt zelf de volgende story uit de backlog waarvan de afhankelijkheden klaar
                  zijn, en werkt die af in auto mode. Bij een fout stopt hij; bij een token-limiet wacht
                  hij tot die weer beschikbaar is en probeert het opnieuw.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 text-sm">
                <div className="space-y-1.5">
                  <span className="font-medium">Volgorde</span>
                  <Select
                    value={mode}
                    onValueChange={(value) => setMode(value as AutorunnerView["mode"])}
                    disabled={pending}
                  >
                    <SelectTrigger className="w-56" aria-label="Volgorde van de autorunner">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(MODE_LABELS) as AutorunnerView["mode"][]).map((m) => (
                        <SelectItem key={m} value={m}>
                          {MODE_LABELS[m]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <label className="flex items-start gap-3">
                  <Checkbox
                    className="mt-0.5"
                    checked={review}
                    onCheckedChange={(checked) => setReview(checked === true)}
                    disabled={pending}
                  />
                  <span>
                    <span className="font-medium">Review na elke build</span>
                    <span className="block text-muted-foreground">
                      Een review-run die fouten zelf oplost. Kost extra tijd en tokens.
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-3">
                  <Checkbox
                    className="mt-0.5"
                    checked={keepAwake}
                    onCheckedChange={(checked) => setKeepAwake(checked === true)}
                    disabled={pending}
                  />
                  <span>
                    <span className="font-medium">Computer wakker houden</span>
                    <span className="block text-muted-foreground">
                      Voorkomt dat de Mac in slaap gaat zolang de autorunner draait. Een dichtgeklapte laptop slaapt nog steeds.
                    </span>
                  </span>
                </label>
              </div>

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                  Annuleren
                </Button>
                <Button onClick={() => void start()} disabled={pending}>
                  {pending && <Loader2 className="animate-spin" />}
                  Starten
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

        </div>
      ) : null}
      {finished.length > 0 && <RunnerHistory views={finished} />}
      {!current && error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
