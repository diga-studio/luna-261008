/** 公开类型定义：VaultTerm 会话与记录。 */

export interface VaultOpenOptions {
  dir: string;
  key: Buffer;
  sessionId: string;
}

export interface VaultRecord {
  seq: number;
  eventId: string;
  bytes: Buffer;
}

export interface ReadResult {
  sessionId: string;
  sealed: boolean;
  records: VaultRecord[];
}
