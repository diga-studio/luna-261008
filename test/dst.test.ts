import { describe, expect, it } from "vitest";
import { resolve, timeline, type PlaybackConfig } from "../src/index.js";

const Z = (s: string) => Date.parse(s);

const plX = { id: "plX", slides: [{ contentId: "X", durationSec: 60 }] };

describe("2025-03-09 春季跳时（EDT 开始，02:00->03:00）", () => {
  it("不存在的起点 02:30 前移缺失时长到 03:30（=07:30Z）", () => {
    const cfg: PlaybackConfig = {
      playlists: [plX],
      windows: [
        { id: "wA", group: "g", priority: 1, playlistId: "plX", startLocal: "02:30", endLocal: "04:00" },
      ],
      alerts: [],
    };
    // 窗口实际为 [2025-03-09T07:30:00Z, 2025-03-09T08:00:00Z)
    expect(resolve(cfg, "g", Z("2025-03-09T07:29:59.999Z"))).toBeNull();
    expect(resolve(cfg, "g", Z("2025-03-09T07:30:00.000Z"))).toEqual({ sourceId: "wA", contentId: "X" });
    expect(resolve(cfg, "g", Z("2025-03-09T07:59:59.999Z"))).toEqual({ sourceId: "wA", contentId: "X" });
    expect(resolve(cfg, "g", Z("2025-03-09T08:00:00.000Z"))).toBeNull();
  });

  it("不存在的终点 02:30 同样前移（01:30-02:30 -> [06:30Z, 07:30Z)）", () => {
    const cfg: PlaybackConfig = {
      playlists: [plX],
      windows: [
        { id: "wB", group: "g", priority: 1, playlistId: "plX", startLocal: "01:30", endLocal: "02:30" },
      ],
      alerts: [],
    };
    expect(resolve(cfg, "g", Z("2025-03-09T06:29:59.999Z"))).toBeNull();
    expect(resolve(cfg, "g", Z("2025-03-09T06:30:00.000Z"))).toEqual({ sourceId: "wB", contentId: "X" });
    expect(resolve(cfg, "g", Z("2025-03-09T07:29:59.999Z"))).toEqual({ sourceId: "wB", contentId: "X" });
    expect(resolve(cfg, "g", Z("2025-03-09T07:30:00.000Z"))).toBeNull();
  });

  it("转换后终点不晚于起点的窗口为空（02:30-03:00 -> [07:30Z, 07:00Z]），且不延展到次日", () => {
    const cfg: PlaybackConfig = {
      playlists: [plX],
      windows: [
        { id: "wEmpty", group: "g", priority: 1, playlistId: "plX", startLocal: "02:30", endLocal: "03:00" },
      ],
      alerts: [],
    };
    // 当天任何时刻都为空
    expect(resolve(cfg, "g", Z("2025-03-09T07:00:00.000Z"))).toBeNull();
    expect(resolve(cfg, "g", Z("2025-03-09T07:15:00.000Z"))).toBeNull();
    expect(resolve(cfg, "g", Z("2025-03-09T07:30:00.000Z"))).toBeNull();
    // 不得延展到 3 月 10 日
    expect(resolve(cfg, "g", Z("2025-03-10T07:15:00.000Z"))).toBeNull();
    // timeline 整段空闲
    expect(timeline(cfg, "g", Z("2025-03-09T06:00:00Z"), Z("2025-03-09T09:00:00Z"))).toEqual([
      { startUtcMs: Z("2025-03-09T06:00:00Z"), endUtcMs: Z("2025-03-09T09:00:00Z"), frame: null },
    ]);
  });
});

describe("2025-11-02 秋季回拨（EST 开始，02:00->01:00）", () => {
  it("跨午夜窗口为同一实例，覆盖 UTC 午夜两侧", () => {
    const cfg: PlaybackConfig = {
      playlists: [plX],
      windows: [
        { id: "wC", group: "g", priority: 1, playlistId: "plX", startLocal: "22:00", endLocal: "02:00" },
      ],
      alerts: [],
    };
    // 11-01 22:00 EDT = 11-02T02:00Z；11-02 02:00 EST = 11-02T07:00Z
    expect(resolve(cfg, "g", Z("2025-11-02T01:59:59.999Z"))).toBeNull();
    expect(resolve(cfg, "g", Z("2025-11-02T02:00:00.000Z"))).toEqual({ sourceId: "wC", contentId: "X" });
    // UTC 午夜前后、回拨瞬间两侧都是同一窗口实例
    expect(resolve(cfg, "g", Z("2025-11-02T05:30:00.000Z"))).toEqual({ sourceId: "wC", contentId: "X" });
    expect(resolve(cfg, "g", Z("2025-11-02T06:30:00.000Z"))).toEqual({ sourceId: "wC", contentId: "X" });
    expect(resolve(cfg, "g", Z("2025-11-02T06:59:59.999Z"))).toEqual({ sourceId: "wC", contentId: "X" });
    expect(resolve(cfg, "g", Z("2025-11-02T07:00:00.000Z"))).toBeNull();
  });

  it("重复钟面时刻：起点取较早瞬间，终点取较晚瞬间", () => {
    const cfg: PlaybackConfig = {
      playlists: [plX],
      windows: [
        { id: "wD", group: "g", priority: 1, playlistId: "plX", startLocal: "01:30", endLocal: "03:00" },
      ],
      alerts: [],
    };
    // 01:30 出现两次：05:30Z(EDT) 与 06:30Z(EST)，起点取 05:30Z；03:00 EST = 08:00Z
    expect(resolve(cfg, "g", Z("2025-11-02T05:29:59.999Z"))).toBeNull();
    expect(resolve(cfg, "g", Z("2025-11-02T05:30:00.000Z"))).toEqual({ sourceId: "wD", contentId: "X" });
    expect(resolve(cfg, "g", Z("2025-11-02T07:59:59.999Z"))).toEqual({ sourceId: "wD", contentId: "X" });
    expect(resolve(cfg, "g", Z("2025-11-02T08:00:00.000Z"))).toBeNull();
  });

  it("轮播按真实经过时长计时，而非钟面差值", () => {
    const cfg: PlaybackConfig = {
      playlists: [
        {
          id: "plE",
          slides: [
            { contentId: "A", durationSec: 100 },
            { contentId: "B", durationSec: 50 },
          ],
        },
      ],
      windows: [
        { id: "wE", group: "g", priority: 1, playlistId: "plE", startLocal: "01:00", endLocal: "02:00" },
      ],
      alerts: [],
    };
    // 窗口实际 [05:00Z, 07:00Z)，真实 2 小时；周期 150s
    expect(resolve(cfg, "g", Z("2025-11-02T05:00:00.000Z"))).toEqual({ sourceId: "wE", contentId: "A" });
    expect(resolve(cfg, "g", Z("2025-11-02T05:01:40.000Z"))).toEqual({ sourceId: "wE", contentId: "B" });
    // 06:01:55Z：真实经过 3715s，3715 % 150 = 115 -> B；若按钟面差 615s % 150 = 15 会错成 A
    expect(resolve(cfg, "g", Z("2025-11-02T06:01:55.000Z"))).toEqual({ sourceId: "wE", contentId: "B" });
    // 06:02:30Z：真实经过 3750s，3750 % 150 = 0 -> A
    expect(resolve(cfg, "g", Z("2025-11-02T06:02:29.999Z"))).toEqual({ sourceId: "wE", contentId: "B" });
    expect(resolve(cfg, "g", Z("2025-11-02T06:02:30.000Z"))).toEqual({ sourceId: "wE", contentId: "A" });
    // 精确分段（[06:00Z, 06:03Z)）
    expect(timeline(cfg, "g", Z("2025-11-02T06:00:00Z"), Z("2025-11-02T06:03:00Z"))).toEqual([
      { startUtcMs: Z("2025-11-02T06:00:00Z"), endUtcMs: Z("2025-11-02T06:01:40Z"), frame: { sourceId: "wE", contentId: "A" } },
      { startUtcMs: Z("2025-11-02T06:01:40Z"), endUtcMs: Z("2025-11-02T06:02:30Z"), frame: { sourceId: "wE", contentId: "B" } },
      { startUtcMs: Z("2025-11-02T06:02:30Z"), endUtcMs: Z("2025-11-02T06:03:00Z"), frame: { sourceId: "wE", contentId: "A" } },
    ]);
  });
});
