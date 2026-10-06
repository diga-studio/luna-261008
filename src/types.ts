export interface Branch {
  id: string;
  lat: number;
  lon: number;
  vehicles: ReadonlySet<string>;
  priceCents: number;
}

export interface Institution {
  id: string;
  branches: Branch[];
}

export interface CatalogData {
  institutions: Institution[];
}

export interface ZipCenter {
  lat: number;
  lon: number;
}

export type ZipCenters = Record<string, ZipCenter>;

export interface Query {
  zip: string;
  radiusM: number;
  k: number;
  vehicle?: string;
  priceMin?: number;
  priceMax?: number;
}

export interface SearchHit {
  institutionId: string;
  branchId: string;
  distanceM: number;
}

export interface SearchResult {
  hits: SearchHit[];
  examined: number;
}

export interface Catalog {
  search(query: Query): SearchResult;
}
