import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SkillPulseScheduler } from "../src/scheduler.ts";
import type { BatchChange, ResourceConfig, Session } from "../src/types.ts";

const baseConfig: ResourceConfig = {
  instructors: [
    { id: "I1", availability: [{ start: 0, end: 10000 }] },
    { id: "I2", availability: [{ start: 0, end: 10000 }] },
  ],
  venues: [{ id: "V1", capacity: 10 }],
};

function makeScheduler(initial: Session[]): SkillPulseScheduler {
  return new SkillPulseScheduler(baseConfig, initial);
}

describe("batch swap", () => {
  const s1: Session = {
    id: "S1",
    start: 1000,
    end: 2000,
    instructorId: "I1",
    venueId: "V1",
    traineeIds: ["T1"],
  };
  const s2: Session = {
    id: "S2",
    start: 3000,
    end: 4000,
    instructorId: "I2",
    venueId: "V1",
    traineeIds: ["T2"],
  };
  const swapped1: Session = { ...s1, start: 3000, end: 4000, instructorId: "I2" };
  const swapped2: Session = { ...s2, start: 1000, end: 2000, instructorId: "I1" };

  it("single replace conflicts, whole batch succeeds", () => {
    const scheduler = makeScheduler([s1, s2]);

    const single = scheduler.checkBatch([
      { type: "replace", session: swapped1 },
    ]);
    assert.ok(single.length > 0, "single replace should conflict");
    assert.ok(
      single.some(
        (c) =>
          c.kind === "overbooked" &&
          c.resourceType === "instructor" &&
          c.resourceId === "I2",
      ),
    );
    assert.equal(scheduler.getSession("S1")?.instructorId, "I1");

    const result = scheduler.applyBatch([
      { type: "replace", session: swapped1 },
      { type: "replace", session: swapped2 },
    ]);
    assert.deepEqual(result, []);
    assert.deepEqual(scheduler.getSession("S1"), swapped1);
    assert.deepEqual(scheduler.getSession("S2"), swapped2);
  });

  it("result does not depend on batch input order", () => {
    const scheduler = makeScheduler([s1, s2]);
    const forward: BatchChange[] = [
      { type: "replace", session: swapped1 },
      { type: "replace", session: swapped2 },
    ];
    const backward: BatchChange[] = [...forward].reverse();
    assert.deepEqual(scheduler.checkBatch(forward), scheduler.checkBatch(backward));

    const bad: BatchChange[] = [
      { type: "replace", session: swapped1 },
      { type: "replace", session: { ...s2, start: 3000, end: 5000 } },
    ];
    assert.deepEqual(
      scheduler.checkBatch(bad),
      scheduler.checkBatch([...bad].reverse()),
    );
  });
});

describe("atomicity", () => {
  it("conflicting last change rolls back the whole batch; checkBatch is pure", () => {
    const s1: Session = {
      id: "S1",
      start: 1000,
      end: 2000,
      instructorId: "I1",
      venueId: "V1",
      traineeIds: ["T1"],
    };
    const scheduler = makeScheduler([s1]);
    const moved1: Session = { ...s1, start: 5000, end: 6000 };
    const added: Session = {
      id: "S3",
      start: 7000,
      end: 8000,
      instructorId: "I2",
      venueId: "V1",
      traineeIds: ["T3"],
    };
    const conflicting: Session = {
      id: "S4",
      start: 7500,
      end: 8500,
      instructorId: "I2",
      venueId: "V1",
      traineeIds: ["T4"],
    };
    const batch: BatchChange[] = [
      { type: "replace", session: moved1 },
      { type: "add", session: added },
      { type: "add", session: conflicting },
    ];

    const checked = scheduler.checkBatch(batch);
    assert.ok(checked.length > 0);
    assert.equal(scheduler.getSession("S1")?.start, 1000);
    assert.equal(scheduler.getSession("S3"), undefined);
    assert.equal(scheduler.getSession("S4"), undefined);

    const applied = scheduler.applyBatch(batch);
    assert.deepEqual(applied, checked);
    assert.deepEqual(scheduler.getSession("S1"), s1);
    assert.equal(scheduler.getSession("S3"), undefined);
    assert.equal(scheduler.getSession("S4"), undefined);
  });

  it("remove frees all occupancy within the same batch", () => {
    const s1: Session = {
      id: "S1",
      start: 1000,
      end: 2000,
      instructorId: "I1",
      venueId: "V1",
      traineeIds: ["T1"],
    };
    const scheduler = makeScheduler([s1]);
    const replacement: Session = { ...s1, id: "S9" };
    const result = scheduler.applyBatch([
      { type: "add", session: replacement },
      { type: "remove", id: "S1" },
    ]);
    assert.deepEqual(result, []);
    assert.equal(scheduler.getSession("S1"), undefined);
    assert.deepEqual(scheduler.getSession("S9"), replacement);
  });
});

describe("venue capacity stacking", () => {
  const config: ResourceConfig = {
    instructors: [
      { id: "IA", availability: [{ start: 0, end: 1000 }] },
      { id: "IB", availability: [{ start: 0, end: 1000 }] },
      {
        id: "IC",
        availability: [
          { start: 0, end: 120 },
          { start: 120, end: 300 },
        ],
      },
      { id: "ID", availability: [{ start: 0, end: 1000 }] },
      { id: "IE", availability: [{ start: 0, end: 1000 }] },
    ],
    venues: [{ id: "V", capacity: 10 }],
  };
  const session = (
    id: string,
    start: number,
    end: number,
    instructorId: string,
    traineeIds: string[],
  ): Session => ({ id, start, end, instructorId, venueId: "V", traineeIds });

  it("any two fit, three together exceed capacity", () => {
    const a = session("A", 0, 150, "IA", ["t1", "t2", "t3", "t4"]);
    const b = session("B", 60, 180, "IB", ["t5", "t6", "t7", "t8"]);
    const c = session("C", 120, 240, "IC", ["t9", "t10", "t11", "t12"]);

    for (const pair of [[a, b], [a, c], [b, c]]) {
      const s = new SkillPulseScheduler(config, pair);
      assert.deepEqual(s.checkBatch([]), []);
    }

    const scheduler = new SkillPulseScheduler(config, [a, b, c]);
    const conflicts = scheduler.checkBatch([]);
    assert.deepEqual(conflicts, [
      {
        kind: "overbooked",
        resourceType: "venue",
        resourceId: "V",
        start: 120,
        end: 150,
        load: 12,
        capacity: 10,
        sessionIds: ["A", "B", "C"],
      },
    ]);
  });

  it("touching endpoints and 1ms gaps do not overlap", () => {
    const c = session("C", 120, 240, "IC", ["t9", "t10", "t11", "t12"]);
    const d = session("D", 241, 300, "ID", ["t13"]);
    const e = session("E", 300, 360, "IE", ["t14"]);
    const scheduler = new SkillPulseScheduler(config, [c, d, e]);
    assert.deepEqual(scheduler.checkBatch([]), []);
  });
});

describe("instructor availability", () => {
  it("reports overbooked and unavailable together for one instructor", () => {
    const config: ResourceConfig = {
      instructors: [{ id: "IX", availability: [{ start: 0, end: 50 }] }],
      venues: [{ id: "V", capacity: 100 }],
    };
    const x1: Session = {
      id: "X1",
      start: 100,
      end: 200,
      instructorId: "IX",
      venueId: "V",
      traineeIds: ["ta"],
    };
    const x2: Session = {
      id: "X2",
      start: 150,
      end: 250,
      instructorId: "IX",
      venueId: "V",
      traineeIds: ["tb"],
    };
    const scheduler = new SkillPulseScheduler(config, []);
    const conflicts = scheduler.checkBatch([
      { type: "add", session: x1 },
      { type: "add", session: x2 },
    ]);
    assert.deepEqual(conflicts, [
      {
        kind: "unavailable",
        resourceType: "instructor",
        resourceId: "IX",
        start: 100,
        end: 200,
        sessionIds: ["X1"],
      },
      {
        kind: "overbooked",
        resourceType: "instructor",
        resourceId: "IX",
        start: 150,
        end: 200,
        load: 2,
        capacity: 1,
        sessionIds: ["X1", "X2"],
      },
      {
        kind: "unavailable",
        resourceType: "instructor",
        resourceId: "IX",
        start: 150,
        end: 250,
        sessionIds: ["X2"],
      },
    ]);
  });

  it("trainee double booking is reported per trainee", () => {
    const scheduler = makeScheduler([]);
    const mk = (id: string, start: number, end: number): Session => ({
      id,
      start,
      end,
      instructorId: "I1",
      venueId: "V1",
      traineeIds: ["T-shared"],
    });
    const conflicts = scheduler.checkBatch([
      { type: "add", session: mk("A", 0, 100) },
      { type: "add", session: mk("B", 50, 150) },
    ]);
    assert.ok(
      conflicts.some(
        (c) =>
          c.kind === "overbooked" &&
          c.resourceType === "trainee" &&
          c.resourceId === "T-shared" &&
          c.start === 50 &&
          c.end === 100,
      ),
    );
  });
});
