import type { AgentRunKind } from "./models";

export interface AgentPromptInput {
  kind: AgentRunKind;
  storyId: string;
  storyTitle: string;
  /** Project-relative paths of the story's spec file(s). */
  sourcePaths: string[];
  /** Review only: apply fixes for the findings instead of only reporting them. */
  fixFindings: boolean;
}

/**
 * The prompt for a headless run. Nobody can answer questions, so every
 * prompt says so; the BMAD skills then make their own decisions or halt.
 */
export function buildAgentPrompt(input: AgentPromptInput): string {
  const story = `story ${input.storyId} (${input.storyTitle})`;
  const specs =
    input.sourcePaths.length > 0
      ? `Spec file(s): ${input.sourcePaths.join(", ")}`
      : "The story has no spec file yet; find it in sprint-status and the epics.";

  if (input.kind === "plan") {
    // bmad-build-auto sets the spec to ready-for-dev and stops on this phrase.
    return [
      `/bmad-build-auto Plan ${story}. Halt after planning.`,
      specs,
      "",
      "Started from MyBMAD; nobody is watching to answer questions.",
      "- Write or complete the spec only; do not implement.",
      "- Make every decision yourself; halt with a clear status only when truly blocked.",
    ].join("\n");
  }

  if (input.kind === "dev") {
    return [
      `/bmad-build-auto Build ${story}.`,
      specs,
      "",
      "Started from MyBMAD; nobody is watching to answer questions.",
      "- Make every decision yourself; halt with a clear status only when truly blocked.",
    ].join("\n");
  }

  return [
    `/bmad-code-review Review the changes for ${story}.`,
    specs,
    "",
    "Started from MyBMAD; nobody is watching to answer questions. Do not halt at any checkpoint.",
    ...(input.fixFindings
      ? [
          "- Resolve every finding yourself: apply a fix, or defer it when it predates this story.",
          "- After fixing, run the project's own build and tests and fix any new errors.",
          "- Mark resolved findings in the story file; set the story to done only when all are resolved.",
        ]
      : [
          "- Report the findings only. Do not change code.",
          "- Write the findings into the story file so they can be picked up later.",
        ]),
  ].join("\n");
}
