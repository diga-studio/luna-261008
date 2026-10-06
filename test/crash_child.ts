/**
 * Helper process for crash-injection tests. The parent test spawns this
 * script and kills it at an arbitrary moment to simulate a hard crash.
 * It must not be picked up as a test file (no .test.ts suffix).
 */
import { AgentSide } from "../src/agent";
import { SummarySide } from "../src/summary";
import { makeBody } from "./helpers";

const [mode, dbPath, arg] = process.argv.slice(2);

if (mode === "receive") {
  const count = Number(arg);
  const agent = new AgentSide(dbPath);
  for (let i = 1; i <= count; i++) {
    agent.receiveEvent(`ev-${i}`, makeBody(i));
    console.log(`received ${i}`);
  }
  agent.close();
  console.log("done");
} else if (mode === "ack") {
  const watermark = Number(arg);
  const agent = new AgentSide(dbPath);
  agent.applyAck(watermark);
  console.log(`acked ${agent.confirmedWatermark()}`);
  agent.close();
  console.log("done");
} else if (mode === "ingest") {
  const count = Number(arg);
  const summary = new SummarySide(dbPath);
  for (let i = 1; i <= count; i++) {
    summary.ingest("agent-x", [
      { seq: i, eventId: `ev-${i}`, body: makeBody(i) },
    ]);
    console.log(`ingested ${i}`);
  }
  summary.close();
  console.log("done");
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
