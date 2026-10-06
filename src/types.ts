/** 固定几何参数（本库不支持其它规格）。 */
export const SECTOR_SIZE = 512;
export const CLUSTER_SIZE = 4096;
export const RECORD_SIZE = 1024;
export const SECTORS_PER_RECORD = RECORD_SIZE / SECTOR_SIZE;
export const SECTORS_PER_CLUSTER = CLUSTER_SIZE / SECTOR_SIZE;

/** 打开卷所需的全部外部输入。 */
export interface VolumeOptions {
  /** raw/dd 镜像路径（只读打开）。 */
  imagePath: string;
  /** 卷在镜像中的起始字节偏移（调用方保证可信）。 */
  volumeOffset: number;
  /** 卷字节长度。 */
  volumeLength: number;
  /** 覆盖整个卷的分配位图文件路径（卷内簇号寻址，低位=小簇号）。 */
  bitmapPath: string;
}

/** 一条数据运行段（稀疏段 lcn 为 null）。 */
export interface DataRun {
  /** 起始虚拟簇号（文件内逻辑簇）。 */
  vcn: number;
  /** 段长度（簇）。 */
  lengthClusters: number;
  /** 起始物理簇（卷内簇号）；稀疏段为 null。 */
  lcn: number | null;
}

/** 检查记录后得到的可恢复候选描述。 */
export interface RecoveryCandidate {
  /** 记录是否标记为未使用（可恢复前提之一）。 */
  recordUnused: boolean;
  /** 数据是否驻留在记录内。 */
  resident: boolean;
  /** 逻辑文件长度（字节，以属性声明为准）。 */
  logicalSize: number;
  /** 已初始化长度（字节）；非驻留时超出部分读为零。 */
  initializedSize: number;
  /** 非驻留时的全部运行段；驻留时为空数组。 */
  runs: DataRun[];
  /** 非驻留数据引用的全部物理簇是否均在位图中标为空闲。 */
  allClustersFree: boolean;
}
