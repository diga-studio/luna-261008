import * as fs from 'fs';
import * as path from 'path';

/** 测试用最小 ZIP 读取器（支持 store 条目）。 */
export interface ZipContents {
  /** 包内路径 -> 文件字节。 */
  files: Map<string, Buffer>;
}

export function readZip(zipPath: string): ZipContents {
  const buf = fs.readFileSync(zipPath);
  // 定位结尾记录（EOCD）。
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (method !== 0) throw new Error(`测试读取器仅支持 store 条目: ${name}`);
    // 从本地头定位数据起点。
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    files.set(name, buf.slice(dataStart, dataStart + compressedSize));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { files };
}

/** 在临时目录中创建一批源文件，返回目录路径。 */
export function makeSourceDir(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'scorm-src-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

/** 创建临时输出目录。 */
export function makeOutputDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'scorm-out-'));
}

/** 从清单 XML 中提取资源声明。 */
export interface ParsedManifest {
  itemIdentifierRefs: string[];
  itemTitles: string[];
  orgTitle: string;
  resources: { identifier: string; href: string; files: string[] }[];
}

export function parseManifest(xml: string): ParsedManifest {
  const orgTitle = /<organization[^>]*>\s*<title>([\s\S]*?)<\/title>/.exec(xml)?.[1];
  if (orgTitle === undefined) throw new Error('清单缺少组织标题');
  const itemIdentifierRefs: string[] = [];
  const itemTitles: string[] = [];
  const itemRe = /<item\s+identifier="[^"]*"\s+identifierref="([^"]*)">\s*<title>([\s\S]*?)<\/title>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    itemIdentifierRefs.push(m[1]);
    itemTitles.push(m[2]);
  }
  const resources: ParsedManifest['resources'] = [];
  const resRe = /<resource\s+identifier="([^"]*)"[^>]*href="([^"]*)">([\s\S]*?)<\/resource>/g;
  while ((m = resRe.exec(xml)) !== null) {
    const files: string[] = [];
    const fileRe = /<file\s+href="([^"]*)"\/>/g;
    let f: RegExpExecArray | null;
    while ((f = fileRe.exec(m[3])) !== null) files.push(f[1]);
    resources.push({ identifier: m[1], href: m[2], files });
  }
  return { itemIdentifierRefs, itemTitles, orgTitle, resources };
}
