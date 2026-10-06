import { describe, expect, it } from "vitest";
import { resolve, timeline, type PlaybackConfig } from "../src/index.js";

const Z = (s: string) => Date.parse(s);

function expectConsistent(cfg: PlaybackConfig, group: string, from: number, to: number) {
  const segs = timeline(cfg, group, from, to);
  // 完整覆盖、无空洞无重叠
  expect(segs.length).toBeGreaterThan(0);
  expect(segs[0].startUtcMs).toBe(from);
  expect(segs[segs.length - 1].endUtcMs).toBe(to);
  for (let i = 0; i < segs.length; i++) {
    expect(segs[i].startUtcMs).toBeLessThan(segs[i].endUtcMs);
    if (i > 0) expect(segs[i].startUtcMs).toBe(segs[i - 1].endUtcMs);
    // 相邻段 frame 必不相同（相同应已合并）
    if (i > 0) expect(segs[i].frame).not.toEqual(segs[i - 1].frame);
    // 段内任意瞬间的 resolve 与段一致：起点、中点、终点前 1ms
    const mid = segs[i].startUtcMs + Math.floor((segs[i].endUtcMs - segs[i].startUtcMs) / 2);
    for (const t of [segs[i].startUtcMs, mid, segs[i].endUtcMs - 1]) {
      expect(resolve(cfg, group, t)).toEqual(segs[i].frame);
    }
  }
  return segs;
}

describe("timeline 不变量", () => {
  it("复杂配置下分段连续且与 resolve 一致", () => {
    const complex: PlaybackConfig = {
      playlists: [
        {
          id: "pl1",
          slides: [
            { contentId: "A", durationSec: 7 },
            { contentId: "B", durationSec: 13 },
            { contentId: "A", durationSec: 5 },
          ],
        },
        { id: "pl2", slides: [{ contentId: "C", durationSec: 30 }] },
      ],
      windows: [
        { id: "w1", group: "g", priority: 1, playlistId: "pl1", startLocal: "08:00", endLocal: "20:00" },
        { id: "w2", group: "g", priority: 2, playlistId: "pl2", startLocal: "12:00", endLocal: "13:00" },
      ],
      alerts: [
        { id: "al1", group: "g", contentId: "E", startUtcMs: Z("2025-06-10T15:00:00Z"), endUtcMs: Z("2025-06-10T18:30:00Z") },
      ],
    };
    // 跨越窗口开始、告警、窗口切换的一整天
    expectConsistent(complex, "g", Z("2025-06-10T10:00:00Z"), Z("2025-06-11T02:00:00Z"));
    // 跨回拨日（2025-11-02）与跨午夜窗口
    const dstCfg: PlaybackConfig = {
      playlists: [
        {
          id: "pl1",
          slides: [
            { contentId: "A", durationSec: 100 },
            { contentId: "B", durationSec: 50 },
          ],
        },
      ],
      windows: [
        { id: "w1", group: "g", priority: 1, playlistId: "pl1", startLocal: "22:00", endLocal: "02:00" },
        { id: "w2", group: "g", priority: 2, playlistId: "pl1", startLocal: "01:30", endLocal: "03:00" },
      ],
      alerts: [
        { id: "al1", group: "g", contentId: "E", startUtcMs: Z("2025-11-02T05:00:00Z"), endUtcMs: Z("2025-11-02T06:30:00Z") },
      ],
    };
    expectConsistent(dstCfg, "g", Z("2025-11-02T00:00:00Z"), Z("2025-11-02T12:00:00Z"));
    // 跨跳时日（2025-03-09）
    expectConsistent(dstCfg, "g", Z("2025-03-09T04:00:00Z"), Z("2025-03-09T12:00:00Z"));
  });

  it("重复 contentId 的相邻幻灯片合并为一段", () => {
    const dupCfg: PlaybackConfig = {
      playlists: [
        {
          id: "plDup",
          slides: [
            { contentId: "A", durationSec: 10 },
            { contentId: "A", durationSec: 10 },
            { contentId: "B", durationSec: 10 },
          ],
        },
      ],
      windows: [
        { id: "wDup", group: "g", priority: 1, playlistId: "plDup", startLocal: "10:00", endLocal: "10:01" },
      ],
      alerts: [],
    };
    // 10:00 EDT = 14:00Z；窗口 60s：A(10) A(10) B(10) 循环两周
    expect(timeline(dupCfg, "g", Z("2025-06-10T14:00:00Z"), Z("2025-06-10T14:01:00Z"))).toEqual([
      { startUtcMs: Z("2025-06-10T14:00:00Z"), endUtcMs: Z("2025-06-10T14:00:20Z"), frame: { sourceId: "wDup", contentId: "A" } },
      { startUtcMs: Z("2025-06-10T14:00:20Z"), endUtcMs: Z("2025-06-10T14:00:30Z"), frame: { sourceId: "wDup", contentId: "B" } },
      { startUtcMs: Z("2025-06-10T14:00:30Z"), endUtcMs: Z("2025-06-10T14:00:50Z"), frame: { sourceId: "wDup", contentId: "A" } },
      { startUtcMs: Z("2025-06-10T14:00:50Z"), endUtcMs: Z("2025-06-10T14:01:00Z"), frame: { sourceId: "wDup", contentId: "B" } },
    ]);
  });

  it("相邻空闲段合并，空配置整段空闲", () => {
    const cfg: PlaybackConfig = {
      playlists: [{ id: "plX", slides: [{ contentId: "X", durationSec: 60 }] }],
      windows: [
        { id: "w1", group: "g", priority: 1, playlistId: "plX", startLocal: "08:00", endLocal: "08:10" },
      ],
      alerts: [],
    };
    const segs = timeline(cfg, "g", Z("2025-06-10T11:00:00Z"), Z("2025-06-10T13:00:00Z"));
    expect(segs).toEqual([
      { startUtcMs: Z("2025-06-10T11:00:00Z"), endUtcMs: Z("2025-06-10T12:00:00Z"), frame: null },
      { startUtcMs: Z("2025-06-10T12:00:00Z"), endUtcMs: Z("2025-06-10T12:10:00Z"), frame: { sourceId: "w1", contentId: "X" } },
      { startUtcMs: Z("2025-06-10T12:10:00Z"), endUtcMs: Z("2025-06-10T13:00:00Z"), frame: null },
    ]);
    // 完全无窗口的 group
    expect(timeline({ playlists: [], windows: [], alerts: [] }, "nobody", 0, 5000)).toEqual([
      { startUtcMs: 0, endUtcMs: 5000, frame: null },
    ]);
  });

  it("同一配置与时间多次调用结果相同（无隐藏状态）", () => {
    const cfg2: PlaybackConfig = {
      playlists: [{ id: "pl1", slides: [{ contentId: "A", durationSec: 10 }] }],
      windows: [{ id: "w1", group: "g", priority: 1, playlistId: "pl1", startLocal: "08:00", endLocal: "09:00" }],
      alerts: [],
    };
    const t = Z("2025-06-10T12:34:56Z");
    const first = resolve(cfg2, "g", t);
    timeline(cfg2, "g", Z("2025-06-10T00:00:00Z"), Z("2025-06-11T00:00:00Z"));
    expect(resolve(cfg2, "g", t)).toEqual(first);
  });
});
