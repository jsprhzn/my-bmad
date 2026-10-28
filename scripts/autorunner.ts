/**
 * Runs one autorunner queue. Started detached by MyBMAD with the queue's
 * state file: npx tsx scripts/autorunner.ts <state-file>
 */
import { runAutorunner } from "../src/lib/agents/autorunner";

const file = process.argv[2];
if (!file) {
  console.error("Usage: tsx scripts/autorunner.ts <state-file>");
  process.exit(1);
}

runAutorunner(file).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
