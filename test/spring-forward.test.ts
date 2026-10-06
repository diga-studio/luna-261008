import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, timeline } from "../src/index.js";
import type { Config } from "../src/index.js";

const t = (iso: string): number => Date.parse(iso);

// 2025-03-09: DST starts in America/New_York. 02:00-03:00 local does not
// exist; the UTC transition happens at 07:00:00Z (EST -5 -> EDT -4).
//
// w1 01:30-02:30 -> start 01:30 EST = 06:30:00Z; end 02:30 does not exist
//   and shifts forward by the missing hour to 03:30 EDT = 07:30:00Z.
// wE 02:30-03:00 -> start shifts to 03:30 EDT = 07:30:00Z, end 03:00 EDT
//   = 07:00:00Z, so end <= start and the window is empty for the day.
const config: Config = {
  playlists: [
    {
      id: "p1",
      group: "g",
      slides: [
        { contentId: "A", durationSec: 1800 },
        { contentId: "B", durationSec: 1800 },
      ],
    },
  ],
  windows: [
    {
      id: "w1",
      group: "g",
      priority: 1,
      playlistId: "p1",
      startLocal: "01:30",
      endLocal: "02:30",
    },
    {
      id: "wE",
      group: "g",
      priority: 4,
      playlistId: "p1",
      startLocal: "02:30",
      endLocal: "03:00",
    },
  ],
  alerts: [],
};

test("spring-forward: window start before the gap", () => {
  assert.equal(resolve(config, "g", t("2025-03-09T06:29:59.999Z")), null);
  assert.deepEqual(resolve(config, "g", t("2025-03-09T06:30:00.000Z")), {
    sourceId: "w1",
    contentId: "A",
  });
});

test("spring-forward: slide phase uses real elapsed time across the gap", () => {
  // 1800s of real time after 06:30:00Z is 07:00:00Z (the clock jumps).
  assert.deepEqual(resolve(config, "g", t("2025-03-09T06:59:59.999Z")), {
    sourceId: "w1",
    contentId: "A",
  });
  assert.deepEqual(resolve(config, "g", t("2025-03-09T07:00:00.000Z")), {
    sourceId: "w1",
    contentId: "B",
  });
});

test("spring-forward: shifted end is exclusive and window becomes idle", () => {
  assert.deepEqual(resolve(config, "g", t("2025-03-09T07:29:59.999Z")), {
    sourceId: "w1",
    contentId: "B",
  });
  assert.equal(resolve(config, "g", t("2025-03-09T07:30:00.000Z")), null);
});

test("spring-forward: window that converts to empty never wins", () => {
  // wE has higher priority (4) but is empty today, so w1 must show.
  assert.deepEqual(resolve(config, "g", t("2025-03-09T07:15:00.000Z")), {
    sourceId: "w1",
    contentId: "B",
  });
  for (const iso of [
    "2025-03-09T06:59:00.000Z",
    "2025-03-09T07:00:00.000Z",
    "2025-03-09T07:29:00.000Z",
  ]) {
    assert.equal(resolve(config, "g", t(iso))?.sourceId, "w1");
  }
});

test("spring-forward: exact timeline segmentation", () => {
  const segs = timeline(
    config,
    "g",
    t("2025-03-09T06:00:00.000Z"),
    t("2025-03-09T08:00:00.000Z")
  );
  assert.deepEqual(segs, [
    { startUtc: t("2025-03-09T06:00:00.000Z"), endUtc: t("2025-03-09T06:30:00.000Z"), frame: null },
    {
      startUtc: t("2025-03-09T06:30:00.000Z"),
      endUtc: t("2025-03-09T07:00:00.000Z"),
      frame: { sourceId: "w1", contentId: "A" },
    },
    {
      startUtc: t("2025-03-09T07:00:00.000Z"),
      endUtc: t("2025-03-09T07:30:00.000Z"),
      frame: { sourceId: "w1", contentId: "B" },
    },
    { startUtc: t("2025-03-09T07:30:00.000Z"), endUtc: t("2025-03-09T08:00:00.000Z"), frame: null },
  ]);
});
