import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSplitStory } from "../split-story";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "split-story-"));
  const dir = path.join(root, "_bmad-output", "implementation-artifacts");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return root;
}

describe("isSplitStory", () => {
  it("is true for a parent story whose spec is split", async () => {
    const root = project({ "spec-4-1-create-and-send-a-sales-invoice.md": "---\nstatus: 'split'\n---\n" });
    expect(await isSplitStory(root, "4.1")).toBe(true);
  });

  it("is false for a subtask of a split story", async () => {
    const root = project({
      "spec-4-1-create-and-send-a-sales-invoice.md": "---\nstatus: 'split'\n---\n",
      "spec-4-1a-seller-address-and-invoice-settings.md": "---\nstatus: 'done'\n---\n",
    });
    expect(await isSplitStory(root, "4.1a")).toBe(false);
  });

  it("is false for a normal story and for a missing spec", async () => {
    const root = project({ "spec-6-1-import-payroll.md": "---\nstatus: 'done'\n---\n" });
    expect(await isSplitStory(root, "6.1")).toBe(false);
    expect(await isSplitStory(root, "9.9")).toBe(false);
  });
});
