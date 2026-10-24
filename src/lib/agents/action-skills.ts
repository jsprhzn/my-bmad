import type { AgentRunKind } from "./models";

/** A skill installed in the project (.claude/skills/<name>/SKILL.md). */
export interface ProjectSkill {
  name: string;
  description: string;
  /** BMAD agent persona (bmad-agent-*), as opposed to a workflow skill. */
  persona: boolean;
}

/**
 * Skills that fit each action, in order of preference. The first installed
 * one is the default; the others are offered first as alternatives.
 */
const SUGGESTED_SKILLS: Record<AgentRunKind, string[]> = {
  plan: ["bmad-build-auto", "bmad-build", "bmad-spec", "bmad-create-story", "bmad-agent-dev", "bmad-agent-architect"],
  dev: ["bmad-build-auto", "bmad-dev-story", "bmad-build", "bmad-quick-dev", "bmad-agent-dev"],
  review: ["bmad-code-review", "bmad-review", "bmad-walkthrough", "bmad-qa-generate-e2e-tests"],
};

/** Installed skills for an action: suggested ones first (in preference order), then the rest. */
export function skillsForAction(
  kind: AgentRunKind,
  installed: ProjectSkill[],
): { suggested: ProjectSkill[]; other: ProjectSkill[] } {
  const byName = new Map(installed.map((s) => [s.name, s]));
  const suggested = SUGGESTED_SKILLS[kind]
    .map((name) => byName.get(name))
    .filter((s): s is ProjectSkill => s !== undefined);
  const suggestedNames = new Set(suggested.map((s) => s.name));
  const other = installed.filter((s) => !suggestedNames.has(s.name));
  return { suggested, other };
}

/** The default skill for an action, or null when the project has none that fits. */
export function defaultSkillFor(kind: AgentRunKind, installed: ProjectSkill[]): string | null {
  return skillsForAction(kind, installed).suggested[0]?.name ?? null;
}
