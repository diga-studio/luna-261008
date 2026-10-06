/** 单个保留版本的元信息 */
export interface VersionInfo {
  version: number;
  sha256: string;
  size: number;
}

/** inspect 的返回结果 */
export interface InspectResult {
  output: string;
  /** 当前版本号；输出尚不存在时为 null */
  currentVersion: number | null;
  /** 当前交付文件的绝对路径（输出存在时指向普通文件） */
  currentPath: string;
  /** 仍保留的历史版本，按版本号升序 */
  versions: VersionInfo[];
}
