import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, timeline } from "../src/index.js";
import type { Config } from "../src/index.js";

const t = (iso: string): number => Date.parse(iso);

// 2025-11-02: DST ends in America/New_York. 01:00-02:00 local happens
// twice: 05:00-06:00Z (EDT) and 06:00-07:00Z (EST). The UTC transition
// happens at 06:00:00Z.
//
// w1 22:00-02:00 (cross-midnight), instance for local date 2025-11-01:
//   start 22:00 EDT = 2025-11-02T02:00:00Z, end 02:00 EST = 07:00:00Z.
//   Real span is 9h although the clock difference is 4h.
// w2 01:30-02:30: start 01:30 is repeated -> earlier instant 05:30:00Z;
//   end 02:30 EST = 07:30:00Z.
// w3 00:30-01:30: start 00:30 EDT = 04:30:00Z; end 01:30 is repeated ->
//   later instant 06:30:00Z.

const playlistAB = {
  id: "pAB",
  group: "g",
  slides: [
    { contentId: "A", durationSec: 3600 },
    { contentId: "B", durationSec: 3600 },
  ],
};
const playlistC = {
  id: "pC",
  group: "g",
  slides: [{ contentId: "C", durationSec: 60 }],
};
const playlistD = {
  id: "pD",
  group: "g",
  slides: [{ contentId: "D", durationSec: 3600 }],
};
const w1 = {
  id: "w1",
  group: "g",
  priority: 1,
  playlistId: "pAB",
  startLocal: "22:00",
  endLocal: "02:00",
};
const w2 = {
  id: "w2",
  group: "g",
  priority: 2,
  playlistId: "pC",
  startLocal: "01:30",
  endLocal: "02:30",
};
const w3 = {
  id: "w3",
  group: "g",
  priority: 3,
  playlistId: "pD",
  startLocal: "00:30",
  endLocal: "01:30",
};

const configW1: Config = { playlists: [playlistAB], windows: [w1], alerts: [] };
const configW2: Config = { playlists: [playlistC], windows: [w2], alerts: [] };
const configW3: Config = { playlists: [playlistD], windows: [w3], alerts: [] };
const configAll: Config = {
  playlists: [playlistAB, playlistC, playlistD],
  windows: [w1, w2, w3],
  alerts: [],
};

test("fall-back: cross-midnight window starts the evening before", () => {
  assert.equal(resolve(configW1, "g", t("2025-11-02T01:59:59.999Z")), null);
  assert.deepEqual(resolve(configW1, "g", t("2025-11-02T02:00:00.000Z")), {
    sourceId: "w1",
    contentId: "A",
  });
});

test("fall-back: carousel phase uses real elapsed time, not clock difference", () => {
  // 4h of real time after 02:00:00Z is 06:00:00Z, but the local clock only
  // advanced 3h (23:00 EDT -> 01:00 EST is wrong; it reads 22:00 -> 01:00).
  // Real elapsed 14399.999s -> still slide B; 14400s -> slide A.
  assert.deepEqual(resolve(configW1, "g", t("2025-11-02T05:59:59.999Z")), {
    sourceId: "w1",
    contentId: "B",
  });
  assert.deepEqual(resolve(configW1, "g", t("2025-11-02T06:00:00.000Z")), {
    sourceId: "w1",
    contentId: "A",
  });
  assert.deepEqual(resolve(configW1, "g", t("2025-11-02T06:59:59.999Z")), {
    sourceId: "w1",
    contentId: "A",
  });
  assert.equal(resolve(configW1, "g", t("2025-11-02T07:00:00.000Z")), null);
});

test("fall-back: repeated start wall time takes the earlier instant", () => {
  assert.equal(resolve(configW2, "g", t("2025-11-02T05:29:59.999Z")), null);
  assert.deepEqual(resolve(configW2, "g", t("2025-11-02T05:30:00.000Z")), {
    sourceId: "w2",
    contentId: "C",
  });
  assert.deepEqual(resolve(configW2, "g", t("2025-11-02T07:29:59.999Z")), {
    sourceId: "w2",
    contentId: "C",
  });
  assert.equal(resolve(configW2, "g", t("2025-11-02T07:30:00.000Z")), null);
});

test("fall-back: repeated end wall time takes the later instant", () => {
  assert.equal(resolve(configW3, "g", t("2025-11-02T04:29:59.999Z")), null);
  assert.deepEqual(resolve(configW3, "g", t("2025-11-02T04:30:00.000Z")), {
    sourceId: "w3",
    contentId: "D",
  });
  assert.deepEqual(resolve(configW3, "g", t("2025-11-02T06:29:59.999Z")), {
    sourceId: "w3",
    contentId: "D",
  });
  assert.equal(resolve(configW3, "g", t("2025-11-02T06:30:00.000Z")), null);
});

test("fall-back: overlapping windows pick highest priority, exact timeline", () => {
  // Priorities: w3 (3) > w2 (2) > w1 (1).
  assert.deepEqual(resolve(configAll, "g", t("2025-11-02T04:29:59.999Z")), {
    sourceId: "w1",
    contentId: "A",
  });
  assert.deepEqual(resolve(configAll, "g", t("2025-11-02T04:30:00.000Z")), {
    sourceId: "w3",
    contentId: "D",
  });
  assert.deepEqual(resolve(configAll, "g", t("2025-11-02T06:29:59.999Z")), {
    sourceId: "w3",
    contentId: "D",
  });
  assert.deepEqual(resolve(configAll, "g", t("2025-11-02T06:30:00.000Z")), {
    sourceId: "w2",
    contentId: "C",
  });
  const segs = timeline(
    configAll,
    "g",
    t("2025-11-02T04:00:00.000Z"),
    t("2025-11-02T08:00:00.000Z")
  );
  assert.deepEqual(segs, [
    {
      startUtc: t("2025-11-02T04:00:00.000Z"),
      endUtc: t("2025-11-02T04:30:00.000Z"),
      frame: { sourceId: "w1", contentId: "A" },
    },
    {
      startUtc: t("2025-11-02T04:30:00.000Z"),
      endUtc: t("2025-11-02T06:30:00.000Z"),
      frame: { sourceId: "w3", contentId: "D" },
    },
    {
      startUtc: t("2025-11-02T06:30:00.000Z"),
      endUtc: t("2025-11-02T07:30:00.000Z"),
      frame: { sourceId: "w2", contentId: "C" },
    },
    {
      startUtc: t("2025-11-02T07:30:00.000Z"),
      endUtc: t("2025-11-02T08:00:00.000Z"),
      frame: null,
    },
  ]);
});
