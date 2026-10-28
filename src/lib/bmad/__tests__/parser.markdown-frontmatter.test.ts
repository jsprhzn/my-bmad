import { describe, it, expect } from "vitest";
import { parseBmadFile } from "../parser";

describe("parseBmadFile markdown with broken frontmatter", () => {
  it("renders the body as markdown instead of raw content", () => {
    const content = [
      "---",
      "sources:",
      "  - {planning_artifacts}/brief.md",
      "  bad: [",
      "---",
      "# Titel",
      "",
      "Tekst",
    ].join("\n");

    const result = parseBmadFile(content, "markdown");

    expect(result.parseError).toBeNull();
    expect(result.contentType).toBe("markdown");
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe("# Titel\n\nTekst");
  });

  it("parses valid frontmatter as before", () => {
    const result = parseBmadFile("---\nname: x\n---\n# Kop\n", "markdown");

    expect(result.frontmatter).toEqual({ name: "x" });
    expect(result.body).toBe("# Kop\n");
  });
});
