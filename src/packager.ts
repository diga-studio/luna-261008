import * as fs from 'fs';
import * as path from 'path';
import { computeClosure, normalizeRelPath, isHtmlPath, SourceGraph } from './closure';
import { findHtmlReferences, decodeHtmlEntities } from './htmlRefs';
import { isExternalUrl, isLocalUrl, resolveLocalUrl, encodePackageUrl } from './urlPath';
import { buildManifest, ManifestResource } from './manifest';
import { createZip, ZipEntry } from './zipWriter';
import type { PackOptions, PackResult, ScoReport } from './types';

/** 提取 ASCII 小写扩展名（不含点），不符合时返回空串。 */
function safeExtension(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  const ext = base.slice(dot + 1);
  return /^[A-Za-z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : '';
}

/**
 * 为闭包中的每个源文件分配包内路径：
 * 全部 ASCII、顺序编号、扩展名小写，天然不存在大小写不敏感冲突。
 */
function assignPackagePaths(files: Set<string>): Map<string, string> {
  const sorted = Array.from(files).sort();
  const map = new Map<string, string>();
  let seq = 0;
  for (const sourcePath of sorted) {
    seq++;
    const ext = safeExtension(sourcePath);
    const name = seq.toString().padStart(4, '0') + (ext === '' ? '' : '.' + ext);
    map.set(sourcePath, 'res/' + name);
  }
  return map;
}

/** 计算 from 所在目录到 to 的相对 URL 路径（均为包内路径）。 */
function relativePackageUrl(fromPackagePath: string, toPackagePath: string): string {
  const fromDir = fromPackagePath.split('/').slice(0, -1);
  const toParts = toPackagePath.split('/');
  let common = 0;
  while (common < fromDir.length && common < toParts.length - 1 && fromDir[common] === toParts[common]) {
    common++;
  }
  const ups = fromDir.length - common;
  const parts: string[] = [];
  for (let i = 0; i < ups; i++) parts.push('..');
  for (let i = common; i < toParts.length; i++) parts.push(toParts[i]);
  return parts.join('/');
}

/** 属性值写回 HTML 前的转义。 */
function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 改写单个 HTML 的本地引用，返回新内容。 */
function rewriteHtml(
  html: string,
  currentSource: string,
  pathMap: Map<string, string>
): string {
  const refs = findHtmlReferences(html);
  const currentDir = currentSource.includes('/')
    ? currentSource.slice(0, currentSource.lastIndexOf('/'))
    : '';
  const currentPackage = pathMap.get(currentSource) as string;

  // 从后往前替换，保持下标有效。
  let result = html;
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i];
    const url = decodeHtmlEntities(ref.rawValue);
    if (isExternalUrl(url) || !isLocalUrl(url)) continue;
    const resolved = resolveLocalUrl(url, currentDir);
    if (resolved.path === '') continue; // 仅查询/片段：始终指向当前文档，无需改写。
    const targetSource = resolved.path;
    const targetPackage = pathMap.get(targetSource);
    if (targetPackage === undefined) {
      throw new Error(`内部错误：${currentSource} 引用的 ${targetSource} 不在闭包中`);
    }
    const rel = relativePackageUrl(currentPackage, targetPackage);
    const rewritten = escapeAttributeValue(encodePackageUrl(rel) + resolved.query + resolved.fragment);
    result = result.slice(0, ref.valueStart) + rewritten + result.slice(ref.valueEnd);
  }
  return result;
}

/** 从 entry 出发沿 HTML 依赖图做 BFS，返回可达源文件集合（含 entry）。 */
function reachableFrom(entry: string, graph: SourceGraph): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const deps = graph.htmlDeps.get(current);
    if (!deps) continue;
    for (const dep of deps) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

/**
 * 打包课程：计算闭包、分配包内 ASCII 路径、改写 HTML 引用、
 * 生成 imsmanifest.xml 与 ZIP，写入 outputDir 并返回结果。
 */
export function packCourse(options: PackOptions): PackResult {
  const { snapshot, sourceDir, outputDir } = options;
  const zipFileName = options.zipFileName ?? 'course.zip';

  const entries = snapshot.modules.map((m) => normalizeRelPath(m.entry));
  const graph = computeClosure(sourceDir, entries);
  const pathMap = assignPackagePaths(graph.files);

  // 生成包内文件内容。
  const fileContents = new Map<string, Buffer>();
  for (const sourcePath of graph.files) {
    const absolute = path.join(sourceDir, ...sourcePath.split('/'));
    const packagePath = pathMap.get(sourcePath) as string;
    if (isHtmlPath(sourcePath)) {
      const html = fs.readFileSync(absolute, 'utf8');
      fileContents.set(packagePath, Buffer.from(rewriteHtml(html, sourcePath, pathMap), 'utf8'));
    } else {
      fileContents.set(packagePath, fs.readFileSync(absolute));
    }
  }

  // 各 SCO 的可达闭包与清单资源。
  const scos: ScoReport[] = [];
  const resources: ManifestResource[] = [];
  const itemIdentifiers: string[] = [];
  snapshot.modules.forEach((mod, index) => {
    const entry = entries[index];
    const closure = reachableFrom(entry, graph);
    const files = Array.from(closure)
      .map((sourcePath) => pathMap.get(sourcePath) as string)
      .sort();
    const identifier = `RES-${index + 1}`;
    itemIdentifiers.push(`ITEM-${index + 1}`);
    resources.push({
      identifier,
      entryPath: pathMap.get(entry) as string,
      files,
    });
    scos.push({
      title: mod.title,
      entry,
      identifier,
      files,
    });
  });

  const manifest = buildManifest({ snapshot, itemIdentifiers, resources });

  // 汇总 ZIP 条目：清单在前，资源按包内路径排序。
  const zipEntries: ZipEntry[] = [
    { name: 'imsmanifest.xml', data: Buffer.from(manifest, 'utf8') },
  ];
  const packageFiles = Array.from(fileContents.keys()).sort();
  for (const packagePath of packageFiles) {
    zipEntries.push({ name: packagePath, data: fileContents.get(packagePath) as Buffer });
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const zipPath = path.join(outputDir, zipFileName);
  fs.writeFileSync(zipPath, createZip(zipEntries));

  const pathMapObj: Record<string, string> = {};
  for (const [sourcePath, packagePath] of Array.from(pathMap.entries()).sort()) {
    pathMapObj[sourcePath] = packagePath;
  }

  return { zipPath, packageFiles, pathMap: pathMapObj, scos };
}
