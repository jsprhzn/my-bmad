import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The environment an agent runs with: the server user's own environment,
 * without what belongs to this MyBMAD server process.
 *
 * - Variables the package manager, Next.js and Node set for this server
 *   (npm_*, NODE_OPTIONS, __NEXT_*, …). PKG_EXECPATH in particular makes
 *   pkg-built tools the agent calls (safe-chain wrapping uv, npm, pip) run
 *   as plain Node, so `uv run …` fails with "Cannot find module …/uv".
 * - Every key from MyBMAD's own .env files: database URL, auth secrets.
 */
const SERVER_VARIABLES = [
  /^npm_/i,
  /^pnpm_/i,
  /^PNPM_SCRIPT_SRC_DIR$/,
  /^INIT_CWD$/,
  /^PKG_EXECPATH$/,
  /^NODE$/,
  /^NODE_(ENV|OPTIONS|PATH|UNIQUE_ID|CHANNEL_FD)$/,
  /^__NEXT/,
  /^NEXT_/,
  /^TURBOPACK/,
  /^WATCHPACK_/,
  /^PORT$/,
];

const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"];

/** Keys defined in dotenv-style content. */
export function dotenvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function ownEnvKeys(dir: string): Set<string> {
  const keys = new Set<string>();
  for (const file of ENV_FILES) {
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    try {
      for (const key of dotenvKeys(readFileSync(full, "utf8"))) keys.add(key);
    } catch {
      // Unreadable: nothing to strip from it.
    }
  }
  return keys;
}

type Env = Record<string, string | undefined>;

export function agentEnvironment(
  source: Env = process.env,
  extra: Record<string, string> = {},
  ownKeys: Set<string> = ownEnvKeys(process.cwd()),
): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ownKeys.has(key)) continue;
    if (SERVER_VARIABLES.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
