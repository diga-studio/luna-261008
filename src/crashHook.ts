/**
 * Test-only hook: when EES_CRASH_AFTER_STEP equals `step`, terminate the
 * process immediately (SIGKILL) to simulate a forced kill at a persistence
 * boundary. Inert in normal operation.
 */
export function crashBoundary(step: number): void {
  const target = process.env.EES_CRASH_AFTER_STEP;
  if (target !== undefined && Number(target) === step) {
    process.kill(process.pid, "SIGKILL");
  }
}
