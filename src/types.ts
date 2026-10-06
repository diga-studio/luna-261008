/** 固定块大小：4 MiB。末块允许更短。 */
export const BLOCK_SIZE = 4 * 1024 * 1024;

/** 清单中一个块的引用：SHA-256 哈希（hex）与字节长度。 */
export interface BlockRef {
  hash: string;
  length: number;
}

/** 清单中一个文件：按顺序排列的块引用。 */
export interface ManifestFile {
  path: string;
  blocks: BlockRef[];
}

/** 清单中一个版本。 */
export interface ManifestVersion {
  id: string;
  files: ManifestFile[];
}

/** 固定版本清单。导入后不再增删。 */
export interface Manifest {
  versions: ManifestVersion[];
}

/** 损坏块的实际状态。 */
export type CorruptionKind = 'missing' | 'length-mismatch' | 'hash-mismatch';

/** 报告中一个损坏块条目。 */
export interface CorruptBlockEntry {
  hash: string;
  expectedLength: number;
  corruption: CorruptionKind;
  /** 引用该块的版本标识，去重后排序。 */
  affectedVersions: string[];
}

/** 损坏报告。只有完整校验结束才会替换当前报告。 */
export interface CorruptionReport {
  /** ISO 时间戳；null 表示尚未完成过任何完整校验。 */
  generatedAt: string | null;
  corruptBlocks: CorruptBlockEntry[];
  /** 至少有一个损坏块的版本标识，去重后排序。 */
  damagedVersions: string[];
}

export type RepairResult =
  | { status: 'repaired' }
  | { status: 'rejected'; reason: string };

/** 修复数据的输入：逐段到达的字节。 */
export type RepairChunks = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/** 导入时提供的初始块数据。 */
export interface InitialBlock {
  hash: string;
  data: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
}
