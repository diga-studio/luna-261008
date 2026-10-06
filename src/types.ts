export const SECTOR_SIZE = 512;
export const CLUSTER_SIZE = 4096;
export const RECORD_SIZE = 1024;

export interface RecoveryOptions {
  /** Absolute byte offset of the volume start inside the image. */
  volumeOffset: number;
  /** Volume length in bytes. */
  volumeLength: number;
  /** Absolute byte offset of the target $MFT record inside the image. */
  recordOffset: number;
}

export interface DataRun {
  /** Starting virtual cluster number within the file. */
  vcnStart: number;
  /** Run length in clusters. */
  lengthClusters: number;
  /** Absolute volume-relative cluster number, or null for a sparse run. */
  lcn: number | null;
}

export interface NonResidentLayout {
  resident: false;
  /** Declared logical (real) size of the stream in bytes. */
  logicalSize: number;
  /** Initialized size in bytes; bytes beyond it read as zero. */
  initializedSize: number;
  runs: DataRun[];
}

export interface ResidentLayout {
  resident: true;
  logicalSize: number;
  data: Buffer;
}

export type DataLayout = NonResidentLayout | ResidentLayout;

export interface Inspection {
  /** True when the record is marked unused and all referenced clusters are free. */
  recoverable: boolean;
  resident: boolean;
  logicalSize: number;
  initializedSize: number;
  runs: DataRun[];
}

export interface RecoveryStats {
  bytesWritten: number;
  outputPath: string;
}
