import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ModelTier } from "@/lib/bmad/types";
import type { AgentRunKind } from "./models";
import { formatStream, readSessionId, readStreamResult } from "./stream-format";
import { agentEnvironment } from "./environment";
import { currentBranch } from "./run-changes";

/**
 * Agent runs: Claude Code started headless in a local project's folder.
 *
 * A run is a detached shell that writes Claude's stream-json to files and
 * its exit code last, so it outlives a restart of this server. The run
 * record is a JSON file next to its output in AGENT_RUNS_DIR.
 */

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

/** "auto" lets Claude Code decide per action; "bypassPermissions" asks nothing. */
export type AgentPermissionMode = "auto" | "bypassPermissions";

export interface AgentRun {
  id: string;
  /** "owner/name" of the project in MyBMAD. */
  repoKey: string;
  userId: string;
  storyId: string;
  storyTitle: string;
  kind: AgentRunKind;
  /** Skill (or BMAD agent) the run was started with, e.g. "bmad-build-auto". */
  skill: string;
  model: ModelTier;
  /** Claude account (AGENT_CLAUDE_ACCOUNTS name); null runs as the default account. */
  account: string | null;
  /** Null on runs started before the choice existed: they ran with bypassPermissions. */
  permissionMode?: AgentPermissionMode | null;
  status: AgentRunStatus;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  costUsd: number | null;
  /** Tokens the run used, cache included; null until the run has ended. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  numTurns: number | null;
  error: string | null;
  /** A note added afterwards, e.g. that the story's work landed another way. */
  note?: string | null;
  /** The run this one answers; its log comes before this run's log. */
  parentRunId?: string | null;
  /** Paused with SIGSTOP; resumed with SIGCONT. */
  paused?: boolean;
  /** The build's own branch; null for runs that work in the checkout itself. */
  branch?: string | null;
  /** The branch the build's branch was cut from. */
  baseBranch?: string | null;
  /** The build finished but its branch is kept for the review; it merges when the review does. */
  held?: boolean;
}

/** Runs Claude Code headless; nobody is there to answer a permission prompt. */
export const DEFAULT_AGENT_COMMAND =
  "claude -p --model {model} --permission-mode {permission_mode} --output-format stream-json --verbose";

/**
 * The agent command for the steps after a run: finishing its commits and resolving conflicts. Both
 * placeholders must be filled in; an unfilled "{permission_mode}" makes Claude refuse to start, so
 * the merge then fails with a dirty or conflicted worktree.
 */
export function resolveAgentCommand(template: string, model: ModelTier, permissionMode: AgentPermissionMode): string {
  return template.replaceAll("{model}", model).replaceAll("{permission_mode}", permissionMode);
}

/**
 * Adds the time each stream-json line was written as "_ts" (UTC, to the millisecond), so the log can show
 * when it happened. Lines that are not JSON objects pass through unchanged.
 */
const STAMP_STREAM = `use Time::HiRes qw(gettimeofday); use POSIX qw(strftime); $| = 1; while (<STDIN>) { chomp; if (/^\\{.*\\}\\s*$/) { my ($s, $us) = gettimeofday(); my $at = strftime("%Y-%m-%dT%H:%M:%S", gmtime($s)) . sprintf(".%03dZ", int($us / 1000)); s/\\s*\\}\\s*$/,"_ts":"$at"}/; } print "$_\\n"; }`;

const RUN_ID = /^[0-9]{13}-[0-9a-f]{8}$/;

export function agentRunsEnabled(): boolean {
  return process.env.ENABLE_AGENT_RUNS === "true";
}

export function runsDir(): string {
  return path.resolve(process.env.AGENT_RUNS_DIR || path.join(process.cwd(), ".agent-runs"));
}

function runFile(id: string, ext: string): string {
  if (!RUN_ID.test(id)) throw new Error("Invalid run id");
  return path.join(runsDir(), `${id}.${ext}`);
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isAlive(pid: number | null): boolean {
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
/** The branch a build run works on: agent/{story}-{run id}. */
export function branchName(storyId: string, runId: string): string {
  return `agent/${storyId.replace(/[^A-Za-z0-9._-]/g, "-")}-${runId}`;
}

/**
 * Runs from before the record kept the branch: a build without a resumed
 * session always got its own branch, named after the run.
 */
function withBranch(run: AgentRun): AgentRun {
  if (run.branch !== undefined || run.kind !== "dev" || run.parentRunId) return run;
  return { ...run, branch: branchName(run.storyId, run.id), baseBranch: run.baseBranch ?? null };
}

async function refreshRun(run: AgentRun): Promise<AgentRun> {
  if (run.status !== "running") return run;

  const exitText = (await readText(runFile(run.id, "exit"))).trim();
  if (!exitText && isAlive(run.pid)) return run;

  const result = readStreamResult(await readText(runFile(run.id, "jsonl")));
  const exitCode = exitText ? Number.parseInt(exitText, 10) : null;
  // Only a build that was merged into the checkout counts as done.
  const mergeText = (await readText(runFile(run.id, "merge.txt"))).trim();
  const held = mergeText === "held";
  const merged = mergeText === "" || mergeText === "merged" || held;
  const updated: AgentRun = {
    ...run,
    endedAt: run.endedAt ?? new Date().toISOString(),
    exitCode,
    costUsd: result?.costUsd ?? null,
    inputTokens: result?.inputTokens ?? null,
    outputTokens: result?.outputTokens ?? null,
    numTurns: result?.numTurns ?? null,
  };
  if (exitCode === 0 && result && !result.isError && merged) {
    updated.status = "completed";
    updated.held = held;
  } else {
    updated.status = "failed";
    updated.error =
      (!merged ? mergeText : null) ??
      (result?.isError ? result.text : null) ??
      (exitCode === null ? "The run stopped without an exit code." : `Exit code ${exitCode}`);
  }
  await saveRun(updated);
  return updated;
}

/** How many times the conflict resolver runs before the merge gives up. */
const CONFLICT_ATTEMPTS = 3;
/** How many times a merge rebases and fast-forwards before it gives up, when the checkout moves on meanwhile. */
const MERGE_ATTEMPTS = 3;

/**
 * The prompt for the agent that resolves rebase conflicts. It runs inside the
 * story worktree while the rebase is stopped on a conflict.
 */
/**
 * The prompt for an agent that finishes a build which stopped with changes
 * left uncommitted in its worktree.
 */
export function finishPrompt(): string {
  return [
    "The build of this story stopped and left changes uncommitted in this worktree.",
    "Started from MyBMAD; nobody is watching to answer questions.",
    "",
    "- Run `git status` and `git diff` to see what was left.",
    "- If the story's work is complete (see its spec in _bmad-output/implementation-artifacts), review the changes and commit them with `git add` and `git commit`, with a clear message.",
    "- If the work is not complete, commit what is done so the state is saved, and say what is missing.",
    "- Change only what the story needs. Do not start new work and do not touch unrelated files.",
    "- Do not run `git reset`, `git checkout --`, or switch branches.",
    "",
  ].join("\n");
}

export function conflictPrompt(): string {
  return [
    "A rebase of this story branch onto the branch it was started from stops with merge conflicts.",
    "Started from MyBMAD; nobody is watching to answer questions. Resolve the conflicts yourself.",
    "",
    "- Run `git status` to see the conflicted files. You are in the worktree of the story branch, mid-rebase.",
    "- In each file, keep the intent of both sides: the other stories' changes on the base branch and this story's changes.",
    "- For sprint-status.yaml, keep every other story's status from the base branch and this story's own status.",
    "- Change only the conflicting hunks. Do not start new work and do not touch unrelated files.",
    "- `git add` each resolved file, then run `GIT_EDITOR=true git rebase --continue`. Repeat when the next commit conflicts too.",
    "- Do not run `git rebase --abort`, `git reset`, or switch branches.",
    "- If a conflict cannot be resolved without guessing, leave it as it is and say so.",
    "",
  ].join("\n");
}

/**
 * Shell helper that rebases a finished story branch onto the checkout's
 * branch and fast-forwards it in. One merge at a time, through a lock dir.
 * A rebase conflict is handed to an agent, running the resolve command in the
 * worktree; when it cannot finish the rebase, the merge is not made.
 * It writes "merged" to the result file, or the reason it did not.
 */
export function mergeScript(p: {
  checkout: string;
  worktree: string;
  branch: string;
  result: string;
  storyPrefix: string;
  /** Agent command that resolves conflicts, reading its prompt from conflictPromptFile. */
  resolveCommand: string;
  conflictPromptFile: string;
  conflictLog: string;
  /** Agent that commits what a build left uncommitted, reading finishPrompt from this file. */
  finishPromptFile?: string;
  /** Set the story's sprint status on the branch, as a build or review does. Default true. */
  setStatus?: boolean;
}): string {
  return [
    "#!/bin/sh",
    "set -u",
    `CHECKOUT=${shQuote(p.checkout)}`,
    `WORKTREE=${shQuote(p.worktree)}`,
    `BRANCH=${shQuote(p.branch)}`,
    `RESULT=${shQuote(p.result)}`,
    `PREFIX=${shQuote(p.storyPrefix)}`,
    `RESOLVE=${shQuote(p.resolveCommand)}`,
    `PROMPT=${shQuote(p.conflictPromptFile)}`,
    `CONFLICT_LOG=${shQuote(p.conflictLog)}`,
    `FINISH_PROMPT=${shQuote(p.finishPromptFile ?? "")}`,
    // Shared by every worktree of the checkout, so only one run merges at a time.
    'LOCK="$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-common-dir)/agent-merge.lock"',
    'fail() { echo "Not merged: $1" > "$RESULT"; exit 1; }',
    // A build that left changes behind gets an agent to finish and commit them, twice at most.
    'for i in 1 2; do',
    '  [ -n "$(git -C "$WORKTREE" status --porcelain)" ] || break',
    '  [ -n "$FINISH_PROMPT" ] || break',
    '  (cd "$WORKTREE" && eval "$RESOLVE") < "$FINISH_PROMPT" >> "$CONFLICT_LOG" 2>&1',
    'done',
    '[ -z "$(git -C "$WORKTREE" status --porcelain)" ] || fail "the run left uncommitted changes that the agent did not commit either."',
    'TARGET=$(git -C "$CHECKOUT" symbolic-ref --quiet --short HEAD) || fail "the main checkout is not on a branch."',
    "until mkdir \"$LOCK\" 2>/dev/null; do sleep 2; done",
    'trap \'rmdir "$LOCK"\' EXIT',
    '[ "$(git -C "$WORKTREE" rev-list --count "$TARGET..$BRANCH")" -gt 0 ] || fail "the run produced no commits."',
    // Keep sprint-status in step with the outcome: blocked when the build halted,
    // done when the spec is done, otherwise review. Committed on the story branch.
    'SPRINT="_bmad-output/implementation-artifacts/sprint-status.yaml"',
    'DIR="$WORKTREE/_bmad-output/implementation-artifacts"',
    'set_story_status() {',
    '  F="$WORKTREE/$SPRINT"; [ -f "$F" ] || return 0',
    '  KEY=$(grep -o "^  $PREFIX[a-z0-9-]*:" "$F" | head -n 1 | tr -d " :")',
    '  [ -n "$KEY" ] || return 0',
    // Only a result this run committed counts: an old blocked report must not block a later build.
    '  RES="$DIR/bmad-build-auto-result-$KEY.md"',
    '  if [ -n "$(git -C "$WORKTREE" log --format= --name-only "$TARGET..HEAD" -- "$RES")" ] && grep -q "^status: blocked" "$RES" 2>/dev/null; then NEW=blocked',
    '  elif grep -q "^status: .*done" "$DIR/spec-$KEY.md" 2>/dev/null; then NEW=done',
    '  else NEW=review; fi',
    '  sed "s/^  $KEY: .*/  $KEY: $NEW/" "$F" > "$F.tmp" && mv "$F.tmp" "$F"',
    '  git -C "$WORKTREE" add -- "$SPRINT" && { git -C "$WORKTREE" diff --cached --quiet || git -C "$WORKTREE" commit -q -m "chore: set $KEY to $NEW in sprint-status"; }',
    '}',
    ...(p.setStatus === false ? [] : ["set_story_status"]),
    // A rebase still stopped on a conflict, so the agent has work to do.
    'rebasing() { [ -d "$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-path rebase-merge)" ] || [ -d "$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-path rebase-apply)" ]; }',
    'resolve_conflicts() {',
    `  for attempt in $(seq ${CONFLICT_ATTEMPTS}); do`,
    '    rebasing || break',
    '    (cd "$WORKTREE" && eval "$RESOLVE") < "$PROMPT" >> "$CONFLICT_LOG" 2>&1',
    '  done',
    '  ! rebasing',
    '}',
    'rebase_onto_target() {',
    '  git -C "$WORKTREE" rebase -q "$TARGET" || resolve_conflicts || { git -C "$WORKTREE" rebase --abort 2>/dev/null; fail "conflict with $TARGET that the AI could not resolve."; }',
    '  git -C "$WORKTREE" merge-base --is-ancestor "$TARGET" HEAD || fail "the rebase onto $TARGET failed."',
    '}',
    // The checkout can move on while the story is rebased, so a fast-forward
    // that fails is retried on the new tip. The AI resolves any new conflicts.
    `for attempt in $(seq ${MERGE_ATTEMPTS}); do`,
    '  rebase_onto_target',
    '  git -C "$CHECKOUT" merge --ff-only -q "$BRANCH" && { merged=1; break; }',
    'done',
    '[ "${merged:-}" = 1 ] || fail "$TARGET could not be fast-forwarded (see the main checkout)."',
    'git -C "$CHECKOUT" worktree remove --force "$WORKTREE" && git -C "$CHECKOUT" branch -q -d "$BRANCH"',
    'echo merged > "$RESULT"',
    "",
  ].join("\n");
}

/**
 * Shell helper that sets the story to in-progress in the checkout's
 * sprint-status and commits only that file, before the story branch is cut,
 * so the status shows while the build runs. It leaves a sprint-status the
 * user has edited by hand alone.
 */
export function startScript(p: { checkout: string; storyPrefix: string }): string {
  return [
    "#!/bin/sh",
    "set -u",
    `CHECKOUT=${shQuote(p.checkout)}`,
    `PREFIX=${shQuote(p.storyPrefix)}`,
    // The same lock as the merge, so the status commit never races a merge.
    'LOCK="$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-common-dir)/agent-merge.lock"',
    "until mkdir \"$LOCK\" 2>/dev/null; do sleep 2; done",
    'trap \'rmdir "$LOCK"\' EXIT',
    'SPRINT="_bmad-output/implementation-artifacts/sprint-status.yaml"',
    'F="$CHECKOUT/$SPRINT"',
    '[ -f "$F" ] && git -C "$CHECKOUT" diff --quiet -- "$SPRINT" || exit 0',
    'KEY=$(grep -o "^  $PREFIX[a-z0-9-]*:" "$F" | head -n 1 | tr -d " :")',
    '[ -n "$KEY" ] || exit 0',
    'grep -q "^  $KEY: in-progress$" "$F" && exit 0',
    'sed "s/^  $KEY: .*/  $KEY: in-progress/" "$F" > "$F.tmp" && mv "$F.tmp" "$F"',
    'git -C "$CHECKOUT" commit -q -o -m "chore: set $KEY to in-progress in sprint-status" -- "$SPRINT" || git -C "$CHECKOUT" checkout -q -- "$SPRINT"',
    "",
  ].join("\n");
}

export interface StartRunInput {
  repoKey: string;
  userId: string;
  localPath: string;
  storyId: string;
  storyTitle: string;
  kind: AgentRunKind;
  skill: string;
  model: ModelTier;
  prompt: string;
  /** Run as this Claude account; null inherits the server's environment. */
  account: { name: string; configDir: string } | null;
  permissionMode: AgentPermissionMode;
  /** Wait until these runs (process ids) have exited before starting: a run one at a time. */
  waitForPids?: number[];
  /** Continue this Claude session, so the prompt is a reply in it. */
  resumeSessionId?: string;
  /** The run this reply answers. */
  parentRunId?: string;
  /** Keep a build's branch for its review instead of merging it. */
  hold?: boolean;
  /** Work on this held build's branch and worktree, instead of a new branch. */
  reuseBuild?: HeldBranch;
  /**
   * Continue an earlier run in its own record: same id, its log appended, its Claude session resumed,
   * its worktree and branch kept. A retry uses this instead of a new run.
   */
  continueRunId?: string;
}

/** A build's branch kept for its review. */
export interface HeldBranch {
  /** The build run that made the branch. */
  runId: string;
  branch: string;
  baseBranch: string | null;
}

/** The stored record of a run, for continuing it. */
async function readRecord(id: string): Promise<AgentRun> {
  if (!RUN_ID.test(id) || !existsSync(runFile(id, "json"))) throw new Error("Run not found");
  return JSON.parse(await readFile(runFile(id, "json"), "utf8")) as AgentRun;
}

export async function startRun(input: StartRunInput): Promise<AgentRun> {
  await mkdir(runsDir(), { recursive: true });
  const previous = input.continueRunId ? await readRecord(input.continueRunId) : null;
  const continuing = previous !== null;
  const id = previous?.id ?? `${Date.now()}-${randomBytes(4).toString("hex")}`;
  if (continuing) {
    // The old outcome must not count for the new attempt: refreshRun reads these files.
    for (const ext of ["exit", "merge.txt", "claude.rc"]) await rm(runFile(id, ext), { force: true });
  }
  const resumeSessionId =
    input.resumeSessionId ?? (continuing ? readSessionId(await readText(runFile(id, "jsonl"))) : null) ?? undefined;
  if (continuing && !resumeSessionId) throw new Error("This run has no session to continue.");
  const promptFile = runFile(id, "prompt.txt");
  await writeFile(promptFile, `${input.prompt}\n`, "utf8");
  // A continued run appends to its log instead of replacing it.
  const append = continuing ? ">>" : ">";

  const template = process.env.AGENT_COMMAND_TEMPLATE || DEFAULT_AGENT_COMMAND;
  const resume = resumeSessionId ? ` --resume ${shQuote(resumeSessionId)}` : "";
  const agentCommand = template
    .replaceAll("{model}", input.model)
    .replaceAll("{permission_mode}", input.permissionMode) + resume;
  // Builds, plans and reviews each work on a branch of their own, in a worktree,
  // so the checkout stays clean. A review of a held build works on that build's
  // branch. Resumed replies keep working where they ran; a continued run keeps the
  // branch and worktree it had.
  const isolated = continuing
    ? previous.branch != null
    : !resumeSessionId && existsSync(path.join(input.localPath, ".git"));
  const reuse = input.reuseBuild ?? null;
  const worktree = reuse
    ? path.join(runsDir(), `${reuse.runId}.worktree`)
    : path.join(runsDir(), `${id}.worktree`);
  const branch = reuse ? reuse.branch : branchName(input.storyId, id);
  const mergeResult = runFile(id, "merge.txt");
  // The wait is in the detached shell, so a serial run still starts after a restart of MyBMAD.
  const waitFor = (input.waitForPids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0);
  const hold = isolated && input.hold === true;
  const script = [
    ...(waitFor.length > 0
      ? [`for pid in ${waitFor.join(" ")}; do while kill -0 "$pid" 2>/dev/null; do sleep 10; done; done`]
      : []),
    ...(isolated
      ? [
          // A build sets its story in-progress first, so the branch is cut from a checkout that says so.
          ...(input.kind === "dev" && !continuing ? [`sh ${shQuote(runFile(id, "start.sh"))}`] : []),
          ...(reuse || continuing
            ? []
            : [
                `git -C ${shQuote(input.localPath)} worktree add -q -b ${shQuote(branch)} ${shQuote(worktree)} HEAD || { echo ${shQuote("Not started: no worktree for the run.")} > ${shQuote(mergeResult)}; echo 1 > ${shQuote(runFile(id, "exit"))}; exit 1; }`,
              ]),
          `cd ${shQuote(worktree)}`,
        ]
      : []),
    // Braces so a compound command template gets the redirections as a whole. Claude's exit code goes to its own
    // file, since the pipe to the stamp reports the stamp's exit code instead.
    `{ ${agentCommand}; echo $? > ${shQuote(runFile(id, "claude.rc"))}; } < ${shQuote(promptFile)} 2${append} ${shQuote(runFile(id, "stderr.log"))} | perl -e ${shQuote(STAMP_STREAM)} ${append} ${shQuote(runFile(id, "jsonl"))}`,
    isolated
      ? [
          `rc=$(cat ${shQuote(runFile(id, "claude.rc"))} 2>/dev/null || echo 1)`,
          // A held build keeps its branch for the review; its result is written, not merged.
          hold
            ? `if [ $rc -eq 0 ]; then echo held > ${shQuote(mergeResult)}; fi`
            : `if [ $rc -eq 0 ]; then sh ${shQuote(runFile(id, "merge.sh"))}; rc=$?; fi`,
          `echo $rc > ${shQuote(runFile(id, "exit"))}`,
        ].join("; ")
      : `echo $(cat ${shQuote(runFile(id, "claude.rc"))} 2>/dev/null || echo 1) > ${shQuote(runFile(id, "exit"))}`,
  ].join("; ");
  if (isolated) {
    // "3.2" becomes the sprint-status key prefix "3-2-".
    const storyPrefix = `${input.storyId.replace(/\./g, "-")}-`;
    const conflictPromptFile = runFile(id, "conflict.prompt.txt");
    await writeFile(conflictPromptFile, conflictPrompt(), "utf8");
    const finishPromptFile = runFile(id, "finish.prompt.txt");
    await writeFile(finishPromptFile, finishPrompt(), "utf8");
    await writeFile(runFile(id, "start.sh"), startScript({ checkout: input.localPath, storyPrefix }), "utf8");
    await writeFile(
      runFile(id, "merge.sh"),
      mergeScript({
        checkout: input.localPath,
        worktree,
        branch,
        result: mergeResult,
        storyPrefix,
        // A plan only writes the spec: the sprint status it sets stays as the plan left it.
        setStatus: input.kind !== "plan",
        // Resolves conflicts with the same account and model as the build, without resuming its session.
        resolveCommand: resolveAgentCommand(template, input.model, input.permissionMode),
        conflictPromptFile,
        finishPromptFile,
        conflictLog: runFile(id, "conflict.log"),
      }),
      "utf8",
    );
  }

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

  const fresh: AgentRun = {
    id,
    repoKey: input.repoKey,
    userId: input.userId,
    storyId: input.storyId,
    storyTitle: input.storyTitle,
    kind: input.kind,
    skill: input.skill,
    model: input.model,
    account: input.account?.name ?? null,
    permissionMode: input.permissionMode,
    status: "running",
    pid: child.pid ?? null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    costUsd: null,
    numTurns: null,
    error: null,
    parentRunId: input.parentRunId ?? null,
    branch: isolated ? branch : null,
    baseBranch: isolated ? (reuse?.baseBranch ?? (await currentBranch(input.localPath))) : null,
    held: hold || undefined,
  };
  // A continued run keeps its record: who started it, its parent and its branch. Only the attempt is new.
  const run: AgentRun = previous
    ? {
        ...previous,
        status: "running",
        pid: child.pid ?? null,
        startedAt: fresh.startedAt,
        endedAt: null,
        exitCode: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        numTurns: null,
        error: null,
        paused: false,
        held: fresh.held,
      }
    : fresh;
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
      runs.push(withBranch(await refreshRun(run)));
    } catch {
      // A half-written or foreign file: skip it.
    }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getRun(
  id: string,
  owner: { repoKey: string; userId: string },
): Promise<{ run: AgentRun; log: string; prompt: string; sessionId: string | null } | null> {
  if (!RUN_ID.test(id) || !existsSync(runFile(id, "json"))) return null;
  const stored = JSON.parse(await readFile(runFile(id, "json"), "utf8")) as AgentRun;
  if (stored.repoKey !== owner.repoKey || stored.userId !== owner.userId) return null;
  const run = withBranch(await refreshRun(stored));
  const jsonl = await readText(runFile(id, "jsonl"));
  const prompt = await readText(runFile(id, "prompt.txt"));
  const own = await ownLog(run, jsonl);
  // A reply shows the log of the run it answers above its own, so the conversation stays on screen.
  const earlier = run.parentRunId ? await logChain(run.parentRunId) : "";
  const answer = run.parentRunId ? `Jouw antwoord: ${prompt.trim()}` : "";
  return {
    run,
    log: [earlier, answer, own].filter(Boolean).join("\n\n"),
    prompt,
    sessionId: readSessionId(jsonl),
  };
}

/** A run's stream-json output as written, for the stage and log views. */
export async function readRunStream(id: string): Promise<string> {
  if (!RUN_ID.test(id)) return "";
  return readText(runFile(id, "jsonl"));
}

/** A run's own output, as the log shows it. */
async function ownLog(run: AgentRun, jsonl: string): Promise<string> {
  const stderr = (await readText(runFile(run.id, "stderr.log"))).trim();
  return [formatStream(jsonl, { skill: run.skill }), stderr].filter(Boolean).join("\n\n");
}

/** The log of a run and the runs it answers, oldest first. */
async function logChain(id: string): Promise<string> {
  if (!RUN_ID.test(id) || !existsSync(runFile(id, "json"))) return "";
  const stored = JSON.parse(await readFile(runFile(id, "json"), "utf8")) as AgentRun;
  const earlier = stored.parentRunId ? await logChain(stored.parentRunId) : "";
  const prompt = (await readText(runFile(id, "prompt.txt"))).trim();
  const answer = stored.parentRunId ? `Jouw antwoord: ${prompt}` : "";
  const own = await ownLog(stored, await readText(runFile(id, "jsonl")));
  return [earlier, answer, own].filter(Boolean).join("\n\n");
}

/**
 * Pause or resume a running run. The process group is stopped with SIGSTOP,
 * so Claude keeps its place and carries on at SIGCONT.
 */
export async function setRunPaused(
  id: string,
  owner: { repoKey: string; userId: string },
  paused: boolean,
): Promise<AgentRun | null> {
  const found = await getRun(id, owner);
  if (!found) return null;
  const { run } = found;
  if (run.status !== "running" || !run.pid) return run;
  try {
    process.kill(-run.pid, paused ? "SIGSTOP" : "SIGCONT");
  } catch {
    // Already gone.
  }
  const updated: AgentRun = { ...run, paused };
  await saveRun(updated);
  return updated;
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
      // A paused process only takes SIGTERM once it runs again.
      if (run.paused) process.kill(-run.pid, "SIGCONT");
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
