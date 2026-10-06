import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { packCourse } from '../src/index';
import { findHtmlReferences, decodeHtmlEntities } from '../src/htmlRefs';
import { isExternalUrl, isLocalUrl, resolveLocalUrl } from '../src/urlPath';
import { makeSourceDir, makeOutputDir, readZip, parseManifest } from './helpers';

const SHARED_PAGE = `<html><body>
<img src="img.png">
<img src="../shared/pic.png">
<a href="page.html?self=1">自引用</a>
</body></html>
`;

const ONE_HTML = `<html><body>
<a href="two.html">去二</a>
<img src="../shared/pic.png">
</body></html>
`;

const TWO_HTML = `<html><body>
<a href="one.html">回一</a>
</body></html>
`;

const IMG_A = Buffer.from([0xaa, 0x01]);
const IMG_B = Buffer.from([0xbb, 0x02]);
const PIC = Buffer.from([0xcc, 0x03]);

/** 独立闭包计算：测试侧自行遍历，不复用 packager 的 computeClosure。 */
function independentClosure(sourceDir: string, entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (!/\.html?$/i.test(current)) continue;
    const html = fs.readFileSync(path.join(sourceDir, ...current.split('/')), 'utf8');
    const dir = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
    for (const ref of findHtmlReferences(html)) {
      const url = decodeHtmlEntities(ref.rawValue);
      if (isExternalUrl(url) || !isLocalUrl(url)) continue;
      const resolved = resolveLocalUrl(url, dir);
      const target = resolved.path === '' ? current : resolved.path;
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

function fixture() {
  const sourceDir = makeSourceDir({
    'a/page.html': SHARED_PAGE,
    'b/page.html': SHARED_PAGE,
    'a/img.png': IMG_A,
    'b/img.png': IMG_B,
    'shared/pic.png': PIC,
    'c/one.html': ONE_HTML,
    'c/two.html': TWO_HTML,
    'unrelated.txt': '无关文件',
    'shared/unused.png': Buffer.from([0x00]),
  });
  const outputDir = makeOutputDir();
  const result = packCourse({
    snapshot: {
      title: '闭包测试',
      modules: [
        { title: '甲', entry: 'a/page.html' },
        { title: '乙', entry: 'b/page.html' },
        { title: '丙', entry: 'c/one.html' },
      ],
    },
    sourceDir,
    outputDir,
  });
  return { result, sourceDir, zip: readZip(result.zipPath) };
}

test('同字节异目录 HTML 分别按各自目录解析依赖', () => {
  const { result, zip } = fixture();
  const { pathMap } = result;

  // 同名不同目录的 img.png 是两个不同的包内文件。
  assert.notEqual(pathMap['a/img.png'], pathMap['b/img.png']);
  assert.deepEqual(zip.files.get(pathMap['a/img.png']), IMG_A);
  assert.deepEqual(zip.files.get(pathMap['b/img.png']), IMG_B);

  // 共享媒体只存一份。
  const picCount = result.packageFiles.filter((p) => p === pathMap['shared/pic.png']).length;
  assert.equal(picCount, 1);

  // 两份同字节 HTML 改写后内容不同：各自指向自己目录的 img.png。
  const htmlA = zip.files.get(pathMap['a/page.html'])!.toString('utf8');
  const htmlB = zip.files.get(pathMap['b/page.html'])!.toString('utf8');
  assert.notEqual(htmlA, htmlB);
  const pkgName = (p: string) => p.replace('res/', '');
  assert.ok(htmlA.includes(`src="${pkgName(pathMap['a/img.png'])}"`));
  assert.ok(htmlB.includes(`src="${pkgName(pathMap['b/img.png'])}"`));
  // 共享媒体指向同一份。
  assert.ok(htmlA.includes(`src="${pkgName(pathMap['shared/pic.png'])}"`));
  assert.ok(htmlB.includes(`src="${pkgName(pathMap['shared/pic.png'])}"`));
});

test('循环引用处理终止，无关文件不入包', () => {
  const { result } = fixture();
  // c/one.html <-> c/two.html 循环已正常终止（测试能完成即证明）。
  assert.ok(result.packageFiles.includes(result.pathMap['c/two.html']));
  // 无关文件不入包。
  assert.equal(result.packageFiles.length, 7);
  assert.ok(!Object.keys(result.pathMap).some((p) => p.includes('unrelated')));
  assert.ok(!Object.keys(result.pathMap).some((p) => p.includes('unused')));
});

test('各 SCO 声明集合与独立计算的可达闭包一致', () => {
  const { result, sourceDir, zip } = fixture();
  const xml = zip.files.get('imsmanifest.xml')!.toString('utf8');
  const manifest = parseManifest(xml);

  assert.equal(manifest.resources.length, 3);
  const resourceIds = new Set(manifest.resources.map((r) => r.identifier));
  for (const ref of manifest.itemIdentifierRefs) {
    assert.ok(resourceIds.has(ref), `identifierref ${ref} 应有效`);
  }

  const entries = ['a/page.html', 'b/page.html', 'c/one.html'];
  entries.forEach((entry, index) => {
    // 测试侧独立计算的闭包。
    const expected = [...independentClosure(sourceDir, entry)]
      .map((src) => result.pathMap[src])
      .sort();
    // 清单中声明的集合。
    assert.deepEqual(
      [...manifest.resources[index].files].sort(),
      expected,
      `SCO ${entry} 的清单声明集合应等于独立闭包`
    );
    // 返回值中的集合。
    assert.deepEqual(result.scos[index].files, expected);
    // 资源 href 是入口的包内路径。
    assert.equal(manifest.resources[index].href, result.pathMap[entry]);
  });

  // 甲、乙两 SCO 闭包各自独立：甲不含 b/img.png，乙不含 a/img.png。
  assert.ok(!result.scos[0].files.includes(result.pathMap['b/img.png']));
  assert.ok(!result.scos[1].files.includes(result.pathMap['a/img.png']));
  // 丙的闭包恰好是 one/two 与共享媒体。
  assert.deepEqual(result.scos[2].files, [
    result.pathMap['c/one.html'],
    result.pathMap['c/two.html'],
    result.pathMap['shared/pic.png'],
  ]);
});
