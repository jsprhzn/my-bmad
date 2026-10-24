import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { ProjectSkill } from "./action-skills";

const MAX_SKILLS = 300;
const MAX_DESCRIPTION = 300;

/**
 * Skills installed in a local project: .claude/skills/<dir>/SKILL.md with a
 * `name` and `description` in its frontmatter. These are what a Claude Code
 * run in that folder can be started with.
 */
export async function listProjectSkills(projectPath: string): Promise<ProjectSkill[]> {
  const skillsDir = path.join(projectPath, ".claude", "skills");
  if (!existsSync(skillsDir)) return [];

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: ProjectSkill[] = [];
  for (const entry of entries.slice(0, MAX_SKILLS)) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const { data } = matter(await readFile(file, "utf8"));
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : entry.name;
      if (!/^[\w.:-]{1,80}$/.test(name)) continue;
      const description = typeof data.description === "string" ? data.description.trim() : "";
      skills.push({
        name,
        description:
          description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION)}…` : description,
        persona: /^bmad-agent-/.test(name),
      });
    } catch {
      // Malformed SKILL.md: not offered.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
