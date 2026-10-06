/** 课程快照中的一个模块。 */
export interface ModuleSnapshot {
  /** 模块标题，按 XML 规则保留原文写入清单。 */
  title: string;
  /** 模块入口 HTML 的源相对路径（大小写敏感，可含中文/空格/百分号）。 */
  entry: string;
}

/** 课程快照：标题 + 按顺序排列的模块。 */
export interface CourseSnapshot {
  title: string;
  modules: ModuleSnapshot[];
}

/** 打包选项。 */
export interface PackOptions {
  /** 课程快照。 */
  snapshot: CourseSnapshot;
  /** 课程源文件根目录（快照中的相对路径相对此目录解析）。 */
  sourceDir: string;
  /** 产物输出目录（ZIP 写入此目录下）。 */
  outputDir: string;
  /** 输出 ZIP 文件名，默认 "course.zip"。 */
  zipFileName?: string;
}

/** 单个 SCO 资源在清单中声明的文件集合等信息。 */
export interface ScoReport {
  /** 模块标题。 */
  title: string;
  /** 入口源路径。 */
  entry: string;
  /** 清单 identifier。 */
  identifier: string;
  /** 该 SCO 声明的包内文件（不含清单本身），按字典序排列。 */
  files: string[];
}

/** 打包结果。 */
export interface PackResult {
  /** 生成的 ZIP 文件绝对路径。 */
  zipPath: string;
  /** 包内全部资源路径（不含 imsmanifest.xml），按字典序排列。 */
  packageFiles: string[];
  /** 源相对路径 -> 包内路径 的映射。 */
  pathMap: Record<string, string>;
  /** 各 SCO 的声明信息。 */
  scos: ScoReport[];
}
