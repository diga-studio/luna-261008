import { haversineMiles } from './geo.js';
import { compositeScore, countCommonSorted, round6 } from './scoring.js';
import type {
  CandidateMatch,
  JobMatch,
  LoadInput,
} from './types.js';

/** Conservative miles-per-degree factors (slightly small => slightly larger boxes). */
const MILES_PER_DEG_LAT = 69.0;
/** Grid cell size in degrees (~34.5 miles of latitude). */
const CELL_DEG = 0.5;
const MAX_COMMUTE_MILES = 50;
/** Number of longitude cells around the globe; cells wrap at the antimeridian. */
const LON_CELL_COUNT = Math.round(360 / CELL_DEG);

function popcount14(mask: number): number {
  let count = 0;
  let bits = mask;
  while (bits !== 0) {
    bits &= bits - 1;
    count++;
  }
  return count;
}

function slotMask(slots: number[]): number {
  let mask = 0;
  for (const slot of slots) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 13) {
      throw new Error(`Invalid slot ${slot}; expected an integer in 0..13`);
    }
    mask |= 1 << slot;
  }
  return mask;
}

interface Side {
  /** External ASCII ids, indexed by internal row. */
  ids: string[];
  /** Row by external id. */
  rowById: Map<string, number>;
  lat: Float64Array;
  lon: Float64Array;
  /** Sorted skill ids per row. */
  skills: number[][];
  /** Required/available slot bitmask per row (14 bits). */
  slotBits: Int32Array;
  /** Slot count per row. */
  slotCount: Int32Array;
  /** Grid cell -> rows in that cell. */
  grid: Map<number, number[]>;
}

function wrapLonCell(lonCell: number): number {
  return ((lonCell % LON_CELL_COUNT) + LON_CELL_COUNT) % LON_CELL_COUNT;
}

function cellKey(lat: number, lon: number): number {
  const latCell = Math.floor((lat + 90) / CELL_DEG);
  const lonCell = wrapLonCell(Math.floor((lon + 180) / CELL_DEG));
  return latCell * LON_CELL_COUNT + lonCell;
}

/**
 * Offline bidirectional matcher. Load one immutable dataset, then run
 * exact top-N queries in both directions with identical scoring.
 */
export class TalentBridge {
  private jobs: Side | null = null;
  private candidates: Side | null = null;
  private candidateRadius: Float64Array = new Float64Array(0);

  load(input: LoadInput): void {
    const skillId = new Map<string, number>();
    const internSkills = (labels: string[]): number[] => {
      const ids = labels.map((label) => {
        let id = skillId.get(label);
        if (id === undefined) {
          id = skillId.size;
          skillId.set(label, id);
        }
        return id;
      });
      ids.sort((x, y) => x - y);
      return ids;
    };

    const zipLat = new Map<string, number>();
    const zipLon = new Map<string, number>();
    for (const [zip, coord] of Object.entries(input.zipCodes)) {
      zipLat.set(zip, coord.lat);
      zipLon.set(zip, coord.lon);
    }

    const buildSide = (
      entries: { id: string; zip: string; skills: string[]; slots: number[] }[],
      kind: string,
    ): Side => {
      const n = entries.length;
      const side: Side = {
        ids: new Array<string>(n),
        rowById: new Map<string, number>(),
        lat: new Float64Array(n),
        lon: new Float64Array(n),
        skills: new Array<number[]>(n),
        slotBits: new Int32Array(n),
        slotCount: new Int32Array(n),
        grid: new Map<number, number[]>(),
      };
      for (let i = 0; i < n; i++) {
        const e = entries[i];
        if (side.rowById.has(e.id)) {
          throw new Error(`Duplicate ${kind} id: ${e.id}`);
        }
        const lat = zipLat.get(e.zip);
        const lon = zipLon.get(e.zip);
        if (lat === undefined || lon === undefined) {
          throw new Error(`Unknown zip code "${e.zip}" on ${kind} ${e.id}`);
        }
        side.ids[i] = e.id;
        side.rowById.set(e.id, i);
        side.lat[i] = lat;
        side.lon[i] = lon;
        side.skills[i] = internSkills(e.skills);
        const mask = slotMask(e.slots);
        side.slotBits[i] = mask;
        side.slotCount[i] = popcount14(mask);
        const key = cellKey(lat, lon);
        const bucket = side.grid.get(key);
        if (bucket === undefined) {
          side.grid.set(key, [i]);
        } else {
          bucket.push(i);
        }
      }
      return side;
    };

    this.jobs = buildSide(input.jobs, 'job');
    this.candidates = buildSide(input.candidates, 'candidate');
    this.candidateRadius = new Float64Array(input.candidates.length);
    for (let i = 0; i < input.candidates.length; i++) {
      const r = input.candidates[i].maxCommuteMiles;
      if (!(r >= 5 && r <= 50) || r % 5 !== 0) {
        throw new Error(
          `Invalid maxCommuteMiles ${r} on candidate ${input.candidates[i].id}; expected 5..50 in steps of 5`,
        );
      }
      this.candidateRadius[i] = r;
    }
  }

  recommendJobs(candidateId: string, limit = 25): JobMatch[] {
    const jobs = this.jobs;
    const candidates = this.candidates;
    if (jobs === null || candidates === null) {
      throw new Error('TalentBridge.load() must be called before querying');
    }
    const row = candidates.rowById.get(candidateId);
    if (row === undefined) {
      throw new Error(`Unknown candidate id: ${candidateId}`);
    }
    const radius = this.candidateRadius[row];
    const lat = candidates.lat[row];
    const lon = candidates.lon[row];
    const candSkills = candidates.skills[row];
    const candBits = candidates.slotBits[row];

    const matches: { id: string; score: number }[] = [];
    this.forEachRowNear(jobs, lat, lon, radius, (jobRow) => {
      const distance = haversineMiles(lat, lon, jobs.lat[jobRow], jobs.lon[jobRow]);
      if (distance > radius) return;
      const jobSkills = jobs.skills[jobRow];
      const skillRatio =
        jobSkills.length === 0
          ? 1
          : countCommonSorted(jobSkills, candSkills) / jobSkills.length;
      const commuteRatio = 1 - distance / radius;
      const timeRatio =
        popcount14(jobs.slotBits[jobRow] & candBits) / jobs.slotCount[jobRow];
      matches.push({
        id: jobs.ids[jobRow],
        score: round6(compositeScore(skillRatio, commuteRatio, timeRatio)),
      });
    });

    matches.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const top = matches.slice(0, limit);
    return top.map((m) => ({ jobId: m.id, score: m.score }));
  }

  recommendCandidates(jobId: string, limit = 25): CandidateMatch[] {
    const jobs = this.jobs;
    const candidates = this.candidates;
    if (jobs === null || candidates === null) {
      throw new Error('TalentBridge.load() must be called before querying');
    }
    const row = jobs.rowById.get(jobId);
    if (row === undefined) {
      throw new Error(`Unknown job id: ${jobId}`);
    }
    const lat = jobs.lat[row];
    const lon = jobs.lon[row];
    const jobSkills = jobs.skills[row];
    const jobBits = jobs.slotBits[row];
    const jobSlotCount = jobs.slotCount[row];

    const matches: { id: string; score: number }[] = [];
    // Candidates carry individual radii up to 50 miles; scan the widest box
    // and filter per candidate.
    this.forEachRowNear(candidates, lat, lon, MAX_COMMUTE_MILES, (candRow) => {
      const radius = this.candidateRadius[candRow];
      const distance = haversineMiles(
        lat,
        lon,
        candidates.lat[candRow],
        candidates.lon[candRow],
      );
      if (distance > radius) return;
      const candSkills = candidates.skills[candRow];
      const skillRatio =
        jobSkills.length === 0
          ? 1
          : countCommonSorted(jobSkills, candSkills) / jobSkills.length;
      const commuteRatio = 1 - distance / radius;
      const timeRatio =
        popcount14(jobBits & candidates.slotBits[candRow]) / jobSlotCount;
      matches.push({
        id: candidates.ids[candRow],
        score: round6(compositeScore(skillRatio, commuteRatio, timeRatio)),
      });
    });

    matches.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const top = matches.slice(0, limit);
    return top.map((m) => ({ candidateId: m.id, score: m.score }));
  }

  /**
   * Invoke `visit` for every row of `side` whose grid cell intersects the
   * bounding box of `radiusMiles` around (lat, lon). The box is conservative
   * (never too small); callers must still apply the exact distance test.
   */
  private forEachRowNear(
    side: Side,
    lat: number,
    lon: number,
    radiusMiles: number,
    visit: (row: number) => void,
  ): void {
    const latDelta = radiusMiles / MILES_PER_DEG_LAT;
    const cosLat = Math.max(Math.abs(Math.cos((lat * Math.PI) / 180)), 0.01);
    const lonDelta = radiusMiles / (MILES_PER_DEG_LAT * cosLat);
    const latCellMin = Math.floor((lat - latDelta + 90) / CELL_DEG);
    const latCellMax = Math.floor((lat + latDelta + 90) / CELL_DEG);
    const lonCellMin = Math.floor((lon - lonDelta + 180) / CELL_DEG);
    // Clamp the span so a huge box visits each wrapped cell at most once.
    const lonCellMax = Math.min(
      Math.floor((lon + lonDelta + 180) / CELL_DEG),
      lonCellMin + LON_CELL_COUNT - 1,
    );
    for (let la = latCellMin; la <= latCellMax; la++) {
      for (let lo = lonCellMin; lo <= lonCellMax; lo++) {
        const bucket = side.grid.get(la * LON_CELL_COUNT + wrapLonCell(lo));
        if (bucket === undefined) continue;
        for (let k = 0; k < bucket.length; k++) {
          visit(bucket[k]);
        }
      }
    }
  }
}
