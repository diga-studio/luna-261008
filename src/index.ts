import { readFileSync } from "node:fs";
import { distanceMiles } from "./geo.js";
import { compositeScore, roundScore } from "./scoring.js";
import type { Candidate, Job, MatchResult, TalentBridgeData, ZipCoordinate } from "./types.js";

export type { Candidate, Job, MatchResult, TalentBridgeData, ZipCoordinate } from "./types.js";

const TOP_K = 25;
const MAX_RADIUS_MILES = 50;
/** Conservative miles-per-degree latitude (true value ~69.09); used only for bounding boxes. */
const MILES_PER_DEG = 69.0;
const CELL_DEG = 0.5;
const LON_CELLS = Math.ceil(360 / CELL_DEG);

interface JobEntry {
  id: string;
  skills: string[];
  slotMask: number;
}

interface JobZipGroup {
  lat: number;
  lon: number;
  jobs: JobEntry[];
}

interface CandEntry {
  id: string;
  skillSet: Set<string>;
  slotMask: number;
  radius: number;
}

interface CandZipGroup {
  lat: number;
  lon: number;
  cands: CandEntry[];
}

function slotMaskOf(slots: number[]): number {
  let mask = 0;
  for (const s of slots) {
    if (!Number.isInteger(s) || s < 0 || s > 13) {
      throw new Error(`invalid time slot: ${s}`);
    }
    mask |= 1 << s;
  }
  return mask;
}

function popcount(x: number): number {
  let c = 0;
  while (x !== 0) {
    x &= x - 1;
    c++;
  }
  return c;
}

function cellKey(lat: number, lon: number): number {
  const cx = Math.floor(lon / CELL_DEG) + LON_CELLS / 2;
  const cz = Math.floor(lat / CELL_DEG) + 90 / CELL_DEG;
  return cx * 1000 + cz;
}

/** Orders results: rounded score descending, then recommended-object ID ascending (ASCII). */
function compareResults(a: MatchResult, b: MatchResult): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Keeps the best TOP_K results according to compareResults. */
class TopK {
  private items: MatchResult[] = [];

  add(item: MatchResult): void {
    const items = this.items;
    if (items.length === TOP_K && compareResults(item, items[TOP_K - 1]) >= 0) return;
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareResults(item, items[mid]) < 0) hi = mid;
      else lo = mid + 1;
    }
    items.splice(lo, 0, item);
    if (items.length > TOP_K) items.length = TOP_K;
  }

  results(): MatchResult[] {
    return this.items;
  }
}

function parseJsonFile(path: string): unknown {
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("[")) return JSON.parse(text);
  // NDJSON fallback: one JSON object per line.
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export class TalentBridge {
  private jobGroups: JobZipGroup[] = [];
  private candGroups: CandZipGroup[] = [];
  private jobGrid = new Map<number, number[]>();
  private candGrid = new Map<number, number[]>();
  private jobsById = new Map<string, { job: Job; lat: number; lon: number; slotMask: number }>();
  private candsById = new Map<string, { cand: Candidate; lat: number; lon: number; slotMask: number }>();
  private loaded = false;

  /** Replaces all data. After loading, the dataset is immutable. */
  loadData(data: TalentBridgeData): void {
    const zipCoords = new Map<string, ZipCoordinate>();
    for (const z of data.zips) zipCoords.set(z.zip, z);

    const coordsOf = (zip: string): ZipCoordinate => {
      const c = zipCoords.get(zip);
      if (!c) throw new Error(`unknown zip code: ${zip}`);
      return c;
    };

    const jobGroupsByZip = new Map<string, JobZipGroup>();
    this.jobsById = new Map();
    for (const job of data.jobs) {
      const coords = coordsOf(job.zip);
      const mask = slotMaskOf(job.timeSlots);
      if (mask === 0) throw new Error(`job ${job.id} has no time slots`);
      let group = jobGroupsByZip.get(job.zip);
      if (!group) {
        group = { lat: coords.lat, lon: coords.lon, jobs: [] };
        jobGroupsByZip.set(job.zip, group);
      }
      group.jobs.push({ id: job.id, skills: job.skills, slotMask: mask });
      this.jobsById.set(job.id, { job, lat: coords.lat, lon: coords.lon, slotMask: mask });
    }

    const candGroupsByZip = new Map<string, CandZipGroup>();
    this.candsById = new Map();
    for (const cand of data.candidates) {
      const coords = coordsOf(cand.zip);
      const mask = slotMaskOf(cand.timeSlots);
      let group = candGroupsByZip.get(cand.zip);
      if (!group) {
        group = { lat: coords.lat, lon: coords.lon, cands: [] };
        candGroupsByZip.set(cand.zip, group);
      }
      group.cands.push({
        id: cand.id,
        skillSet: new Set(cand.skills),
        slotMask: mask,
        radius: cand.maxCommuteMiles,
      });
      this.candsById.set(cand.id, { cand, lat: coords.lat, lon: coords.lon, slotMask: mask });
    }

    this.jobGroups = [...jobGroupsByZip.values()];
    this.candGroups = [...candGroupsByZip.values()];
    this.jobGrid = buildGrid(this.jobGroups);
    this.candGrid = buildGrid(this.candGroups);
    this.loaded = true;
  }

  /** Loads datasets from local files (JSON arrays or NDJSON). */
  loadFromFiles(paths: { jobs: string; candidates: string; zips: string }): void {
    this.loadData({
      jobs: parseJsonFile(paths.jobs) as Job[],
      candidates: parseJsonFile(paths.candidates) as Candidate[],
      zips: parseJsonFile(paths.zips) as ZipCoordinate[],
    });
  }

  /** Top-25 jobs for a candidate, exact ranking. */
  recommendJobsForCandidate(candidateId: string): MatchResult[] {
    const entry = this.candsById.get(candidateId);
    if (!entry) throw new Error(`unknown candidate id: ${candidateId}`);
    const { cand, lat, lon, slotMask } = entry;
    const radius = cand.maxCommuteMiles;
    const candSkills = new Set(cand.skills);
    const top = new TopK();
    forEachGroupWithin(this.jobGrid, this.jobGroups, lat, lon, radius, (group, dist) => {
      const commuteRatio = 1 - dist / radius;
      for (const job of group.jobs) {
        let common = 0;
        for (const s of job.skills) if (candSkills.has(s)) common++;
        const skillRatio = job.skills.length === 0 ? 1 : common / job.skills.length;
        const timeRatio = popcount(slotMask & job.slotMask) / popcount(job.slotMask);
        top.add({
          id: job.id,
          score: roundScore(compositeScore(skillRatio, commuteRatio, timeRatio)),
        });
      }
    });
    return top.results();
  }

  /** Top-25 candidates for a job, exact ranking, using each candidate's own radius. */
  recommendCandidatesForJob(jobId: string): MatchResult[] {
    const entry = this.jobsById.get(jobId);
    if (!entry) throw new Error(`unknown job id: ${jobId}`);
    const { job, lat, lon, slotMask } = entry;
    const jobSlotCount = popcount(slotMask);
    const top = new TopK();
    forEachGroupWithin(this.candGrid, this.candGroups, lat, lon, MAX_RADIUS_MILES, (group, dist) => {
      for (const cand of group.cands) {
        if (dist > cand.radius) continue;
        let common = 0;
        for (const s of job.skills) if (cand.skillSet.has(s)) common++;
        const skillRatio = job.skills.length === 0 ? 1 : common / job.skills.length;
        const commuteRatio = 1 - dist / cand.radius;
        const timeRatio = popcount(slotMask & cand.slotMask) / jobSlotCount;
        top.add({
          id: cand.id,
          score: roundScore(compositeScore(skillRatio, commuteRatio, timeRatio)),
        });
      }
    });
    return top.results();
  }
}

function buildGrid(groups: { lat: number; lon: number }[]): Map<number, number[]> {
  const grid = new Map<number, number[]>();
  groups.forEach((g, i) => {
    const key = cellKey(g.lat, g.lon);
    let list = grid.get(key);
    if (!list) {
      list = [];
      grid.set(key, list);
    }
    list.push(i);
  });
  return grid;
}

/**
 * Invokes fn(group, exactDistanceMiles) for every group whose zip center is
 * within radiusMiles of (lat, lon). Distance is the exact haversine value;
 * the grid is used only to skip cells that cannot contain a match.
 */
function forEachGroupWithin<G extends { lat: number; lon: number }>(
  grid: Map<number, number[]>,
  groups: G[],
  lat: number,
  lon: number,
  radiusMiles: number,
  fn: (group: G, dist: number) => void,
): void {
  const dLat = radiusMiles / MILES_PER_DEG;
  const cosLat = Math.max(Math.cos(lat * (Math.PI / 180)), 0.01);
  const dLon = Math.min(180, radiusMiles / (MILES_PER_DEG * cosLat));
  const cxMin = Math.floor((lon - dLon) / CELL_DEG);
  const cxMax = Math.floor((lon + dLon) / CELL_DEG);
  const czMin = Math.floor((lat - dLat) / CELL_DEG);
  const czMax = Math.floor((lat + dLat) / CELL_DEG);
  for (let cx = cxMin; cx <= cxMax; cx++) {
    // Wrap around the antimeridian.
    let wx = cx + LON_CELLS / 2;
    wx = ((wx % LON_CELLS) + LON_CELLS) % LON_CELLS;
    for (let cz = czMin; cz <= czMax; cz++) {
      const list = grid.get(wx * 1000 + (cz + 90 / CELL_DEG));
      if (!list) continue;
      for (const i of list) {
        const g = groups[i];
        const dist = distanceMiles(lat, lon, g.lat, g.lon);
        if (dist <= radiusMiles) fn(g, dist);
      }
    }
  }
}
