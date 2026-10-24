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
  /** Claude accounts from AGENT_CLAUDE_ACCOUNTS. */
  accounts: string[];
  /** The account saved for this project; null means the first one. */
  current: string | null;
}

/** Which Claude account this project's agent runs use. Saved per project. */
export function ProjectAccountSelect({ owner, name, accounts, current }: ProjectAccountSelectProps) {
  const [account, setAccount] = useState(current ?? accounts[0]);
  const [pending, setPending] = useState(false);

  const change = async (value: string) => {
    const previous = account;
    setAccount(value);
    setPending(true);
    const result = await setProjectAgentAccount({ owner, name, account: value });
    if (!result.success) setAccount(previous);
    setPending(false);
  };

  return (
    <Select value={account} onValueChange={change} disabled={pending}>
      <SelectTrigger className="w-40" aria-label="Claude account for this project">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {accounts.map((accountName) => (
          <SelectItem key={accountName} value={accountName}>
            {accountName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
