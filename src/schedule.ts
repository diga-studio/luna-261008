import type { Alert, Config, MaybeFrame, Segment } from "./types.js";
import {
  materializeWindows,
  slideAt,
  slideBoundaries,
  type WindowInstance,
} from "./windows.js";

function pickAlert(alerts: Alert[], group: string, tUtc: number): Alert | null {
  let best: Alert | null = null;
  for (const alert of alerts) {
    if (alert.group !== group) continue;
    if (alert.startUtc > tUtc || alert.endUtc <= tUtc) continue;
    if (
      !best ||
      alert.startUtc > best.startUtc ||
      (alert.startUtc === best.startUtc && alert.id < best.id)
    ) {
      best = alert;
    }
  }
  return best;
}

function pickWindow(
  instances: WindowInstance[],
  tUtc: number
): WindowInstance | null {
  let best: WindowInstance | null = null;
  for (const inst of instances) {
    if (inst.startUtc > tUtc || inst.endUtc <= tUtc) continue;
    if (
      !best ||
      inst.window.priority > best.window.priority ||
      (inst.window.priority === best.window.priority &&
        inst.window.id < best.window.id)
    ) {
      best = inst;
    }
  }
  return best;
}

function frameAt(
  instances: WindowInstance[],
  alerts: Alert[],
  group: string,
  tUtc: number
): MaybeFrame {
  const alert = pickAlert(alerts, group, tUtc);
  if (alert) return { sourceId: alert.id, contentId: alert.contentId };
  const inst = pickWindow(instances, tUtc);
  if (inst) return { sourceId: inst.window.id, contentId: slideAt(inst, tUtc) };
  return null;
}

/** The frame that should be on screen for `group` at UTC instant `tUtc`. */
export function resolve(
  config: Config,
  group: string,
  tUtc: number
): MaybeFrame {
  const instances = materializeWindows(
    config.windows,
    config.playlists,
    group,
    tUtc,
    tUtc + 1
  );
  return frameAt(instances, config.alerts, group, tUtc);
}

function sameFrame(a: MaybeFrame, b: MaybeFrame): boolean {
  if (a === null || b === null) return a === b;
  return a.sourceId === b.sourceId && a.contentId === b.contentId;
}

/**
 * Full playback segments covering [fromUtc, toUtc) for `group`.
 * Segments are gapless, non-overlapping, and adjacent segments with equal
 * frames are merged.
 */
export function timeline(
  config: Config,
  group: string,
  fromUtc: number,
  toUtc: number
): Segment[] {
  if (!(fromUtc < toUtc)) throw new RangeError("fromUtc must be < toUtc");
  const instances = materializeWindows(
    config.windows,
    config.playlists,
    group,
    fromUtc,
    toUtc
  );
  const alerts = config.alerts.filter(
    (a) => a.group === group && a.endUtc > fromUtc && a.startUtc < toUtc
  );

  const breakpoints = new Set<number>([fromUtc, toUtc]);
  for (const inst of instances) {
    breakpoints.add(Math.max(inst.startUtc, fromUtc));
    breakpoints.add(Math.min(inst.endUtc, toUtc));
  }
  for (const alert of alerts) {
    breakpoints.add(Math.max(alert.startUtc, fromUtc));
    breakpoints.add(Math.min(alert.endUtc, toUtc));
  }
  const sorted = [...breakpoints].sort((a, b) => a - b);

  const segments: Segment[] = [];
  const push = (startUtc: number, endUtc: number, frame: MaybeFrame) => {
    if (startUtc >= endUtc) return;
    const last = segments[segments.length - 1];
    if (last && last.endUtc === startUtc && sameFrame(last.frame, frame)) {
      last.endUtc = endUtc;
    } else {
      segments.push({ startUtc, endUtc, frame });
    }
  };

  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const alert = pickAlert(alerts, group, a);
    if (alert) {
      push(a, b, { sourceId: alert.id, contentId: alert.contentId });
      continue;
    }
    const inst = pickWindow(instances, a);
    if (!inst) {
      push(a, b, null);
      continue;
    }
    // The winning window is constant on [a, b); subdivide by slide changes.
    const cuts = slideBoundaries(inst, a, b);
    let segStart = a;
    for (const cut of cuts) {
      push(segStart, cut, {
        sourceId: inst.window.id,
        contentId: slideAt(inst, segStart),
      });
      segStart = cut;
    }
    push(segStart, b, {
      sourceId: inst.window.id,
      contentId: slideAt(inst, segStart),
    });
  }
  return segments;
}
