import type { ModelTier } from "@/lib/bmad/types";
import { formatStream } from "./stream-format";

/**
 * The stages of a story in the autorunner queue, read from the run output.
 * The build skill reads its step files in order (plan, implement, review), so
 * the files it reads say which stage it is in; test runs are the commands it
 * runs after implementing.
 */

export type StageId = "brainstorm" | "plan" | "build" | "test" | "review";

export const STAGE_ORDER: StageId[] = ["brainstorm", "plan", "build", "test", "review"];

export const STAGE_LABELS: Record<StageId, string> = {
  brainstorm: "Brainstormen",
  plan: "Plan",
  build: "Bouwen",
  test: "Testen",
  review: "Review",
};

const STEP_FILES: Array<[RegExp, StageId]> = [
  [/step-02-plan\.md$/, "plan"],
  [/step-03-implement\.md$/, "build"],
  [/step-04-review\.md$/, "review"],
];

const TEST_COMMAND =
  /\b(mvnw?|mvn)\b[^\n]*\btest\b|\b(pnpm|npm|yarn)\b[^\n]*\btest\b|\bvitest\b|\bplaywright\b|\bpytest\b|\bgo test\b/;

interface ToolEvent {
  type?: string;
  message?: {
    content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }>;
  };
}

function parseLine(line: string): ToolEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as ToolEvent;
  } catch {
    return null;
  }
}

/**
 * The stages a build or review run has reached, in the order it reached them.
 * The last one is where the run is now.
 */
export function reachedStages(stream: string): StageId[] {
  const reached: StageId[] = [];
  const reach = (stage: StageId) => {
    if (!reached.includes(stage)) reached.push(stage);
  };
  for (const line of stream.split("\n")) {
    const event = parseLine(line);
    for (const block of event?.message?.content ?? []) {
      if (block.type !== "tool_use") continue;
      const input = block.input ?? {};
      const file = typeof input.file_path === "string" ? input.file_path : "";
      for (const [pattern, stage] of STEP_FILES) {
        if (pattern.test(file)) reach(stage);
      }
      if (block.name === "Skill" && String(input.skill ?? "").includes("review")) reach("review");
      const command = typeof input.command === "string" ? input.command : "";
      if (reached.includes("build") && TEST_COMMAND.test(command)) reach("test");
    }
  }
  return reached;
}

/**
 * The last headline messages of a run's log: tool calls, and the indented or list lines under a
 * message, are left out.
 */
export function logTail(stream: string, lines: number): string[] {
  return formatStream(stream)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^→ /.test(line) && !/^(\s|[-*]\s|\d+\.\s)/.test(line))
    .slice(-lines);
}

export type StageState = "done" | "active" | "pending" | "skipped";

export interface StageView {
  id: StageId;
  label: string;
  state: StageState;
  model: ModelTier | null;
}

/** Models the queue plans to use per action, from story-complexity.md. */
export type PlannedModels = Partial<Record<"brainstorm" | "plan" | "dev" | "review", ModelTier>>;

export interface StageInput {
  /** Stage the story is in now, from its run: "review" for a review run. */
  current: StageId | null;
  /** Stages reached so far, from reachedStages. */
  reached: StageId[];
  /** Whether the queue's build run has finished. */
  buildDone: boolean;
  /** Model per run kind: the run's own model once it ran, the plan before. */
  models: { brainstorm?: ModelTier; plan?: ModelTier; build?: ModelTier; review?: ModelTier };
  /** Whether a brainstorm run was made for the story. */
  hasBrainstorm: boolean;
  /** Whether the story has a planning run of its own. */
  hasPlan: boolean;
}

/** One entry per stage, in order. Brainstorming and planning are skipped when the queue did not do them. */
export function stagesOf(input: StageInput): StageView[] {
  const { current, reached, buildDone, models } = input;
  const done = (stage: StageId) => reached.includes(stage) || (buildDone && stage !== "review");
  const state = (stage: StageId): StageState => {
    if (current === stage) return "active";
    return done(stage) ? "done" : "pending";
  };
  const planned = (stage: StageId, model: ModelTier | undefined): StageView => ({
    id: stage,
    label: STAGE_LABELS[stage],
    state: state(stage),
    model: model ?? null,
  });
  return [
    input.hasBrainstorm
      ? planned("brainstorm", models.brainstorm)
      : { id: "brainstorm", label: STAGE_LABELS.brainstorm, state: "skipped", model: null },
    input.hasPlan || reached.includes("plan")
      ? planned("plan", models.plan ?? models.build)
      : { id: "plan", label: STAGE_LABELS.plan, state: "skipped", model: null },
    planned("build", models.build),
    planned("test", models.build),
    planned("review", models.review),
  ];
}
