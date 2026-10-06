import { decide, effectiveDecision, sortRules, windowContains } from './decide';
import type {
  Connection,
  Decision,
  Device,
  PolicyConfig,
  RuleAudit,
  Segment,
} from './types';

interface Triple {
  role: string;
  method: string;
  trust: string;
}

function decisionsEqual(a: Decision, b: Decision): boolean {
  if (a.vlan !== b.vlan || a.bandwidth !== b.bandwidth) return false;
  if (a.allowedCIDRs.length !== b.allowedCIDRs.length) return false;
  for (let i = 0; i < a.allowedCIDRs.length; i++) {
    if (a.allowedCIDRs[i] !== b.allowedCIDRs[i]) return false;
  }
  return true;
}

export function audit(config: PolicyConfig): RuleAudit[] {
  const rules = sortRules(config.rules);
  const R = rules.length;
  if (R === 0) return [];
  const segmentsById = new Map(config.segments.map((s) => [s.id, s]));
  const segOfRule: Segment[] = rules.map((r) => {
    const s = segmentsById.get(r.segmentId);
    if (!s) throw new Error(`unknown segment: ${r.segmentId}`);
    return s;
  });

  // ---- Distinct (role, method, trust) triples; profiles with the same triple
  // ---- are indistinguishable to every rule, so one representative suffices.
  const tripleIndex = new Map<string, number>();
  const triples: Triple[] = [];
  const tripleProfile: string[] = [];
  for (const p of config.profiles) {
    const key = p.role + '\u0001' + p.method + '\u0001' + p.trust;
    if (!tripleIndex.has(key)) {
      tripleIndex.set(key, triples.length);
      triples.push({ role: p.role, method: p.method, trust: p.trust });
      tripleProfile.push(p.id);
    }
  }
  const T = triples.length;
  const U = T * 2; // context bits: (triple, connection)
  const W = (U + 31) >>> 5;

  // ---- Per-rule bitset of contexts matching its role/method/trust/connection.
  const matchBits: Uint32Array[] = rules.map(() => new Uint32Array(W));
  for (let t = 0; t < T; t++) {
    const tr = triples[t]!;
    for (let i = 0; i < R; i++) {
      const r = rules[i]!;
      if (
        (r.role === '*' || r.role === tr.role) &&
        (r.method === '*' || r.method === tr.method) &&
        (r.trust === '*' || r.trust === tr.trust)
      ) {
        const base = t * 2;
        const word = base >>> 5;
        if (r.connection === '*') {
          matchBits[i]![word]! |= 3 << (base & 31);
          // the two bits may straddle a word boundary
          if ((base & 31) === 31) matchBits[i]![word + 1]! |= 1;
        } else {
          const bit = base + (r.connection === 'wireless' ? 1 : 0);
          matchBits[i]![bit >>> 5]! |= 1 << (bit & 31);
        }
      }
    }
  }

  // ---- Atomic minute intervals: rule time-activity is constant inside each.
  const boundarySet = new Set<number>();
  for (const r of rules) {
    if (r.window.start !== r.window.end) {
      boundarySet.add(r.window.start);
      boundarySet.add(r.window.end);
    }
  }
  const atoms = boundarySet.size > 0 ? [...boundarySet].sort((a, b) => a - b) : [0];

  // ---- Device analysis: for every ordered pair of rule-target VLANs, count
  // ---- devices whose support pattern makes the two outcomes differ.
  const relevantVlans = new Set<number>();
  for (const s of segOfRule) relevantVlans.add(s.vlan);
  const segByVlan = new Map<number, Segment>();
  for (const s of config.segments) segByVlan.set(s.vlan, s);
  // d1Count[v]: devices supporting v whose isolation segment != segment of v
  const d1Count = new Map<number, number>();
  // bothSup: unordered-existence of a device supporting v1 and v2
  const bothSup = new Set<number>();
  // cCount[v1*4096+v2]: devices supporting both with isolation != segment of v1
  const cCount = new Map<number, number>();
  for (const d of config.devices) {
    const iso = segmentsById.get(d.isolationSegmentId);
    if (!iso) throw new Error(`unknown isolation segment: ${d.isolationSegmentId}`);
    const sup = [...new Set(d.supportedVlans)].filter((v) => relevantVlans.has(v));
    for (const v of sup) {
      if (segByVlan.get(v) !== iso) d1Count.set(v, (d1Count.get(v) ?? 0) + 1);
    }
    for (const v1 of sup) {
      const isoDiffers = segByVlan.get(v1) !== iso;
      for (const v2 of sup) {
        if (v1 === v2) continue;
        const key = v1 * 4096 + v2;
        bothSup.add(key);
        if (isoDiffers) cCount.set(key, (cCount.get(key) ?? 0) + 1);
      }
    }
  }

  // Do segments s1 != s2 yield different effective permissions for some device?
  const differ = (s1: Segment, s2: Segment): boolean => {
    if (s1.id === s2.id) return false;
    const v1 = s1.vlan;
    const v2 = s2.vlan;
    if (bothSup.has(v1 * 4096 + v2)) return true;
    if ((d1Count.get(v1) ?? 0) > (cCount.get(v1 * 4096 + v2) ?? 0)) return true;
    if ((d1Count.get(v2) ?? 0) > (cCount.get(v2 * 4096 + v1) ?? 0)) return true;
    return false;
  };
  // Does matching a rule with segment s differ from matching nothing (isolation)?
  const differNone = (s: Segment): boolean => (d1Count.get(s.vlan) ?? 0) > 0;

  // ---- Sweep: for every atomic interval, compute for each context its first
  // ---- and second matching rule, recording every observed (first, second)
  // ---- pair together with one witness context.
  const NONE = R;
  const pairStride = R + 1;
  const pairWords = (pairStride + 31) >>> 5;
  const pairSeen: Uint32Array[] = rules.map(() => new Uint32Array(pairWords));
  const pairWitness = new Map<number, { minute: number; bit: number }>();
  const recordPair = (first: number, second: number, minute: number, bit: number): void => {
    const seen = pairSeen[first]!;
    const word = second >>> 5;
    const mask = 1 << (second & 31);
    if (seen[word]! & mask) return;
    seen[word]! |= mask;
    pairWitness.set(first * pairStride + second, { minute, bit });
  };

  const full = new Uint32Array(W);
  for (let b = 0; b < U; b++) full[b >>> 5]! |= 1 << (b & 31);
  const rem0 = new Uint32Array(W); // contexts with no first match yet
  const rem1 = new Uint32Array(W); // contexts with a first but no second yet
  const newFirst = new Uint32Array(W);
  const newSecond = new Uint32Array(W);
  const firstOf = new Int32Array(U);

  // Atoms with the same set of time-active rules behave identically; sweep
  // each distinct active set only once (witnesses keep the first atom's minute).
  const sweptSigs = new Set<string>();
  for (const minute of atoms) {
    const active: number[] = [];
    for (let i = 0; i < R; i++) {
      if (windowContains(rules[i]!.window, minute)) active.push(i);
    }
    const sig = active.join(',');
    if (sweptSigs.has(sig)) continue;
    sweptSigs.add(sig);

    rem0.set(full);
    rem1.fill(0);
    firstOf.fill(-1);
    let rem0Empty = U === 0;
    let rem1Empty = true;
    for (const i of active) {
      if (rem0Empty && rem1Empty) break;
      const m = matchBits[i]!;

      let anyFirst = false;
      for (let w = 0; w < W; w++) {
        const v = m[w]! & rem0[w]!;
        newFirst[w] = v;
        if (v !== 0) anyFirst = true;
      }
      if (anyFirst) {
        for (let w = 0; w < W; w++) {
          let v = newFirst[w]!;
          while (v !== 0) {
            const low = v & -v;
            firstOf[(w << 5) + (31 - Math.clz32(low))] = i;
            v ^= low;
          }
        }
      }

      let anyRem0 = false;
      for (let w = 0; w < W; w++) {
        const v = rem0[w]! & ~m[w]!;
        rem0[w] = v;
        if (v !== 0) anyRem0 = true;
      }
      rem0Empty = !anyRem0;

      let anySecond = false;
      for (let w = 0; w < W; w++) {
        const v = m[w]! & rem1[w]!;
        newSecond[w] = v;
        if (v !== 0) anySecond = true;
      }
      if (anySecond) {
        for (let w = 0; w < W; w++) {
          let v = newSecond[w]!;
          while (v !== 0) {
            const low = v & -v;
            const bit = (w << 5) + (31 - Math.clz32(low));
            recordPair(firstOf[bit]!, i, minute, bit);
            v ^= low;
          }
        }
      }

      let anyRem1 = false;
      for (let w = 0; w < W; w++) {
        const v = (rem1[w]! & ~m[w]!) | newFirst[w]!;
        rem1[w] = v;
        if (v !== 0) anyRem1 = true;
      }
      rem1Empty = !anyRem1;
    }
    // Contexts still in rem1 have a first match but no second match at all.
    for (let w = 0; w < W; w++) {
      let v = rem1[w]!;
      while (v !== 0) {
        const low = v & -v;
        const bit = (w << 5) + (31 - Math.clz32(low));
        recordPair(firstOf[bit]!, NONE, minute, bit);
        v ^= low;
      }
    }
  }

  // ---- Verdicts and witnesses, all against the original configuration.
  const isolationOf = (d: Device): Decision => {
    const iso = segmentsById.get(d.isolationSegmentId);
    if (!iso) throw new Error(`unknown isolation segment: ${d.isolationSegmentId}`);
    return { vlan: iso.vlan, allowedCIDRs: iso.allowedCIDRs, bandwidth: iso.bandwidth };
  };

  const results: RuleAudit[] = [];
  for (let i = 0; i < R; i++) {
    const seen = pairSeen[i]!;
    let badSecond = -1;
    for (let s = 0; s <= R; s++) {
      if ((seen[s >>> 5]! & (1 << (s & 31))) === 0) continue;
      const bad = s === NONE ? differNone(segOfRule[i]!) : differ(segOfRule[i]!, segOfRule[s]!);
      if (bad) {
        badSecond = s;
        break;
      }
    }
    if (badSecond === -1) {
      results.push({ ruleId: rules[i]!.id, safeToRemove: true });
      continue;
    }

    const wit = pairWitness.get(i * pairStride + badSecond)!;
    const profileId = tripleProfile[wit.bit >>> 1]!;
    const connection: Connection = (wit.bit & 1) === 1 ? 'wireless' : 'wired';
    const minute = wit.minute;
    const s1 = segOfRule[i]!;
    let deviceId: string | undefined;
    for (const d of config.devices) {
      const e1 = effectiveDecision(s1, d, segmentsById);
      const e2 =
        badSecond === NONE
          ? isolationOf(d)
          : effectiveDecision(segOfRule[badSecond]!, d, segmentsById);
      if (!decisionsEqual(e1, e2)) {
        deviceId = d.id;
        break;
      }
    }
    if (deviceId === undefined) throw new Error('internal: no witness device found');
    const before = decide(config, profileId, deviceId, connection, minute);
    const reduced: PolicyConfig = {
      ...config,
      rules: config.rules.filter((r) => r.id !== rules[i]!.id),
    };
    const after = decide(reduced, profileId, deviceId, connection, minute);
    results.push({
      ruleId: rules[i]!.id,
      safeToRemove: false,
      witness: { profileId, deviceId, connection, minute, before, after },
    });
  }
  return results;
}
