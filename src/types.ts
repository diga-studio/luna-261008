/** A single slide in a playlist. durationSec is in [5, 120]. */
export interface Slide {
  contentId: string;
  durationSec: number;
}

/** An ordered playlist belonging to a group. */
export interface Playlist {
  id: string;
  group: string;
  slides: Slide[];
}

/**
 * A daily shift window. startLocal/endLocal are "HH:mm" wall-clock times
 * in America/New_York. If endLocal is earlier than startLocal on the clock,
 * the window ends on the next local day.
 */
export interface ShiftWindow {
  id: string;
  group: string;
  /** 1..4, higher wins. */
  priority: number;
  playlistId: string;
  startLocal: string;
  endLocal: string;
}

/** An emergency alert with absolute UTC bounds. Priority is always 5. */
export interface Alert {
  id: string;
  group: string;
  contentId: string;
  /** Inclusive UTC epoch ms. */
  startUtc: number;
  /** Exclusive UTC epoch ms. */
  endUtc: number;
}

export interface Config {
  playlists: Playlist[];
  windows: ShiftWindow[];
  alerts: Alert[];
}

/** What is on screen at an instant. null means idle. */
export interface Frame {
  sourceId: string;
  contentId: string;
}

export type MaybeFrame = Frame | null;

/** A half-open [start, end) UTC interval with a constant frame. */
export interface Segment {
  startUtc: number;
  endUtc: number;
  frame: MaybeFrame;
}
