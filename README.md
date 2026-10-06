# scorm12-packager

SCORM 1.2 离线课程打包库（TypeScript，零运行时依赖）。输入课程快照与本地源文件目录，输出内存中的包文件集合或 ZIP 归档。输入 HTML 由调用方生成，本库不渲染课程内容。

## 环境要求

- Node.js ≥ 22.18（原生运行 TypeScript，无需编译步骤）
- `npm install && npm test` 即可运行全部测试（无第三方依赖）

## 用法

```ts
import { buildPackage, exportZip } from "./src/index.ts";

const snapshot = {
  title: "课程标题",
  modules: [
    { title: "模块一", entry: "模块 一/index.html" },
    { title: "模块二", entry: "mod2/intro.html" },
  ],
};

// 方式一：内存中构建，得到全部包文件（含 imsmanifest.xml）
const result = buildPackage(snapshot, "/path/to/snapshot-dir");
// result.files: [{ packagePath, sourcePath, data }]
// result.manifest / result.scos / result.pathMap

// 方式二：直接导出 ZIP
exportZip(snapshot, "/path/to/snapshot-dir", "/path/to/course.zip");
```

## 行为约定

- **引用识别**：仅解析 HTML 元素上的 `href`/`src` 属性（属性名大小写无关，支持带引号与无引号值、HTML 字符引用）。注释与 `script`/`style` 文本中的内容不算引用，其他类型文件不解析内部。
- **URL 分类**：`https:`、`data:` 及任何带协议/主机/前导斜杠的 URL 原样保留，不访问、不入包。
- **本地 URL**：先还原 HTML 字符引用，再逐路径段做一次 UTF-8 百分号解码，相对所在 HTML 的目录消除 `.`/`..`；空路径指当前 HTML。查询参数与片段不参与文件查找，改写后原样保留。
- **可达性**：除清单外只打包从至少一个模块入口可达的文件；HTML 间允许循环引用；同字节异目录的 HTML 各自按自身目录解析；同一源文件在包内只存一份。
- **包内布局**：资源统一放入 `res/`，使用纯 ASCII 编号文件名（保留 ASCII 扩展名），不存在大小写不敏感的名称冲突；非 HTML 文件逐字节不变；HTML 中的本地引用改写为指向包内资源的相对路径。
- **清单**：根目录生成 `imsmanifest.xml`（ADL SCORM 1.2），一个默认组织按模块顺序列出项目，每个入口对应一个 SCO 资源，其 `file` 集合恰好等于该入口的可达闭包；标题按 XML 规则转义保留原文。
- **错误**：入口缺失或本地引用悬空时抛出 `missing source file: ...`。

## 项目结构

- `src/types.ts` — 公开类型
- `src/htmlRefs.ts` — HTML 引用扫描与字符引用解码
- `src/urlResolve.ts` — URL 分类与本地路径解析
- `src/graph.ts` — 可达闭包计算与 HTML 改写
- `src/layout.ts` — 包内 ASCII 路径分配
- `src/rewrite.ts` — HTML 属性值替换
- `src/manifest.ts` — imsmanifest.xml 生成
- `src/zip.ts` — ZIP 写出（deflate）
- `src/pack.ts` — 编排与公开入口
- `test/` — node:test 自动化测试
