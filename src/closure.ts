import * as fs from 'fs';
import * as path from 'path';
import { findHtmlReferences, decodeHtmlEntities } from './htmlRefs';
import { isExternalUrl, isLocalUrl, resolveLocalUrl } from './urlPath';

/** 依赖图：源相对路径 -> 其引用的本地源相对路径集合。 */
export interface SourceGraph {
  /** 全部可达源文件（含入口）。 */
  files: Set<string>;
  /** 每个 HTML 源文件解析出的本地依赖（源相对路径，按出现顺序，去重）。 */
  htmlDeps: Map<string, string[]>;
}

/** 规范化源相对路径：统一为 POSIX 分隔符并消除 "." / ".."。 */
export function normalizeRelPath(relPath: string): string {
  const segments = relPath.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** 判断路径是否为 HTML 文件（按扩展名，大小写无关）。 */
export function isHtmlPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function dirOf(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index < 0 ? '' : relPath.slice(0, index);
}

/**
 * 从模块入口集合出发，解析 HTML 引用，计算可达闭包。
 * HTML 之间允许循环引用，处理必须终止；非 HTML 文件不再展开。
 * 本地引用指向不存在的文件时抛错。
 */
export function computeClosure(sourceDir: string, entries: string[]): SourceGraph {
  const files = new Set<string>();
  const htmlDeps = new Map<string, string[]>();
  const queue: string[] = [];

  for (const entry of entries) {
    const normalized = normalizeRelPath(entry);
    if (!files.has(normalized)) {
      files.add(normalized);
      queue.push(normalized);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const absolute = path.join(sourceDir, ...current.split('/'));
    if (!fs.existsSync(absolute)) {
      throw new Error(`源文件不存在: ${current}`);
    }
    if (!isHtmlPath(current)) continue;

    const html = fs.readFileSync(absolute, 'utf8');
    const deps: string[] = [];
    const seen = new Set<string>();
    for (const ref of findHtmlReferences(html)) {
      const url = decodeHtmlEntities(ref.rawValue);
      if (isExternalUrl(url) || !isLocalUrl(url)) continue;
      const resolved = resolveLocalUrl(url, dirOf(current));
      // 空路径指当前 HTML 自身。
      const target = resolved.path === '' ? current : resolved.path;
      if (!files.has(target)) {
        const targetAbsolute = path.join(sourceDir, ...target.split('/'));
        if (!fs.existsSync(targetAbsolute)) {
          throw new Error(`HTML ${current} 引用了不存在的文件: ${target}`);
        }
        files.add(target);
        queue.push(target);
      }
      if (!seen.has(target)) {
        seen.add(target);
        deps.push(target);
      }
    }
    htmlDeps.set(current, deps);
  }

  return { files, htmlDeps };
}
