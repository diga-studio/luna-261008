import type { ModerationChecker } from "./types.js";
/** 由词条数组创建检查器（词条为纯文本，不解释为 Markdown）。 */
export declare function createChecker(words: string[]): ModerationChecker;
/** 从本地文件加载词库并创建检查器。每行一个词条，空行与 # 开头的行被忽略。 */
export declare function loadChecker(wordlistPath: string): Promise<ModerationChecker>;
