import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, timeline } from "../src/index.js";
import type { Config } from "../src/index.js";

const t = (iso: string): number => Date.parse(iso);

// 2025-06-10 is in EDT (UTC-4): 09:00 local = 13:00:00Z.
// Playlist has adjacent slides with the same contentId.
const dupConfig: Config = {
  playlists: [
    {
      id: "p1",
      group: "g",
      slides: [
        { contentId: "X", durationSec: 10 },
        { contentId: "X", durationSec: 10 },
        { contentId: "Y", durationSec: 10 },
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
      endLocal: "09:05",
    },
  ],
  alerts: [],
};

test("rotation: repeated contentId does not create extra segments", () => {
  const segs = timeline(
    dupConfig,
    "g",
    t("2025-06-10T13:00:00.000Z"),
    t("2025-06-10T13:01:00.000Z")
  );
  assert.deepEqual(segs, [
    {
      startUtc: t("2025-06-10T13:00:00.000Z"),
      endUtc: t("2025-06-10T13:00:20.000Z"),
      frame: { sourceId: "w1", contentId: "X" },
    },
    {
      startUtc: t("2025-06-10T13:00:20.000Z"),
      endUtc: t("2025-06-10T13:00:30.000Z"),
      frame: { sourceId: "w1", contentId: "Y" },
    },
    {
      startUtc: t("2025-06-10T13:00:30.000Z"),
      endUtc: t("2025-06-10T13:00:50.000Z"),
      frame: { sourceId: "w1", contentId: "X" },
    },
    {
      startUtc: t("2025-06-10T13:00:50.000Z"),
      endUtc: t("2025-06-10T13:01:00.000Z"),
      frame: { sourceId: "w1", contentId: "Y" },
    },
  ]);
  assert.deepEqual(resolve(dupConfig, "g", t("2025-06-10T13:00:19.999Z")), {
    sourceId: "w1",
    contentId: "X",
  });
  assert.deepEqual(resolve(dupConfig, "g", t("2025-06-10T13:00:20.000Z")), {
    sourceId: "w1",
    contentId: "Y",
  });
});

test("rotation: equal priority windows tie-break on smallest id", () => {
  const config: Config = {
    playlists: [
      {
        id: "p1",
        group: "g",
        slides: [{ contentId: "A", durationSec: 30 }],
      },
      {
        id: "p2",
        group: "g",
        slides: [{ contentId: "B", durationSec: 30 }],
      },
    ],
    windows: [
      {
        id: "wB",
        group: "g",
        priority: 2,
        playlistId: "p2",
        startLocal: "09:00",
        endLocal: "10:00",
      },
      {
        id: "wA",
        group: "g",
        priority: 2,
        playlistId: "p1",
        startLocal: "09:00",
        endLocal: "10:00",
      },
    ],
    alerts: [],
  };
  assert.deepEqual(resolve(config, "g", t("2025-06-10T13:30:00.000Z")), {
    sourceId: "wA",
    contentId: "A",
  });
});

test("rotation: idle group and idle intervals", () => {
  assert.equal(resolve(dupConfig, "g", t("2025-06-10T12:59:59.999Z")), null);
  assert.equal(resolve(dupConfig, "nobody", t("2025-06-10T13:00:10.000Z")), null);
  const segs = timeline(
    dupConfig,
    "nobody",
    t("2025-06-10T13:00:00.000Z"),
    t("2025-06-10T14:00:00.000Z")
  );
  assert.deepEqual(segs, [
    {
      startUtc: t("2025-06-10T13:00:00.000Z"),
      endUtc: t("2025-06-10T14:00:00.000Z"),
      frame: null,
    },
  ]);
});

test("rotation: resolve agrees with every timeline segment", () => {
  const from = t("2025-06-10T12:00:00.000Z");
  const to = t("2025-06-10T18:00:00.000Z");
  const segs = timeline(dupConfig, "g", from, to);
  // Gapless, non-overlapping, covering exactly [from, to).
  assert.equal(segs[0].startUtc, from);
  assert.equal(segs[segs.length - 1].endUtc, to);
  for (let i = 1; i < segs.length; i++) {
    assert.equal(segs[i].startUtc, segs[i - 1].endUtc);
  }
  for (const seg of segs) {
    assert.deepEqual(resolve(dupConfig, "g", seg.startUtc), seg.frame);
    assert.deepEqual(resolve(dupConfig, "g", seg.endUtc - 1), seg.frame);
  }
});

test("rotation: pure functions are deterministic across calls", () => {
  const at = t("2025-06-10T13:00:07.500Z");
  assert.deepEqual(resolve(dupConfig, "g", at), resolve(dupConfig, "g", at));
  assert.deepEqual(
    timeline(dupConfig, "g", t("2025-06-10T13:00:00.000Z"), t("2025-06-10T13:00:30.000Z")),
    timeline(dupConfig, "g", t("2025-06-10T13:00:00.000Z"), t("2025-06-10T13:00:30.000Z"))
  );
});
