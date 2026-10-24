import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ModelTier } from "@/lib/bmad/types";
import type { AgentRunKind } from "./models";
import { formatStream, readStreamResult } from "./stream-format";
import { agentEnvironment } from "./environment";

/**
 * Agent runs: Claude Code started headless in a local project's folder.
 *
 * A run is a detached shell that writes Claude's stream-json to files and
 * its exit code last, so it outlives a restart of this server. The run
 * record is a JSON file next to its output in AGENT_RUNS_DIR.
 */

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentRun {
  id: string;
  /** "owner/name" of the project in MyBMAD. */
  repoKey: string;
  userId: string;
  storyId: string;
  storyTitle: string;
  kind: AgentRunKind;
  model: ModelTier;
  /** Claude account (AGENT_CLAUDE_ACCOUNTS name); null runs as the default account. */
  account: string | null;
  status: AgentRunStatus;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  costUsd: number | null;
  numTurns: number | null;
  error: string | null;
}

/** Runs Claude Code headless; nobody is there to answer a permission prompt. */
export const DEFAULT_AGENT_COMMAND =
  "claude -p --model {model} --permission-mode bypassPermissions --output-format stream-json --verbose";

const RUN_ID = /^[0-9]{13}-[0-9a-f]{8}$/;

export function agentRunsEnabled(): boolean {
  return process.env.ENABLE_AGENT_RUNS === "true";
}

function runsDir(): string {
  return path.resolve(process.env.AGENT_RUNS_DIR || path.join(process.cwd(), ".agent-runs"));
}

function runFile(id: string, ext: string): string {
  if (!RUN_ID.test(id)) throw new Error("Invalid run id");
  return path.join(runsDir(), `${id}.${ext}`);
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function saveRun(run: AgentRun): Promise<void> {
  await writeFile(runFile(run.id, "json"), JSON.stringify(run, null, 2), "utf8");
}

async function readText(file: string): Promise<string> {
  return existsSync(file) ? readFile(file, "utf8") : "";
}

/** Bring a running record up to date from its files and process. */
async function refreshRun(run: AgentRun): Promise<AgentRun> {
  if (run.status !== "running") return run;

  const exitText = (await readText(runFile(run.id, "exit"))).trim();
  if (!exitText && isAlive(run.pid)) return run;

  const result = readStreamResult(await readText(runFile(run.id, "jsonl")));
  const exitCode = exitText ? Number.parseInt(exitText, 10) : null;
  const updated: AgentRun = {
    ...run,
    endedAt: run.endedAt ?? new Date().toISOString(),
    exitCode,
    costUsd: result?.costUsd ?? null,
    numTurns: result?.numTurns ?? null,
  };
  if (exitCode === 0 && result && !result.isError) {
    updated.status = "completed";
  } else {
    updated.status = "failed";
    updated.error =
      (result?.isError ? result.text : null) ??
      (exitCode === null ? "The run stopped without an exit code." : `Exit code ${exitCode}`);
  }
  await saveRun(updated);
  return updated;
}

export interface StartRunInput {
  repoKey: string;
  userId: string;
  localPath: string;
  storyId: string;
  storyTitle: string;
  kind: AgentRunKind;
  model: ModelTier;
  prompt: string;
  /** Run as this Claude account; null inherits the server's environment. */
  account: { name: string; configDir: string } | null;
}

export async function startRun(input: StartRunInput): Promise<AgentRun> {
  await mkdir(runsDir(), { recursive: true });
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const promptFile = runFile(id, "prompt.txt");
  await writeFile(promptFile, `${input.prompt}\n`, "utf8");

  const template = process.env.AGENT_COMMAND_TEMPLATE || DEFAULT_AGENT_COMMAND;
  const agentCommand = template.replaceAll("{model}", input.model);
  const script = [
    // Braces so a compound command template gets the redirections as a whole.
    `{ ${agentCommand}; } < ${shQuote(promptFile)} > ${shQuote(runFile(id, "jsonl"))} 2> ${shQuote(runFile(id, "stderr.log"))}`,
    `echo $? > ${shQuote(runFile(id, "exit"))}`,
  ].join("; ");

  const child = spawn("/bin/sh", ["-c", script], {
    cwd: input.localPath,
    detached: true,
    stdio: "ignore",
    env: agentEnvironment(
      process.env,
      input.account ? { CLAUDE_CONFIG_DIR: input.account.configDir } : {},
      // Next.js types ProcessEnv with a required NODE_ENV; the agent has none.
    ) as NodeJS.ProcessEnv,
  });
  child.unref();

  const run: AgentRun = {
    id,
    repoKey: input.repoKey,
    userId: input.userId,
    storyId: input.storyId,
    storyTitle: input.storyTitle,
    kind: input.kind,
    model: input.model,
    account: input.account?.name ?? null,
    status: "running",
    pid: child.pid ?? null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    costUsd: null,
    numTurns: null,
    error: null,
  };
  await saveRun(run);
  return run;
}

/** Runs of one project for one user, newest first, optionally for one story. */
export async function listRuns(filter: {
  repoKey: string;
  userId: string;
  storyId?: string;
}): Promise<AgentRun[]> {
  if (!existsSync(runsDir())) return [];
  const files = (await readdir(runsDir())).filter((f) => /^\d{13}-[0-9a-f]{8}\.json$/.test(f));
  const runs: AgentRun[] = [];
  for (const file of files) {
    try {
      const run = JSON.parse(await readFile(path.join(runsDir(), file), "utf8")) as AgentRun;
      if (run.repoKey !== filter.repoKey || run.userId !== filter.userId) continue;
      if (filter.storyId && run.storyId !== filter.storyId) continue;
      runs.push(await refreshRun(run));
    } catch {
      // A half-written or foreign file: skip it.
    }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getRun(
  id: string,
  owner: { repoKey: string; userId: string },
): Promise<{ run: AgentRun; log: string; prompt: string } | null> {
  if (!RUN_ID.test(id) || !existsSync(runFile(id, "json"))) return null;
  const stored = JSON.parse(await readFile(runFile(id, "json"), "utf8")) as AgentRun;
  if (stored.repoKey !== owner.repoKey || stored.userId !== owner.userId) return null;
  const run = await refreshRun(stored);
  const stderr = (await readText(runFile(id, "stderr.log"))).trim();
  const log = [formatStream(await readText(runFile(id, "jsonl"))), stderr]
    .filter(Boolean)
    .join("\n\n");
  return { run, log, prompt: await readText(runFile(id, "prompt.txt")) };
}

export async function stopRun(
  id: string,
  owner: { repoKey: string; userId: string },
): Promise<AgentRun | null> {
  const found = await getRun(id, owner);
  if (!found) return null;
  const { run } = found;
  if (run.status !== "running") return run;
  if (run.pid) {
    try {
      // Detached: the shell leads its own process group, Claude included.
      process.kill(-run.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  const stopped: AgentRun = {
    ...run,
    status: "cancelled",
    endedAt: new Date().toISOString(),
  };
  await saveRun(stopped);
  return stopped;
}
