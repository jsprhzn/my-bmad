/**
 * Turns Claude Code's `--output-format stream-json` events into a readable
 * log, and pulls the run result (cost, turns, error) out of them.
 */

interface StreamEvent {
  type?: string;
  subtype?: string;
  model?: string;
  session_id?: string;
  skills?: string[];
  is_error?: boolean;
  num_turns?: number;
  result?: string;
  total_cost_usd?: number;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      is_error?: boolean;
    }>;
  };
}

export interface AgentRunResult {
  isError: boolean;
  numTurns: number;
  costUsd: number;
  text: string;
}

const MAX_TOOL_SUMMARY = 160;

function parseEvent(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of ["skill", "command", "file_path", "pattern", "url", "description", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const oneLine = value.replace(/\s+/g, " ").trim();
      return oneLine.length > MAX_TOOL_SUMMARY
        ? `${oneLine.slice(0, MAX_TOOL_SUMMARY)}…`
        : oneLine;
    }
  }
  return "";
}

export interface FormatOptions {
  /** The skill the run was started with, checked against the skills Claude loaded. */
  skill?: string;
}

/** Format one line; non-JSON lines pass through unchanged. */
export function formatStreamLine(line: string, options: FormatOptions = {}): string[] {
  const event = parseEvent(line);
  if (!event) return line.trim() ? [line] : [];

  switch (event.type) {
    case "system": {
      if (event.subtype !== "init") return [];
      const out = [`[claude] session ${event.session_id ?? "?"} · model ${event.model ?? "?"}`];
      if (options.skill && event.skills) {
        out.push(
          event.skills.includes(options.skill)
            ? `[claude] ✓ /${options.skill} found; the run starts with it`
            : `[claude] ✗ /${options.skill} is not among the ${event.skills.length} skills Claude loaded in this folder`,
        );
      }
      return out;
    }
    case "assistant": {
      const out: string[] = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          out.push(block.text.trim());
        } else if (block.type === "tool_use") {
          const summary = summarizeToolInput(block.input);
          out.push(`→ ${block.name ?? "tool"}${summary ? ` ${summary}` : ""}`);
        }
      }
      return out;
    }
    case "user":
      return (event.message?.content ?? []).some((b) => b.type === "tool_result" && b.is_error)
        ? ["  ✗ tool error"]
        : [];
    case "result":
      return [
        `[claude] ${event.is_error ? "failed" : "done"} after ${event.num_turns ?? 0} turns · $${(event.total_cost_usd ?? 0).toFixed(4)}`,
      ];
    default:
      return [];
  }
}

export function formatStream(content: string, options: FormatOptions = {}): string {
  return content
    .split(/\r?\n/)
    .flatMap((line) => formatStreamLine(line, options))
    .join("\n");
}

/** The final result event of a run, if it has ended. */
export function readStreamResult(content: string): AgentRunResult | null {
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = parseEvent(lines[i]);
    if (event?.type === "result") {
      return {
        isError: event.is_error === true,
        numTurns: event.num_turns ?? 0,
        costUsd: event.total_cost_usd ?? 0,
        text: event.result?.trim() ?? "",
      };
    }
  }
  return null;
}
