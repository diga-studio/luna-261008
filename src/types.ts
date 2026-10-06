/** 输入快照中的一条车辆类别（如 "sedan" | "SUV" | "truck"，任意字符串均可）。 */
export type VehicleCategory = string;

export interface BranchInput {
  id: string;
  lat: number;
  lon: number;
  vehicles: readonly VehicleCategory[];
  priceCents: number;
}

export interface InstitutionInput {
  id: string;
  branches: readonly BranchInput[];
}

export interface ZipCenter {
  lat: number;
  lon: number;
}

export type ZipCenters = Readonly<Record<string, ZipCenter>>;

export interface SearchQuery {
  zip: string;
  radiusM: number;
  k: number;
  vehicle?: VehicleCategory;
  priceMin?: number;
  priceMax?: number;
}

export interface SearchHit {
  institutionId: string;
  branchId: string;
  distanceM: number;
}

export interface SearchResult {
  results: SearchHit[];
  examined: number;
}
