export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface EventMeta {
  sessionId: string;
  sourceAp: string;
  sourceSeq: number;
  updatedAt: number;
}

export type SessionEvent =
  | (EventMeta & { kind: "value"; value: JsonObject })
  | (EventMeta & { kind: "delete" });

export interface WinnerInfo {
  sourceAp: string;
  sourceSeq: number;
  updatedAt: number;
}

export type SessionState =
  | { status: "value"; winner: WinnerInfo; value: JsonObject }
  | { status: "deleted"; winner: WinnerInfo }
  | { status: "absent" };
