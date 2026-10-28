"use client";

import { useState } from "react";
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
import { setProjectAgentSettings } from "@/actions/agent-actions";

interface AgentSettingsDialogProps {
  owner: string;
  name: string;
  /** Saved settings for the project. */
  autorunner: boolean;
  oneAtATime: boolean;
}

/** Project-wide agent settings: auto mode for every run, and whether runs wait for each other. */
export function AgentSettingsDialog({ owner, name, autorunner, oneAtATime }: AgentSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const [autorunnerOn, setAutorunnerOn] = useState(autorunner);
  const [oneAtATimeOn, setOneAtATimeOn] = useState(oneAtATime);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (saving) return;
    setOpen(next);
    setError(null);
    if (next) {
      setAutorunnerOn(autorunner);
      setOneAtATimeOn(oneAtATime);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await setProjectAgentSettings({
      owner,
      name,
      autorunner: autorunnerOn,
      oneAtATime: oneAtATimeOn,
    });
    setSaving(false);
    if (result.success) {
      setOpen(false);
    } else {
      setError(result.error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Bot className="size-4" />
          Agent settings…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent settings</DialogTitle>
          <DialogDescription>
            Apply to all agent runs of this project. They stay until you change them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <label className="flex items-start gap-3">
            <Checkbox
              className="mt-0.5"
              checked={autorunnerOn}
              onCheckedChange={(checked) => setAutorunnerOn(checked === true)}
              disabled={saving}
            />
            <span>
              <span className="font-medium">Autorunner</span>
              <span className="block text-muted-foreground">
                Claude beslist per actie zelf (auto mode). Uit: runs draaien zonder vragen (bypassPermissions).
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3">
            <Checkbox
              className="mt-0.5"
              checked={oneAtATimeOn}
              onCheckedChange={(checked) => setOneAtATimeOn(checked === true)}
              disabled={saving}
            />
            <span>
              <span className="font-medium">One at a time</span>
              <span className="block text-muted-foreground">
                A run waits until the other agents of this project are done. Off: runs run in parallel.
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
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
