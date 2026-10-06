import * as fs from 'fs';
import * as path from 'path';
import { Application, Definition } from './types';

/** 内存状态 + JSON 文件持久化 */
export interface PersistedState {
  definitions: Definition[];
  applications: Application[];
  /** 操作标识 -> 首次业务结果（用于幂等重试） */
  opLog: Record<string, unknown>;
  seq: number;
}

function emptyState(): PersistedState {
  return { definitions: [], applications: [], opLog: {}, seq: 0 };
}

export class Store {
  private readonly filePath: string;
  private readonly data: PersistedState;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): PersistedState {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return emptyState();
    }
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      definitions: parsed.definitions ?? [],
      applications: parsed.applications ?? [],
      opLog: parsed.opLog ?? {},
      seq: parsed.seq ?? 0,
    };
  }

  get state(): PersistedState {
    return this.data;
  }

  /** 将当前状态原子落盘（先写临时文件再改名） */
  save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}
