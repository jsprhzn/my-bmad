import { describe, it, expect } from "vitest";
import { resolveRelativeFileLink } from "../markdown-renderer";

const FILE = "_bmad-output/planning-artifacts/ux-designs/ux-1/DESIGN.md";

describe("resolveRelativeFileLink", () => {
  it("resolves a sibling folder link against the open file", () => {
    expect(resolveRelativeFileLink("mockups/key-screens.html", FILE)).toBe(
      "_bmad-output/planning-artifacts/ux-designs/ux-1/mockups/key-screens.html",
    );
  });

  it("resolves ./ and ../ segments and drops the anchor", () => {
    expect(resolveRelativeFileLink("../../epics.md#epic-1", FILE)).toBe(
      "_bmad-output/planning-artifacts/epics.md",
    );
    expect(resolveRelativeFileLink("./EXPERIENCE.md", FILE)).toBe(
      "_bmad-output/planning-artifacts/ux-designs/ux-1/EXPERIENCE.md",
    );
  });

  it("decodes encoded characters", () => {
    expect(resolveRelativeFileLink("my%20notes.md", "a/b.md")).toBe("a/my notes.md");
  });

  it("leaves anchors, absolute paths and URLs alone", () => {
    expect(resolveRelativeFileLink("#intent", FILE)).toBeNull();
    expect(resolveRelativeFileLink("/docs", FILE)).toBeNull();
    expect(resolveRelativeFileLink("https://example.com", FILE)).toBeNull();
    expect(resolveRelativeFileLink("mailto:a@b.nl", FILE)).toBeNull();
  });

  it("refuses to climb above the project root", () => {
    expect(resolveRelativeFileLink("../../x.md", "a/b.md")).toBeNull();
  });
});
