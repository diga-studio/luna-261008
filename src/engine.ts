import type { EmergencyAlert, Frame, PlaybackConfig, Playlist, TimelineSegment } from "./types.js";
import { selectWindowAt, windowInstancesIntersecting, type WindowInstance } from "./windows.js";

function playlistById(config: PlaybackConfig, id: string): Playlist {
  const pl = config.playlists.find((p) => p.id === id);
  if (!pl) throw new Error(`playlist not found: ${id}`);
  return pl;
}

/** t 时刻获选的告警：起点较晚者优先，并列取 id 字典序最小。 */
function selectAlertAt(config: PlaybackConfig, group: string, tUtcMs: number): EmergencyAlert | null {
  let best: EmergencyAlert | null = null;
  for (const a of config.alerts) {
    if (a.group !== group || !(a.startUtcMs <= tUtcMs && tUtcMs < a.endUtcMs)) continue;
    if (
      !best ||
      a.startUtcMs > best.startUtcMs ||
      (a.startUtcMs === best.startUtcMs && a.id < best.id)
    ) {
      best = a;
    }
  }
  return best;
}

/** 窗口实例在 t 时刻的幻灯片：相位从当日实际 UTC 起点按真实经过时长循环。 */
function slideContentAt(inst: WindowInstance, playlist: Playlist, tUtcMs: number): string {
  const durations = playlist.slides.map((s) => s.durationSec * 1000);
  const cycle = durations.reduce((a, b) => a + b, 0);
  let pos = (tUtcMs - inst.startUtcMs) % cycle;
  for (let i = 0; i < durations.length; i++) {
    if (pos < durations[i]) return playlist.slides[i].contentId;
    pos -= durations[i];
  }
  return playlist.slides[playlist.slides.length - 1].contentId;
}

/** 返回 t 瞬间该 group 的播放帧；空闲返回 null。 */
export function resolve(config: PlaybackConfig, group: string, tUtcMs: number): Frame | null {
  const alert = selectAlertAt(config, group, tUtcMs);
  if (alert) return { sourceId: alert.id, contentId: alert.contentId };
  const win = selectWindowAt(config, group, tUtcMs);
  if (!win) return null;
  const playlist = playlistById(config, win.def.playlistId);
  return { sourceId: win.def.id, contentId: slideContentAt(win, playlist, tUtcMs) };
}

function sameFrame(a: Frame | null, b: Frame | null): boolean {
  if (a === null || b === null) return a === b;
  return a.sourceId === b.sourceId && a.contentId === b.contentId;
}

/** 返回完整覆盖 [fromUtcMs, toUtcMs) 的播放段序列。 */
export function timeline(
  config: PlaybackConfig,
  group: string,
  fromUtcMs: number,
  toUtcMs: number,
): TimelineSegment[] {
  if (fromUtcMs >= toUtcMs) return [];
  const boundaries = new Set<number>([fromUtcMs, toUtcMs]);
  const clip = (t: number) => t > fromUtcMs && t < toUtcMs;

  for (const a of config.alerts) {
    if (a.group !== group || a.endUtcMs <= fromUtcMs || a.startUtcMs >= toUtcMs) continue;
    if (clip(a.startUtcMs)) boundaries.add(a.startUtcMs);
    if (clip(a.endUtcMs)) boundaries.add(a.endUtcMs);
  }

  const instances = windowInstancesIntersecting(config, group, fromUtcMs, toUtcMs);
  for (const inst of instances) {
    if (clip(inst.startUtcMs)) boundaries.add(inst.startUtcMs);
    if (clip(inst.endUtcMs)) boundaries.add(inst.endUtcMs);
    // 该实例的全部幻灯片相位边界（被覆盖也无妨，相同帧会在后面合并）。
    const playlist = playlistById(config, inst.def.playlistId);
    const durations = playlist.slides.map((s) => s.durationSec * 1000);
    const cycle = durations.reduce((a, b) => a + b, 0);
    const lo = Math.max(inst.startUtcMs, fromUtcMs);
    const hi = Math.min(inst.endUtcMs, toUtcMs);
    let n = Math.floor((lo - inst.startUtcMs) / cycle);
    for (;;) {
      let t = inst.startUtcMs + n * cycle;
      let done = t >= hi;
      for (const d of durations) {
        if (t >= hi) {
          done = true;
          break;
        }
        if (t > lo) boundaries.add(t);
        t += d;
      }
      if (done) break;
      n++;
    }
  }

  const sorted = [...boundaries].sort((a, b) => a - b);
  const segments: TimelineSegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const frame = resolve(config, group, start);
    const last = segments[segments.length - 1];
    if (last && last.endUtcMs === start && sameFrame(last.frame, frame)) {
      last.endUtcMs = end;
    } else {
      segments.push({ startUtcMs: start, endUtcMs: end, frame });
    }
  }
  return segments;
}
