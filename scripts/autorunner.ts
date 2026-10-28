/**
 * Runs one autorunner queue. Started detached by MyBMAD with the queue's
 * state file: npx tsx scripts/autorunner.ts <state-file> [keep-awake]
 */
import { spawn } from "node:child_process";
import { runAutorunner } from "../src/lib/agents/autorunner";

const file = process.argv[2];
if (!file) {
  console.error("Usage: tsx scripts/autorunner.ts <state-file>");
  process.exit(1);
}

// Keep the Mac from idle-sleeping while the queue runs, when the user asked for it.
// caffeinate exits with this process, so the hold ends when the queue stops, finishes
// or fails; nothing to restore.
if (process.platform === "darwin" && process.argv[3] === "keep-awake") {
  spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" })
    .on("error", () => {})
    .unref();
}

runAutorunner(file).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
