export interface TimeRange {
  start: number;
  end: number;
}

export interface InstructorConfig {
  id: string;
  availability: TimeRange[];
}

export interface VenueConfig {
  id: string;
  capacity: number;
}

export interface ResourceConfig {
  instructors: InstructorConfig[];
  venues: VenueConfig[];
}

export interface Session {
  id: string;
  start: number;
  end: number;
  instructorId: string;
  venueId: string;
  traineeIds: string[];
}

export type BatchChange =
  | { type: "add"; session: Session }
  | { type: "replace"; session: Session }
  | { type: "remove"; id: string };

export type ResourceType = "instructor" | "venue" | "trainee";

export interface OverbookedConflict {
  kind: "overbooked";
  resourceType: ResourceType;
  resourceId: string;
  start: number;
  end: number;
  load: number;
  capacity: number;
  sessionIds: string[];
}

export interface UnavailableConflict {
  kind: "unavailable";
  resourceType: "instructor";
  resourceId: string;
  start: number;
  end: number;
  sessionIds: string[];
}

export type Conflict = OverbookedConflict | UnavailableConflict;
