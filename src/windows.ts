import type { Playlist, ShiftWindow } from "./types.js";
import { addDays, localToUtc, utcToLocal } from "./timezone.js";

/** Duration of the repeated hour on the fall-back day. */
const REPEATED_HOUR_MS = 3_600_000;

/**
 * A daily window instance: a shift window materialized for one local
 * calendar day, with concrete UTC bounds (start inclusive, end exclusive).
 */
export interface WindowInstance {
  window: ShiftWindow;
  playlist: Playlist;
  startUtc: number;
  endUtc: number;
}

/**
 * Materialize all daily window instances for `group` whose UTC interval
 * overlaps [fromUtc, toUtc). Instances that convert to an empty interval
 * (end <= start) are omitted.
 */
export function materializeWindows(
  windows: ShiftWindow[],
  playlists: Playlist[],
  group: string,
  fromUtc: number,
  toUtc: number
): WindowInstance[] {
  const playlistById = new Map(playlists.map((p) => [p.id, p]));
  const result: WindowInstance[] = [];
  // A window starts on a local date and ends on the same or the next local
  // date (nominal span <= 12h), so a one-day margin on each side suffices.
  const firstDate = addDays(utcToLocal(fromUtc).date, -1);
  const lastDate = addDays(utcToLocal(toUtc).date, 1);
  for (const win of windows) {
    if (win.group !== group) continue;
    const playlist = playlistById.get(win.playlistId);
    if (!playlist) continue;
    for (let date = firstDate; ; date = addDays(date, 1)) {
      // Window start: on a repeated wall time take the earlier instant.
      const start = localToUtc(date, win.startLocal).utcMs;
      // End on the next local day when the end clock time is earlier than
      // the start clock time.
      const endDate = win.endLocal < win.startLocal ? addDays(date, 1) : date;
      const endConv = localToUtc(endDate, win.endLocal);
      // Window end: on a repeated wall time take the later instant.
      const end =
        endConv.kind === "ambiguous"
          ? endConv.utcMs + REPEATED_HOUR_MS
          : endConv.utcMs;
      if (end > start && end > fromUtc && start < toUtc) {
        result.push({ window: win, playlist, startUtc: start, endUtc: end });
      }
      if (date === lastDate) break;
    }
  }
  return result;
}

function cycleMs(inst: WindowInstance): number {
  return inst.playlist.slides.reduce((sum, s) => sum + s.durationSec * 1000, 0);
}

/**
 * The contentId playing at instant `tUtc` for a window instance, given the
 * carousel phase runs continuously from the instance's UTC start.
 */
export function slideAt(inst: WindowInstance, tUtc: number): string {
  const slides = inst.playlist.slides;
  const cycle = cycleMs(inst);
  let pos = (tUtc - inst.startUtc) % cycle;
  if (pos < 0) pos += cycle;
  for (const slide of slides) {
    if (pos < slide.durationSec * 1000) return slide.contentId;
    pos -= slide.durationSec * 1000;
  }
  return slides[slides.length - 1].contentId;
}

/**
 * Ordered UTC instants within [fromUtc, toUtc) at which the active slide
 * of this instance changes. Each returned instant starts a new slide.
 */
export function slideBoundaries(
  inst: WindowInstance,
  fromUtc: number,
  toUtc: number
): number[] {
  const durations = inst.playlist.slides.map((s) => s.durationSec * 1000);
  const cycle = durations.reduce((a, b) => a + b, 0);
  let pos = (fromUtc - inst.startUtc) % cycle;
  if (pos < 0) pos += cycle;
  let index = 0;
  while (pos >= durations[index]) {
    pos -= durations[index];
    index += 1;
  }
  const result: number[] = [];
  let boundary = fromUtc + (durations[index] - pos);
  while (boundary < toUtc) {
    result.push(boundary);
    index = (index + 1) % durations.length;
    boundary += durations[index];
  }
  return result;
}
