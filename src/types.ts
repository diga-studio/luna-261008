/** One subtitle cue on the track, as provided by the caller. */
export interface CueInput {
  /** Original start time, integer milliseconds, 0 <= start < end <= videoDuration. */
  start: number;
  /** Original end time, integer milliseconds. */
  end: number;
  /** Minimum display duration required for the translated text, milliseconds. */
  minDuration: number;
  /** Sync importance weight, integer 1..9. Higher cues resist movement more. */
  weight: number;
  /** Locked cues were manually confirmed; their times must be preserved exactly. */
  locked: boolean;
}

/** Adjusted timing of one cue. */
export interface CueTiming {
  start: number;
  end: number;
}

export interface AdjustSuccess {
  ok: true;
  /** Adjusted timings, same length and order as the input. */
  cues: CueTiming[];
  /** Sum over cues of weight * (|start - origStart| + |end - origEnd|). Globally minimal. */
  totalCost: number;
}

export interface AdjustInfeasible {
  ok: false;
}

export type AdjustResult = AdjustSuccess | AdjustInfeasible;
