import { describe, it, expect } from "vitest";
import { getBmadProject } from "../parser";
import { parseStory } from "../parse-story";
import { parseSprintStatus } from "../parse-sprint-status";
import { parseEpics } from "../parse-epics";
import type { ContentProvider } from "@/lib/content-provider";
import type { RepoConfig } from "@/lib/types";

function makeProvider(files: Record<string, string>): ContentProvider {
  return {
    async getTree() {
      return { paths: Object.keys(files), rootDirectories: ["_bmad-output"] };
    },
    async getFileContent(p: string) {
      if (!(p in files)) throw new Error(`Not found: ${p}`);
      return files[p];
    },
    async validateRoot() {},
  };
}

const REPO: RepoConfig = {
  owner: "local",
  name: "test",
  branch: "main",
  displayName: "Test",
  description: null,
  sourceType: "local",
  localPath: "/tmp/test",
  lastSyncedAt: null,
};

const IMPL = "_bmad-output/implementation-artifacts";

function spec(title: string, status: string, body = "") {
  return `---\ntitle: '${title}'\nstatus: '${status}'\n---\n\n## Intent\n\n${body}\n`;
}

// Some parts carry their title as a heading instead of in frontmatter.
function specWithHeading(title: string, status: string) {
  return `---\nstatus: '${status}'\n---\n# ${title}\n\n## Intent\n`;
}

describe("parseStory — spec files", () => {
  it("reads the story id behind a spec- prefix", () => {
    const s = parseStory(spec("Story 1.4: Invite", "done"), "spec-1-4-invite.md");
    expect(s?.id).toBe("1.4");
    expect(s?.epicId).toBe("1");
    expect(s?.title).toBe("Invite");
  });

  it("keeps a letter suffix in the story number", () => {
    const s = parseStory(spec("Story 1.3c: Change details", "done"), "spec-1-3c-change.md");
    expect(s?.id).toBe("1.3c");
    expect(s?.title).toBe("Change details");
  });

  it("reads the part from the filename", () => {
    const s = parseStory(spec("Story 1.2 part 3: Timeout", "review"), "spec-1-2-part-3-timeout.md");
    expect(s?.id).toBe("1.2");
    expect(s?.part).toBe("3");
    expect(s?.title).toBe("Timeout");
  });

  it("reads a part range from the filename", () => {
    const s = parseStory(spec("Story 1.2 (parts 2 and 5): Theme", "done"), "spec-1-2-parts-2-5-theme.md");
    expect(s?.part).toBe("2-5");
    expect(s?.title).toBe("Theme");
  });

  it("reads the part from the title when the filename has none", () => {
    const s = parseStory(spec("Story 1.1 (part 1): Scaffold", "done"), "spec-1-1-scaffold.md");
    expect(s?.part).toBe("1");
    expect(s?.title).toBe("Scaffold");
  });
});

describe("parseSprintStatus — letter suffix", () => {
  it("parses 1-3c keys as story 1.3c", () => {
    const parsed = parseSprintStatus(
      "development_status:\n  1-3c-change-details: ready-for-dev\n",
    );
    expect(parsed?.sprintStatus.stories).toEqual([
      { id: "1.3c", title: "1-3c-change-details", status: "ready-for-dev", epicId: "1" },
    ]);
  });
});

describe("parseEpics — story headings", () => {
  it("uses story headings and ignores loose story mentions in prose", () => {
    const { epics } = parseEpics(
      [
        "## Epic 1: Start",
        "Epic 1 Story 1 is a greenfield scaffold.",
        "### Story 1.1: Scaffold",
        "Depends on story 2.",
        "### Story 1.3c: Change details",
      ].join("\n"),
    );
    expect(epics[0].stories).toEqual(["1.1", "1.3c"]);
    expect(epics[0].storyTitles).toEqual({ "1.1": "Scaffold", "1.3c": "Change details" });
  });

  it("keeps story text out of the epic description", () => {
    const { epics } = parseEpics(
      ["## Epic 1: Start", "Epic goal.", "### Story 1.1: Scaffold", "As Jasper, I want…"].join("\n"),
    );
    expect(epics[0].description).toBe("Epic goal.");
  });
});

describe("getBmadProject — spec files in parts", () => {
  const files = {
    "_bmad-output/planning-artifacts/epics.md": [
      "## Epic 1: Start",
      "### Story 1.2: Sign in with 2FA",
      "### Story 1.3: Create administration",
      "### Story 1.3c: Change details",
    ].join("\n"),
    [`${IMPL}/sprint-status.yaml`]: [
      "development_status:",
      "  epic-1: in-progress",
      "  1-2-sign-in-with-2fa: review",
      "  1-3-create-administration: review",
      "  1-3c-change-details: ready-for-dev",
    ].join("\n"),
    [`${IMPL}/spec-1-2-part-1-sign-in.md`]: spec("Story 1.2 (part 1): Sign in", "done", "- [x] one"),
    [`${IMPL}/spec-1-2-part-3-timeout.md`]: specWithHeading("Story 1.2 part 3: Timeout", "review") + "- [ ] two\n",
    [`${IMPL}/spec-1-3b-create-administration.md`]: spec("Story 1.3b: Create administration", "review"),
    [`${IMPL}/spec-1-3c-change-details.md`]: spec("Story 1.3c: Change details", "done"),
    [`${IMPL}/review-1-2.md`]: "# Review: story 1.2\n",
    [`${IMPL}/epic-1-context.md`]: "# Epic 1 Context\n",
  };

  it("gives every story a unique id that matches sprint-status", async () => {
    const project = await getBmadProject(REPO, makeProvider(files));
    const ids = project!.stories.map((s) => s.id).sort();
    expect(ids).toEqual(["1.2", "1.3", "1.3c"]);
  });

  it("merges parts into one story with the epics title and slowest status", async () => {
    const project = await getBmadProject(REPO, makeProvider(files));
    const story = project!.stories.find((s) => s.id === "1.2")!;
    expect(story.title).toBe("Sign in with 2FA");
    expect(story.status).toBe("review");
    expect(story.partCount).toBe(2);
    expect(story.totalTasks).toBe(2);
    expect(story.completedTasks).toBe(1);
    expect(story.description).toContain("### Part 1: Sign in (done)");
    expect(story.description).toContain("### Part 3: Timeout (review)");
    expect(story.description).not.toMatch(/^# /m);
  });

  it("attaches a letter variant to the base story the plan knows", async () => {
    const project = await getBmadProject(REPO, makeProvider(files));
    const story = project!.stories.find((s) => s.id === "1.3")!;
    expect(story.title).toBe("Create administration");
    expect(story.description).toContain("## Intent");
  });

  it("does not treat reviews or epic context as stories", async () => {
    const project = await getBmadProject(REPO, makeProvider(files));
    expect(project!.stories.some((s) => s.title.startsWith("Review"))).toBe(false);
    expect(project!.parseHealth!.totalFiles).toBe(6);
  });

  it("counts epic progress from the merged stories", async () => {
    const project = await getBmadProject(REPO, makeProvider(files));
    const epic = project!.epics.find((e) => e.id === "1")!;
    expect(epic.totalStories).toBe(3);
    expect(epic.completedStories).toBe(1);
  });
});
