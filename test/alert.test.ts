import { describe, expect, it } from "vitest";
import { resolve, timeline, type PlaybackConfig } from "../src/index.js";

const Z = (s: string) => Date.parse(s);

// 2025-06-10 为 EDT（UTC-4）：08:00 本地 = 12:00Z。
// w1: [12:00Z,13:00Z) 播 pl1 = A(10s) B(10s) A(10s)，周期 30s，含重复 contentId。
// w2: [12:30Z,12:40Z) 优先级更高，播 pl2 = C(30s)。
const base: PlaybackConfig = {
  playlists: [
    {
      id: "pl1",
      slides: [
        { contentId: "A", durationSec: 10 },
        { contentId: "B", durationSec: 10 },
        { contentId: "A", durationSec: 10 },
      ],
    },
    { id: "pl2", slides: [{ contentId: "C", durationSec: 30 }] },
  ],
  windows: [
    { id: "w1", group: "g", priority: 1, playlistId: "pl1", startLocal: "08:00", endLocal: "09:00" },
    { id: "w2", group: "g", priority: 2, playlistId: "pl2", startLocal: "08:30", endLocal: "08:40" },
  ],
  alerts: [],
};

describe("紧急告警", () => {
  it("跨越窗口切换与多次幻灯片切换的告警只有一个连续段，结束后恢复正确相位", () => {
    const cfg: PlaybackConfig = {
      ...base,
      alerts: [
        { id: "al1", group: "g", contentId: "E", startUtcMs: Z("2025-06-10T12:25:00Z"), endUtcMs: Z("2025-06-10T12:35:00Z") },
      ],
    };
    // 边界前 1ms 与边界本身
    expect(resolve(cfg, "g", Z("2025-06-10T12:24:59.999Z"))).toEqual({ sourceId: "w1", contentId: "A" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:25:00.000Z"))).toEqual({ sourceId: "al1", contentId: "E" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:34:59.999Z"))).toEqual({ sourceId: "al1", contentId: "E" });
    // 告警结束瞬间：w2 已生效（12:30 起），相位从 12:30 算 -> C
    expect(resolve(cfg, "g", Z("2025-06-10T12:35:00.000Z"))).toEqual({ sourceId: "w2", contentId: "C" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:39:59.999Z"))).toEqual({ sourceId: "w2", contentId: "C" });
    // w2 结束后回到 w1：经过 2400s，2400 % 30 = 0 -> A（不是告警前那张的延续）
    expect(resolve(cfg, "g", Z("2025-06-10T12:40:00.000Z"))).toEqual({ sourceId: "w1", contentId: "A" });

    // 精确分段：告警期间只有一段；w1 周期末尾的 A 与下周期开头的 A 合并
    expect(timeline(cfg, "g", Z("2025-06-10T12:24:00Z"), Z("2025-06-10T12:41:00Z"))).toEqual([
      { startUtcMs: Z("2025-06-10T12:24:00Z"), endUtcMs: Z("2025-06-10T12:24:10Z"), frame: { sourceId: "w1", contentId: "A" } },
      { startUtcMs: Z("2025-06-10T12:24:10Z"), endUtcMs: Z("2025-06-10T12:24:20Z"), frame: { sourceId: "w1", contentId: "B" } },
      { startUtcMs: Z("2025-06-10T12:24:20Z"), endUtcMs: Z("2025-06-10T12:24:40Z"), frame: { sourceId: "w1", contentId: "A" } },
      { startUtcMs: Z("2025-06-10T12:24:40Z"), endUtcMs: Z("2025-06-10T12:24:50Z"), frame: { sourceId: "w1", contentId: "B" } },
      { startUtcMs: Z("2025-06-10T12:24:50Z"), endUtcMs: Z("2025-06-10T12:25:00Z"), frame: { sourceId: "w1", contentId: "A" } },
      { startUtcMs: Z("2025-06-10T12:25:00Z"), endUtcMs: Z("2025-06-10T12:35:00Z"), frame: { sourceId: "al1", contentId: "E" } },
      { startUtcMs: Z("2025-06-10T12:35:00Z"), endUtcMs: Z("2025-06-10T12:40:00Z"), frame: { sourceId: "w2", contentId: "C" } },
      { startUtcMs: Z("2025-06-10T12:40:00Z"), endUtcMs: Z("2025-06-10T12:40:10Z"), frame: { sourceId: "w1", contentId: "A" } },
      { startUtcMs: Z("2025-06-10T12:40:10Z"), endUtcMs: Z("2025-06-10T12:40:20Z"), frame: { sourceId: "w1", contentId: "B" } },
      { startUtcMs: Z("2025-06-10T12:40:20Z"), endUtcMs: Z("2025-06-10T12:40:40Z"), frame: { sourceId: "w1", contentId: "A" } },
      { startUtcMs: Z("2025-06-10T12:40:40Z"), endUtcMs: Z("2025-06-10T12:40:50Z"), frame: { sourceId: "w1", contentId: "B" } },
      { startUtcMs: Z("2025-06-10T12:40:50Z"), endUtcMs: Z("2025-06-10T12:41:00Z"), frame: { sourceId: "w1", contentId: "A" } },
    ]);
  });

  it("告警结束后显示此刻应生效的幻灯片，而不是恢复覆盖前那张", () => {
    const cfg: PlaybackConfig = {
      ...base,
      alerts: [
        { id: "al2", group: "g", contentId: "E2", startUtcMs: Z("2025-06-10T12:05:00Z"), endUtcMs: Z("2025-06-10T12:07:45Z") },
      ],
    };
    // 覆盖前最后一张：12:04:59.999 经过 299.999s -> A（20~30s 格）
    expect(resolve(cfg, "g", Z("2025-06-10T12:04:59.999Z"))).toEqual({ sourceId: "w1", contentId: "A" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:07:44.999Z"))).toEqual({ sourceId: "al2", contentId: "E2" });
    // 结束后：经过 465s，465 % 30 = 15 -> B，而非恢复 A
    expect(resolve(cfg, "g", Z("2025-06-10T12:07:45.000Z"))).toEqual({ sourceId: "w1", contentId: "B" });
  });

  it("重叠告警选起点较晚者，起点相同选 id 字典序最小者", () => {
    const cfg: PlaybackConfig = {
      ...base,
      alerts: [
        { id: "al-a", group: "g", contentId: "EA", startUtcMs: Z("2025-06-10T12:10:00Z"), endUtcMs: Z("2025-06-10T12:20:00Z") },
        { id: "al-b", group: "g", contentId: "EB", startUtcMs: Z("2025-06-10T12:15:00Z"), endUtcMs: Z("2025-06-10T12:18:00Z") },
        { id: "al-d", group: "g", contentId: "ED", startUtcMs: Z("2025-06-10T12:50:00Z"), endUtcMs: Z("2025-06-10T12:55:00Z") },
        { id: "al-c", group: "g", contentId: "EC", startUtcMs: Z("2025-06-10T12:50:00Z"), endUtcMs: Z("2025-06-10T12:55:00Z") },
      ],
    };
    expect(resolve(cfg, "g", Z("2025-06-10T12:14:59.999Z"))).toEqual({ sourceId: "al-a", contentId: "EA" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:15:00.000Z"))).toEqual({ sourceId: "al-b", contentId: "EB" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:17:59.999Z"))).toEqual({ sourceId: "al-b", contentId: "EB" });
    // 内层告警结束后回到外层告警
    expect(resolve(cfg, "g", Z("2025-06-10T12:18:00.000Z"))).toEqual({ sourceId: "al-a", contentId: "EA" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:19:59.999Z"))).toEqual({ sourceId: "al-a", contentId: "EA" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:20:00.000Z"))).toEqual({ sourceId: "w1", contentId: "A" });
    // 同起点并列：id 字典序最小者 al-c
    expect(resolve(cfg, "g", Z("2025-06-10T12:50:00.000Z"))).toEqual({ sourceId: "al-c", contentId: "EC" });
  });

  it("告警只覆盖同 group，其他 group 不受影响", () => {
    const cfg: PlaybackConfig = {
      ...base,
      alerts: [
        { id: "al1", group: "other", contentId: "E", startUtcMs: Z("2025-06-10T12:25:00Z"), endUtcMs: Z("2025-06-10T12:35:00Z") },
      ],
    };
    expect(resolve(cfg, "g", Z("2025-06-10T12:30:00.000Z"))).toEqual({ sourceId: "w2", contentId: "C" });
    expect(resolve(cfg, "other", Z("2025-06-10T12:30:00.000Z"))).toEqual({ sourceId: "al1", contentId: "E" });
  });
});

describe("窗口选择", () => {
  const pl = (id: string, contentId: string) => ({ id, slides: [{ contentId, durationSec: 30 }] });

  it("同时有效时选 priority 最高者", () => {
    const cfg: PlaybackConfig = {
      playlists: [pl("plLo", "L"), pl("plHi", "H")],
      windows: [
        { id: "w-lo", group: "g", priority: 1, playlistId: "plLo", startLocal: "08:10", endLocal: "08:50" },
        { id: "w-hi", group: "g", priority: 3, playlistId: "plHi", startLocal: "08:20", endLocal: "08:30" },
      ],
      alerts: [],
    };
    expect(resolve(cfg, "g", Z("2025-06-10T12:19:59.999Z"))).toEqual({ sourceId: "w-lo", contentId: "L" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:20:00.000Z"))).toEqual({ sourceId: "w-hi", contentId: "H" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:29:59.999Z"))).toEqual({ sourceId: "w-hi", contentId: "H" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:30:00.000Z"))).toEqual({ sourceId: "w-lo", contentId: "L" });
  });

  it("priority 并列时选 id 字典序最小者", () => {
    const cfg: PlaybackConfig = {
      playlists: [pl("plA", "TA"), pl("plB", "TB")],
      windows: [
        { id: "w-tie-b", group: "g", priority: 2, playlistId: "plB", startLocal: "08:20", endLocal: "08:30" },
        { id: "w-tie-a", group: "g", priority: 2, playlistId: "plA", startLocal: "08:20", endLocal: "08:30" },
      ],
      alerts: [],
    };
    expect(resolve(cfg, "g", Z("2025-06-10T12:25:00.000Z"))).toEqual({ sourceId: "w-tie-a", contentId: "TA" });
  });

  it("被高优先级窗口覆盖期间，底层轮播继续计时不重启", () => {
    const cfg: PlaybackConfig = {
      playlists: [
        {
          id: "plMain",
          slides: [
            { contentId: "A", durationSec: 10 },
            { contentId: "B", durationSec: 10 },
          ],
        },
        pl("plTop", "T"),
      ],
      windows: [
        { id: "w-main", group: "g", priority: 1, playlistId: "plMain", startLocal: "08:00", endLocal: "09:00" },
        { id: "w-top", group: "g", priority: 4, playlistId: "plTop", startLocal: "08:20", endLocal: "08:30" },
      ],
      alerts: [],
    };
    // w-main 从 12:00Z 起，周期 20s。w-top 覆盖 [12:20Z,12:30Z)。
    expect(resolve(cfg, "g", Z("2025-06-10T12:19:59.999Z"))).toEqual({ sourceId: "w-main", contentId: "B" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:20:00.000Z"))).toEqual({ sourceId: "w-top", contentId: "T" });
    // 12:30Z 时底层经过 1800s，1800 % 20 = 0 -> A；若被暂停/重启则相位会不同
    expect(resolve(cfg, "g", Z("2025-06-10T12:30:00.000Z"))).toEqual({ sourceId: "w-main", contentId: "A" });
    expect(resolve(cfg, "g", Z("2025-06-10T12:30:10.000Z"))).toEqual({ sourceId: "w-main", contentId: "B" });
  });
});
