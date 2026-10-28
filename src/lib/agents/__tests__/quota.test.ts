import { describe, expect, it } from "vitest";
import { allowanceFor, parseQuota, quotaLoad } from "../quota";

const OUTPUT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 57% used · resets Oct 28 at 7:30pm (Europe/Amsterdam)",
  "Current week (all models): 27% used · resets Nov 2 at 4am (Europe/Amsterdam)",
  "Current week (Fable): 0% used · resets Nov 2 at 4am (Europe/Amsterdam)",
].join("\n");

describe("parseQuota", () => {
  it("reads the session and the week as Claude Code prints them", () => {
    const quota = parseQuota(OUTPUT, new Date("2026-10-28T12:00:00Z"));
    expect(quota.session).toEqual({ usedPercent: 57, resets: "Oct 28 at 7:30pm" });
    expect(quota.week).toEqual({ usedPercent: 27, resets: "Nov 2 at 4am" });
  });

  it("leaves a window out when the text does not name it", () => {
    expect(parseQuota("nothing here").session).toBeNull();
  });
});

describe("quotaLoad and allowanceFor", () => {
  it("uses the fuller window, and nothing when Claude reports neither", () => {
    const quota = parseQuota(OUTPUT);
    expect(quotaLoad(quota)).toBeCloseTo(0.57);
    expect(quotaLoad(null)).toBeNull();
  });

  it("keeps all runs below 60%, two from 60%, none from 100%", () => {
    expect(allowanceFor(null, 3)).toBe(3);
    expect(allowanceFor(0.59, 3)).toBe(3);
    expect(allowanceFor(0.6, 3)).toBe(2);
    expect(allowanceFor(1, 3)).toBe(0);
  });
});
