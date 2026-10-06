import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { packCourse } from '../src/index';
import { findHtmlReferences, decodeHtmlEntities } from '../src/htmlRefs';
import { isExternalUrl, isLocalUrl, resolveLocalUrl } from '../src/urlPath';
import { makeSourceDir, makeOutputDir, readZip, parseManifest } from './helpers';

const ENTRY_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>测试</title></head><body>
<!-- <img src="注释里的.png"> -->
<script>var x = "<img src='脚本里的.png'>";</script>
<a href="页面%20二.html?from=home&amp;to=2#第①节">第二页</a>
<img SRC='图片/示意 图①.png'>
<a HREF=%E9%9F%B3%E9%A2%91/%E4%B8%AD%25%E6%96%87.mp3?download=1>音频</a>
<a href="https://example.com/外部?a=1&amp;b=2">外部</a>
<img src="data:image/png;base64,iVBORw0KGgo=">
<a href="#页内锚点">锚点</a>
</body></html>
`;

const PAGE2_HTML = `<!DOCTYPE html>
<html><body>
<a href="../模块一/入口%20页.html">返回首页</a>
</body></html>
`;

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x20]);
const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33, 0xde, 0xad, 0xbe, 0xef]);

function fixture() {
  const sourceDir = makeSourceDir({
    '模块一/入口 页.html': ENTRY_HTML,
    '模块一/页面 二.html': PAGE2_HTML,
    '模块一/图片/示意 图①.png': PNG_BYTES,
    '模块一/音频/中%文.mp3': MP3_BYTES,
    '模块一/未引用.txt': '不应入包',
  });
  const outputDir = makeOutputDir();
  const result = packCourse({
    snapshot: {
      title: 'A&B <进阶> "课"',
      modules: [{ title: '模块<一>&"', entry: '模块一/入口 页.html' }],
    },
    sourceDir,
    outputDir,
  });
  return { result, zip: readZip(result.zipPath) };
}

test('中文/百分号文件名、实体、查询与片段：每条本地引用都指向正确资源', () => {
  const { result, zip } = fixture();
  const { pathMap } = result;

  // 反向映射：包内路径 -> 源路径。
  const reverse = new Map<string, string>();
  for (const [src, pkg] of Object.entries(pathMap)) reverse.set(pkg, src);

  // 通用校验：包内每个 HTML 的每条本地引用都能访问到包内真实资源。
  for (const pkgPath of result.packageFiles) {
    if (!/\.html?$/.test(pkgPath)) continue;
    const html = zip.files.get(pkgPath)!.toString('utf8');
    const dir = pkgPath.includes('/') ? pkgPath.slice(0, pkgPath.lastIndexOf('/')) : '';
    for (const ref of findHtmlReferences(html)) {
      const url = decodeHtmlEntities(ref.rawValue);
      if (isExternalUrl(url) || !isLocalUrl(url)) continue;
      const resolved = resolveLocalUrl(url, dir);
      const target = resolved.path === '' ? pkgPath : resolved.path;
      assert.ok(zip.files.has(target), `${pkgPath} 的引用 ${url} 应指向包内资源 ${target}`);
      assert.ok(reverse.has(target), `${target} 应能映射回源文件`);
    }
  }

  // 具体映射：入口 HTML 中的三条本地引用。
  const entryPkg = pathMap['模块一/入口 页.html'];
  const entryHtml = zip.files.get(entryPkg)!.toString('utf8');
  const refs = findHtmlReferences(entryHtml).map((r) => decodeHtmlEntities(r.rawValue));

  const page2Url = refs.find((u) => u.includes('?from=home'));
  assert.ok(page2Url, '应保留查询参数与片段');
  assert.ok(page2Url!.startsWith(pathMap['模块一/页面 二.html'].replace('res/', '') + '?'));
  assert.ok(page2Url!.includes('?from=home&to=2#第①节'), '查询与片段原值保留');

  const imgUrl = refs.find((u) => u.endsWith('.png'));
  assert.equal(imgUrl, pathMap['模块一/图片/示意 图①.png'].replace('res/', ''));

  const mp3Url = refs.find((u) => u.includes('download=1'));
  assert.ok(mp3Url!.startsWith(pathMap['模块一/音频/中%文.mp3'].replace('res/', '') + '?'));

  // 页面二指回入口（经过 .. 与百分号解码）。
  const page2Html = zip.files.get(pathMap['模块一/页面 二.html'])!.toString('utf8');
  const backRefs = findHtmlReferences(page2Html).map((r) => decodeHtmlEntities(r.rawValue));
  assert.equal(backRefs.length, 1);
  assert.equal(backRefs[0], entryPkg.replace('res/', ''));
});

test('外部 https:/data: 引用原样保留，注释与脚本不算引用', () => {
  const { result, zip } = fixture();
  const entryHtml = zip.files.get(result.pathMap['模块一/入口 页.html'])!.toString('utf8');
  assert.ok(entryHtml.includes('href="https://example.com/外部?a=1&amp;b=2"'));
  assert.ok(entryHtml.includes('src="data:image/png;base64,iVBORw0KGgo="'));
  assert.ok(entryHtml.includes('注释里的.png'), '注释内容原样保留但不改写');
  assert.ok(entryHtml.includes('脚本里的.png'), '脚本内容原样保留但不改写');
  // 注释/脚本中的伪引用不产生额外包内文件。
  assert.equal(result.packageFiles.length, 4);
  assert.ok(!result.packageFiles.some((p) => p.includes('未引用')));
});

test('非 HTML 文件逐字节不变', () => {
  const { result, zip } = fixture();
  assert.deepEqual(zip.files.get(result.pathMap['模块一/图片/示意 图①.png']), PNG_BYTES);
  assert.deepEqual(zip.files.get(result.pathMap['模块一/音频/中%文.mp3']), MP3_BYTES);
});

test('清单：SCORM1.2 元数据、标题 XML 转义、标识引用有效', () => {
  const { result, zip } = fixture();
  const xml = zip.files.get('imsmanifest.xml')!.toString('utf8');
  assert.ok(xml.includes('xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"'));
  assert.ok(xml.includes('<schema>ADL SCORM</schema>'));
  assert.ok(xml.includes('<schemaversion>1.2</schemaversion>'));

  const manifest = parseManifest(xml);
  assert.equal(manifest.orgTitle, 'A&amp;B &lt;进阶&gt; "课"');
  assert.deepEqual(manifest.itemTitles, ['模块&lt;一&gt;&amp;"']);

  // item 的 identifierref 必须指向存在的 resource。
  const resourceIds = new Set(manifest.resources.map((r) => r.identifier));
  for (const ref of manifest.itemIdentifierRefs) {
    assert.ok(resourceIds.has(ref), `identifierref ${ref} 应有效`);
  }

  // 唯一 SCO 的声明集合 = 全部可达文件。
  assert.equal(manifest.resources.length, 1);
  const sco = manifest.resources[0];
  assert.equal(sco.href, result.pathMap['模块一/入口 页.html']);
  assert.deepEqual([...sco.files].sort(), [...result.packageFiles].sort());
  assert.deepEqual(result.scos[0].files, [...result.packageFiles].sort());
});

test('包内路径全部 ASCII 且无大小写不敏感冲突', () => {
  const { result } = fixture();
  const lowered = new Set<string>();
  for (const pkgPath of result.packageFiles) {
    assert.ok(/^[\x20-\x7e]+$/.test(pkgPath), `${pkgPath} 应为 ASCII`);
    const key = pkgPath.toLowerCase();
    assert.ok(!lowered.has(key), `${pkgPath} 存在大小写不敏感冲突`);
    lowered.add(key);
  }
});
