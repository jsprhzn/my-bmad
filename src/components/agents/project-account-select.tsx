"use client";

import { useState } from "react";
import { setProjectAgentAccount } from "@/actions/agent-actions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ProjectAccountSelectProps {
  owner: string;
  name: string;
  /** Claude accounts from AGENT_CLAUDE_ACCOUNTS, with the config folder each one signs in with. */
  accounts: { name: string; configDir: string }[];
  /** The account saved for this project; null means the first one. */
  current: string | null;
}

/** Which Claude account (and config folder) this project's agent runs use. Saved per project. */
export function ProjectAccountSelect({ owner, name, accounts, current }: ProjectAccountSelectProps) {
  const [account, setAccount] = useState(current ?? accounts[0]?.name);
  const [pending, setPending] = useState(false);
  const folder = accounts.find((a) => a.name === account)?.configDir;

  const change = async (value: string) => {
    const previous = account;
    setAccount(value);
    setPending(true);
    const result = await setProjectAgentAccount({ owner, name, account: value });
    if (!result.success) setAccount(previous);
    setPending(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>Claude account for agent runs</span>
      <Select value={account} onValueChange={change} disabled={pending}>
        <SelectTrigger className="w-40" aria-label="Claude account for agent runs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((a) => (
            <SelectItem key={a.name} value={a.name}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {folder && (
        <span className="max-w-md truncate font-mono text-xs" title={folder}>
          {folder}
        </span>
      )}
    </div>
  );
}
