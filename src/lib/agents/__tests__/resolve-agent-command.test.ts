import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_COMMAND, resolveAgentCommand } from "../run-store";

describe("resolveAgentCommand", () => {
  it("fills in both placeholders of the default command", () => {
    const command = resolveAgentCommand(DEFAULT_AGENT_COMMAND, "sonnet", "bypassPermissions");
    expect(command).toContain("--model sonnet");
    expect(command).toContain("--permission-mode bypassPermissions");
    expect(command).not.toContain("{");
  });

  it("leaves no placeholder behind for the finish and conflict steps", () => {
    const command = resolveAgentCommand(DEFAULT_AGENT_COMMAND, "opus", "auto");
    expect(command).not.toMatch(/\{(model|permission_mode)\}/);
  });
});
