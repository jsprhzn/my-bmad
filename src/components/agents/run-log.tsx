"use client";

import ReactMarkdown from "react-markdown";

/** The agent's own message: its first line, with the lines under it folded. */
export interface MessageBlock {
  kind: "message";
  summary: string;
  details: string;
}

/** Consecutive tool calls, folded into one pane between messages. */
export interface ToolBlock {
  kind: "tools";
  lines: string[];
}

export type LogBlock = MessageBlock | ToolBlock;

const LIST_MARKER = /^([-*]|\d+\.)\s/;
/** A tool call the agent made, written by formatStream as "→ tool summary". */
const TOOL_CALL = /^→ /;

/**
 * Splits a formatted run log into blocks. A line at the left margin that is
 * not a list item or tool call starts a message. Indented and list lines
 * belong to the message above them. Tool calls form their own blocks.
 */
export function splitLog(log: string): LogBlock[] {
  const blocks: LogBlock[] = [];
  for (const line of log.split("\n")) {
    const last = blocks[blocks.length - 1];
    if (line.trim() === "") {
      if (last?.kind === "message") last.details += "\n";
      continue;
    }
    if (TOOL_CALL.test(line)) {
      if (last?.kind === "tools") last.lines.push(line);
      else blocks.push({ kind: "tools", lines: [line] });
      continue;
    }
    const isDetail = /^\s/.test(line) || LIST_MARKER.test(line);
    if (isDetail && last?.kind === "message") {
      last.details += `\n${line}`;
    } else {
      blocks.push({ kind: "message", summary: line, details: "" });
    }
  }
  return blocks.map((block) =>
    block.kind === "message" ? { ...block, details: block.details.trim() } : block,
  );
}

const MARKDOWN_CLASS =
  "break-words [&_p]:m-0 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_code]:font-mono [&_code]:text-[0.9em]";

/** What a message says, so the log can mark it: the answer you sent, a failure, a success, or agent status. */
type Tone = "agent" | "user" | "error" | "success" | "status";

const TONE_CLASS: Record<Tone, string> = {
  agent: "border-transparent text-foreground",
  user: "border-violet-400 bg-violet-500/10 text-violet-200",
  error: "border-red-500 bg-red-500/10 text-red-300",
  success: "border-emerald-500 text-emerald-300",
  status: "border-transparent text-muted-foreground",
};

function toneOf(summary: string): Tone {
  if (summary.startsWith("Jouw antwoord:")) return "user";
  if (/tool error|^✗|^×|\berror\b|mislukt|niet gelukt|failed/i.test(summary)) return "error";
  if (/^\[claude\] (done|✓)|\bklaar\b|\bgeslaagd\b|\bdone\b/i.test(summary)) return "success";
  if (summary.startsWith("[claude]")) return "status";
  return "agent";
}

/** A numbered option the agent offers, e.g. "1. **Title** rest of the text". */
interface Option {
  number: string;
  lead: string | null;
  text: string;
}

const OPTION_LINE = /^(\d+)\.\s+(.*)$/;
const OPTION_LEAD = /^\*\*(.+?)\*\*\s*(.*)$/;

/** The numbered options in a message's details, with indented lines folded into their option. */
function optionsOf(details: string): Option[] {
  const options: { number: string; text: string }[] = [];
  for (const line of details.split("\n")) {
    const match = OPTION_LINE.exec(line);
    if (match) options.push({ number: match[1], text: match[2] });
    else if (/^\s+\S/.test(line) && options.length > 0) {
      options[options.length - 1].text += ` ${line.trim()}`;
    }
  }
  if (options.length < 2) return [];
  return options.map(({ number, text }) => {
    const lead = OPTION_LEAD.exec(text);
    return lead ? { number, lead: lead[1], text: lead[2] } : { number, lead: null, text };
  });
}

function OptionCard({
  option,
  chosen,
  onChoose,
}: {
  option: Option;
  /** The option that was sent as the answer. */
  chosen: boolean;
  /** Undefined once an answer was sent, so the other options stay unclickable. */
  onChoose?: (answer: string) => void;
}) {
  const label = option.lead ?? option.text;
  const content = (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sky-500/15 font-mono text-xs text-sky-300">
        {option.number}
      </span>
      <span className="min-w-0 text-left">
        {option.lead && <span className="block font-medium text-foreground">{option.lead}</span>}
        <span className="block text-muted-foreground">{option.text}</span>
      </span>
    </>
  );
  const className = `flex w-full items-start gap-3 rounded-lg border p-3 text-left font-sans text-sm leading-relaxed ${
    chosen ? "border-sky-500/60 bg-sky-500/10" : "border-border/60 bg-muted/20"
  }`;
  if (!onChoose) return <div className={className}>{content}</div>;
  return (
    <button
      type="button"
      onClick={() => onChoose(`Optie ${option.number}: ${label}`)}
      className={`${className} cursor-pointer transition-colors hover:border-sky-500/60 hover:bg-sky-500/10`}
    >
      {content}
    </button>
  );
}

function MessageView({
  block,
  chosen,
  onChoose,
}: {
  block: MessageBlock;
  /** The option number sent as the answer to these options, if any. */
  chosen?: string;
  onChoose?: (answer: string) => void;
}) {
  const tone = toneOf(block.summary);
  const options = optionsOf(block.details);

  return (
    <li className={`border-l-2 py-2 pl-3 ${TONE_CLASS[tone]}`}>
      <div className="flex gap-2">
        {tone === "agent" && (
          <span aria-hidden="true" className="shrink-0 text-sky-400">
            ⏺
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className={MARKDOWN_CLASS}>
            <ReactMarkdown>{block.summary}</ReactMarkdown>
          </div>
          {options.length > 0 ? (
            <div className="mt-2 flex flex-col gap-2">
              {options.map((option) => (
                <OptionCard
                  key={option.number}
                  option={option}
                  chosen={option.number === chosen}
                  onChoose={onChoose}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** A run's log: only the agent's headline messages; tool calls and details are left out. */
export function RunLog({
  log,
  emptyText,
  onChoose,
}: {
  log: string;
  emptyText: string;
  /** Sends the option picked as the answer; omitted while the run is still going. */
  onChoose?: (answer: string) => void;
}) {
  const blocks = splitLog(log);
  if (blocks.length === 0) {
    return <p className="font-mono text-xs text-muted-foreground">{emptyText}</p>;
  }
  // Each answer you sent follows the options it answers; options with an answer after them are closed.
  const answers = blocks.flatMap((block, index) =>
    block.kind === "message" && block.summary.startsWith("Jouw antwoord:") ? [index] : [],
  );
  const lastAnswer = answers.at(-1) ?? -1;
  return (
    <ul className="divide-y divide-border/40 font-mono text-xs leading-relaxed">
      {blocks.map((block, index) => {
        if (block.kind !== "message") return null;
        // The first answer after these options is the one that picked from them.
        const answer = answers.find((at) => at > index);
        const picked = answer === undefined ? null : blocks[answer];
        const chosen =
          picked?.kind === "message" ? /^Jouw antwoord: Optie (\d+):/.exec(picked.summary)?.[1] : undefined;
        return (
          <MessageView
            key={index}
            block={block}
            chosen={chosen}
            onChoose={index > lastAnswer ? onChoose : undefined}
          />
        );
      })}
    </ul>
  );
}
