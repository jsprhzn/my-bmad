import os from "node:os";
import path from "node:path";

/**
 * Claude accounts agents can run as. Claude Code keeps each account in its
 * own config folder (CLAUDE_CONFIG_DIR); its sign-in is stored per folder.
 *
 * AGENT_CLAUDE_ACCOUNTS="work=~/.claude,personal=~/.claude-personal"
 *
 * Unset: runs inherit the server's environment (Claude's default account).
 */
export interface ClaudeAccount {
  name: string;
  configDir: string;
}

function expandHome(dir: string): string {
  return dir === "~" || dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(1)) : dir;
}

export function parseClaudeAccounts(raw: string | undefined): ClaudeAccount[] {
  if (!raw?.trim()) return [];
  const accounts: ClaudeAccount[] = [];
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq).trim();
    const dir = entry.slice(eq + 1).trim();
    if (!/^[\w.-]{1,40}$/.test(name) || !dir) continue;
    if (accounts.some((a) => a.name === name)) continue;
    accounts.push({ name, configDir: path.resolve(expandHome(dir)) });
  }
  return accounts;
}

export function claudeAccounts(): ClaudeAccount[] {
  return parseClaudeAccounts(process.env.AGENT_CLAUDE_ACCOUNTS);
}

/** The named account, or the first one when no name is given. */
export function findClaudeAccount(name?: string): ClaudeAccount | null {
  const accounts = claudeAccounts();
  if (!name) return accounts[0] ?? null;
  return accounts.find((a) => a.name === name) ?? null;
}
