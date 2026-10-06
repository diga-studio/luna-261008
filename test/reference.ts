import type { ProfileRecord, Rule } from "../src/types.js";

export interface RefProfile {
  engagementScore: number | null;
  region: string | null;
  tags: ReadonlySet<string>;
}

export function evalRule(rule: Rule, profile: RefProfile): boolean {
  switch (rule.type) {
    case "AND":
      return rule.children.every((child) => evalRule(child, profile));
    case "OR":
      return rule.children.some((child) => evalRule(child, profile));
    case "SCORE":
      return (
        profile.engagementScore !== null &&
        profile.engagementScore >= rule.min &&
        profile.engagementScore <= rule.max
      );
    case "REGION":
      return profile.region === rule.region;
    case "TAG":
      return profile.tags.has(rule.tag);
  }
}

export class ReferenceNexus {
  private readonly profiles = new Map<string, RefProfile>();
  private readonly rules = new Map<string, Rule>();

  upsertBatch(records: ReadonlyArray<ProfileRecord>): void {
    for (const record of records) {
      this.profiles.set(record.userId, {
        engagementScore: record.engagementScore,
        region: record.region,
        tags: new Set(record.purchaseTags),
      });
    }
  }

  saveSegment(segmentId: string, rule: Rule): void {
    this.rules.set(segmentId, rule);
  }

  count(segmentId: string): number {
    const rule = this.mustRule(segmentId);
    let total = 0;
    for (const profile of this.profiles.values()) {
      if (evalRule(rule, profile)) total++;
    }
    return total;
  }

  intersection(segmentId: string, otherSegmentId: string): number {
    const a = this.mustRule(segmentId);
    const b = this.mustRule(otherSegmentId);
    let total = 0;
    for (const profile of this.profiles.values()) {
      if (evalRule(a, profile) && evalRule(b, profile)) total++;
    }
    return total;
  }

  private mustRule(segmentId: string): Rule {
    const rule = this.rules.get(segmentId);
    if (rule === undefined) throw new Error(`unknown segment: ${segmentId}`);
    return rule;
  }
}
