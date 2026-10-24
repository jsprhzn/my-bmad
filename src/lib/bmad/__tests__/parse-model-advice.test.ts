import { describe, expect, it } from "vitest";
import { attachModelAdvice, parseModelAdvice, parseModelTiers } from "../parse-model-advice";
import type { StoryDetail } from "../types";

const FIXTURE = `# Story complexity

Per story: complexity (S/M/L/XL) and the cheapest model that can do it safely.

| Story | Title | Cx | Model | Reason |
|---|---|---|---|---|
| 1.2 | Sign up and sign in with 2FA | L | Opus (core) · Haiku (theme) | Auth core is security. |
| 1.3 | Create first administration | M | Sonnet | Form and CRUD. |
| 1.2a | Keycloak theme | S | Haiku | Styling with tokens. |

Some prose with | pipes | in it.
`;

function makeStory(id: string): StoryDetail {
  return {
    id,
    title: `Story ${id}`,
    status: "backlog",
    epicId: id.split(".")[0],
    description: "",
    acceptanceCriteria: [],
    tasks: [],
    completedTasks: 0,
    totalTasks: 0,
  };
}

describe("parseModelAdvice", () => {
  it("reads complexity, model, tiers and reason per story row", () => {
    const rows = parseModelAdvice(FIXTURE);
    expect(rows.get("1.2")).toEqual({
      id: "1.2",
      title: "Sign up and sign in with 2FA",
      complexity: "L",
      model: "Opus (core) · Haiku (theme)",
      tiers: ["opus", "haiku"],
      reason: "Auth core is security.",
    });
    expect(rows.get("1.3")?.tiers).toEqual(["sonnet"]);
  });

  it("keeps sub-parts as their own rows and skips header and prose", () => {
    expect([...parseModelAdvice(FIXTURE).keys()]).toEqual(["1.2", "1.3", "1.2a"]);
  });

  it("finds columns by header name, in any order", () => {
    const rows = parseModelAdvice(
      "| Model | Story |\n|:--|--:|\n| Haiku | 2.1 |\n",
    );
    expect(rows.get("2.1")?.tiers).toEqual(["haiku"]);
    expect(rows.get("2.1")?.complexity).toBeUndefined();
  });

  it("ignores tables without a story and a model column", () => {
    expect(parseModelAdvice("| A | B |\n|---|---|\n| 1.1 | Opus |\n").size).toBe(0);
  });
});

describe("parseModelTiers", () => {
  it("lists tiers in the order they are named", () => {
    expect(parseModelTiers("Sonnet, review on Opus")).toEqual(["sonnet", "opus"]);
    expect(parseModelTiers("Claude Haiku 5.5")).toEqual(["haiku"]);
    expect(parseModelTiers("GPT")).toEqual([]);
  });
});

describe("attachModelAdvice", () => {
  it("attaches rows to stories and letter variants as parts", () => {
    const stories = attachModelAdvice(
      [makeStory("1.2"), makeStory("1.3"), makeStory("1.4")],
      parseModelAdvice(FIXTURE),
    );
    const s12 = stories.find((s) => s.id === "1.2")!;
    expect(s12.modelAdvice?.tiers).toEqual(["opus", "haiku"]);
    expect(s12.modelAdvice?.parts?.map((p) => p.id)).toEqual(["1.2a"]);
    expect(stories.find((s) => s.id === "1.3")!.modelAdvice?.parts).toBeUndefined();
    expect(stories.find((s) => s.id === "1.4")!.modelAdvice).toBeUndefined();
  });

  it("does not turn a variant that is a story itself into a part", () => {
    const rows = parseModelAdvice(
      "| Story | Model |\n|---|---|\n| 1.3 | Sonnet |\n| 1.3c | Haiku |\n",
    );
    const stories = attachModelAdvice([makeStory("1.3"), makeStory("1.3c")], rows);
    expect(stories[0].modelAdvice?.parts).toBeUndefined();
    expect(stories[1].modelAdvice?.tiers).toEqual(["haiku"]);
  });
});
