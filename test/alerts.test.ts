import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, timeline } from "../src/index.js";
import type { Config } from "../src/index.js";

const t = (iso: string): number => Date.parse(iso);

// 2025-06-10 is in EDT (UTC-4).
// w1 09:00-12:00 local -> 13:00:00Z..16:00:00Z, playlist [A 600s, B 600s].
// w2 12:00-15:00 local -> 16:00:00Z..19:00:00Z, playlist [C 600s, D 600s].
// Alert al1 15:30:00Z..16:30:00Z spans two slide switches of w1, the
// w1->w2 window switch at 16:00:00Z, and one slide switch of w2.
const config: Config = {
  playlists: [
    {
      id: "p1",
      group: "g",
      slides: [
        { contentId: "A", durationSec: 600 },
        { contentId: "B", durationSec: 600 },
      ],
    },
    {
      id: "p2",
      group: "g",
      slides: [
        { contentId: "C", durationSec: 600 },
        { contentId: "D", durationSec: 600 },
      ],
    },
  ],
  windows: [
    {
      id: "w1",
      group: "g",
      priority: 1,
      playlistId: "p1",
      startLocal: "09:00",
      endLocal: "12:00",
    },
    {
      id: "w2",
      group: "g",
      priority: 2,
      playlistId: "p2",
      startLocal: "12:00",
      endLocal: "15:00",
    },
  ],
  alerts: [
    {
      id: "al1",
      group: "g",
      contentId: "EMG",
      startUtc: t("2025-06-10T15:30:00.000Z"),
      endUtc: t("2025-06-10T16:30:00.000Z"),
    },
  ],
};

test("alert: overrides normal content at its exact bounds", () => {
  assert.deepEqual(resolve(config, "g", t("2025-06-10T15:29:59.999Z")), {
    sourceId: "w1",
    contentId: "A",
  });
  assert.deepEqual(resolve(config, "g", t("2025-06-10T15:30:00.000Z")), {
    sourceId: "al1",
    contentId: "EMG",
  });
  assert.deepEqual(resolve(config, "g", t("2025-06-10T16:29:59.999Z")), {
    sourceId: "al1",
    contentId: "EMG",
  });
});

test("alert: end restores the slide that should be live now, not the covered one", () => {
  // At 16:30:00Z window w2 has been live for 1800s of real time, so its
  // carousel is at position 600s -> slide D, even though the alert started
  // while w1/A was on screen.
  assert.deepEqual(resolve(config, "g", t("2025-06-10T16:30:00.000Z")), {
    sourceId: "w2",
    contentId: "D",
  });
});

test("alert: one continuous segment hides window and slide switches", () => {
  const segs = timeline(
    config,
    "g",
    t("2025-06-10T15:00:00.000Z"),
    t("2025-06-10T17:00:00.000Z")
  );
  assert.deepEqual(segs, [
    {
      startUtc: t("2025-06-10T15:00:00.000Z"),
      endUtc: t("2025-06-10T15:10:00.000Z"),
      frame: { sourceId: "w1", contentId: "A" },
    },
    {
      startUtc: t("2025-06-10T15:10:00.000Z"),
      endUtc: t("2025-06-10T15:20:00.000Z"),
      frame: { sourceId: "w1", contentId: "B" },
    },
    {
      startUtc: t("2025-06-10T15:20:00.000Z"),
      endUtc: t("2025-06-10T15:30:00.000Z"),
      frame: { sourceId: "w1", contentId: "A" },
    },
    {
      startUtc: t("2025-06-10T15:30:00.000Z"),
      endUtc: t("2025-06-10T16:30:00.000Z"),
      frame: { sourceId: "al1", contentId: "EMG" },
    },
    {
      startUtc: t("2025-06-10T16:30:00.000Z"),
      endUtc: t("2025-06-10T16:40:00.000Z"),
      frame: { sourceId: "w2", contentId: "D" },
    },
    {
      startUtc: t("2025-06-10T16:40:00.000Z"),
      endUtc: t("2025-06-10T16:50:00.000Z"),
      frame: { sourceId: "w2", contentId: "C" },
    },
    {
      startUtc: t("2025-06-10T16:50:00.000Z"),
      endUtc: t("2025-06-10T17:00:00.000Z"),
      frame: { sourceId: "w2", contentId: "D" },
    },
  ]);
});

// Overlapping alerts: latest start wins; equal start -> smallest id wins.
const overlapConfig: Config = {
  playlists: [],
  windows: [],
  alerts: [
    {
      id: "alA",
      group: "g",
      contentId: "E1",
      startUtc: t("2025-06-10T15:30:00.000Z"),
      endUtc: t("2025-06-10T16:30:00.000Z"),
    },
    {
      id: "alB",
      group: "g",
      contentId: "E2",
      startUtc: t("2025-06-10T15:45:00.000Z"),
      endUtc: t("2025-06-10T16:15:00.000Z"),
    },
    {
      id: "alC",
      group: "g",
      contentId: "E3",
      startUtc: t("2025-06-10T15:45:00.000Z"),
      endUtc: t("2025-06-10T16:00:00.000Z"),
    },
  ],
};

test("alert: overlapping alerts pick latest start, then smallest id", () => {
  assert.deepEqual(resolve(overlapConfig, "g", t("2025-06-10T15:44:59.999Z")), {
    sourceId: "alA",
    contentId: "E1",
  });
  // alB and alC start together; "alB" < "alC" so alB wins.
  assert.deepEqual(resolve(overlapConfig, "g", t("2025-06-10T15:45:00.000Z")), {
    sourceId: "alB",
    contentId: "E2",
  });
  assert.deepEqual(resolve(overlapConfig, "g", t("2025-06-10T16:14:59.999Z")), {
    sourceId: "alB",
    contentId: "E2",
  });
  assert.deepEqual(resolve(overlapConfig, "g", t("2025-06-10T16:15:00.000Z")), {
    sourceId: "alA",
    contentId: "E1",
  });
  assert.equal(resolve(overlapConfig, "g", t("2025-06-10T16:30:00.000Z")), null);
});

test("alert: exact timeline with overlapping alerts", () => {
  const segs = timeline(
    overlapConfig,
    "g",
    t("2025-06-10T15:00:00.000Z"),
    t("2025-06-10T17:00:00.000Z")
  );
  assert.deepEqual(segs, [
    {
      startUtc: t("2025-06-10T15:00:00.000Z"),
      endUtc: t("2025-06-10T15:30:00.000Z"),
      frame: null,
    },
    {
      startUtc: t("2025-06-10T15:30:00.000Z"),
      endUtc: t("2025-06-10T15:45:00.000Z"),
      frame: { sourceId: "alA", contentId: "E1" },
    },
    {
      startUtc: t("2025-06-10T15:45:00.000Z"),
      endUtc: t("2025-06-10T16:15:00.000Z"),
      frame: { sourceId: "alB", contentId: "E2" },
    },
    {
      startUtc: t("2025-06-10T16:15:00.000Z"),
      endUtc: t("2025-06-10T16:30:00.000Z"),
      frame: { sourceId: "alA", contentId: "E1" },
    },
    {
      startUtc: t("2025-06-10T16:30:00.000Z"),
      endUtc: t("2025-06-10T17:00:00.000Z"),
      frame: null,
    },
  ]);
});

test("alert: applies even with no windows and is group-scoped", () => {
  assert.deepEqual(resolve(overlapConfig, "g", t("2025-06-10T15:50:00.000Z")), {
    sourceId: "alB",
    contentId: "E2",
  });
  assert.equal(
    resolve(overlapConfig, "other-group", t("2025-06-10T15:50:00.000Z")),
    null
  );
});
