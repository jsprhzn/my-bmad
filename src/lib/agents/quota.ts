import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The account's plan limits as Claude Code reports them: `/usage` in print
 * mode prints the current session and this week's share of the limit, with
 * the time each one resets. It costs no tokens.
 */
export interface QuotaWindow {
  /** Share of the limit used, 0 to 100. */
  usedPercent: number;
  /** When the window resets, as Claude Code writes it, e.g. "Oct 28 at 7:30pm". */
  resets: string;
}

export interface Quota {
  /** The five-hour session window. */
  session: QuotaWindow | null;
  /** The weekly window across all models. */
  week: QuotaWindow | null;
  checkedAt: string;
}

const SESSION = /Current session: (\d+)% used · resets ([^\n(]+?)\s*\(/;
const WEEK = /Current week \(all models\): (\d+)% used · resets ([^\n(]+?)\s*\(/;
/** A reading is good for a minute: the queue ticks every few seconds. */
const CACHE_MS = 60 * 1000;
const run = promisify(execFile);
let cached: { dir: string | undefined; at: number; quota: Quota } | null = null;

/** The quota from `/usage` output. Windows that are not in the text are null. */
export function parseQuota(text: string, checkedAt: Date = new Date()): Quota {
  const window = (pattern: RegExp): QuotaWindow | null => {
    const match = text.match(pattern);
    return match ? { usedPercent: Number(match[1]), resets: match[2].trim() } : null;
  };
  return {
    session: window(SESSION),
    week: window(WEEK),
    checkedAt: checkedAt.toISOString(),
  };
}

/** The quota of the account whose config folder is given (the default account when none). */
export async function readQuota(configDir?: string): Promise<Quota | null> {
  if (cached && cached.dir === configDir && Date.now() - cached.at < CACHE_MS) return cached.quota;
  try {
    const { stdout } = await run("claude", ["-p", "/usage", "--output-format", "json"], {
      env: configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env,
      timeout: 60_000,
    });
    const result = (JSON.parse(stdout) as { result?: string }).result ?? "";
    const quota = parseQuota(result);
    if (!quota.session && !quota.week) return null;
    cached = { dir: configDir, at: Date.now(), quota };
    return quota;
  } catch {
    return null;
  }
}

/** The fuller of the two windows as a share of the limit, 0 to 1; null when Claude reports neither. */
export function quotaLoad(quota: Quota | null): number | null {
  const shares = [quota?.session, quota?.week]
    .filter((w): w is QuotaWindow => w !== null && w !== undefined)
    .map((w) => w.usedPercent / 100);
  return shares.length > 0 ? Math.max(...shares) : null;
}

/**
 * How many runs may be in flight at the current load: the full allowance
 * below 60%, two from 60%, and none from 100% until the window resets.
 */
export function allowanceFor(load: number | null, allowance: number): number {
  if (load === null || load < 0.6) return allowance;
  if (load < 1) return Math.min(allowance, 2);
  return 0;
}
