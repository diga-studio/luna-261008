# scorm12-packager

SCORM 1.2 离线课程打包库（TypeScript），由上层直接调用，输出 ZIP 内容包。

调用方提供课程快照与已生成好的 HTML（含课程展示与学习运行时），本库负责：
解析 HTML 中的本地静态引用、计算各 SCO 可达闭包、重新安排包内文件路径并改写引用、
生成 `imsmanifest.xml`，最终导出 ZIP。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

无运行时依赖；开发依赖仅 `typescript` 与 `@types/node`。

## 使用

```ts
import { packCourse } from 'scorm12-packager';

const result = packCourse({
  snapshot: {
    title: '课程标题',
    modules: [
      { title: '模块一', entry: '模块一/入口 页.html' },
      { title: '模块二', entry: 'm2/index.html' },
    ],
  },
  sourceDir: '/path/to/课程源文件目录',
  outputDir: '/path/to/产物目录',
  zipFileName: 'course.zip', // 可省略，默认 course.zip
});

// result.zipPath      生成的 ZIP 绝对路径
// result.pathMap      源相对路径 -> 包内路径
// result.packageFiles 包内全部资源路径（不含清单）
// result.scos         各 SCO 的清单 identifier 与声明文件集合
```

## 行为约定

- 源文件以大小写敏感的相对路径标识，文件名可含中文、空格、百分号与 XML 特殊字符。
- 仅解析 HTML（UTF-8、无 `base` 元素）中元素上的 `href`/`src` 属性；
  属性名大小写无关，支持字符引用与带引号/无引号属性值；注释与脚本内容不算引用。
- `https:`、`data:` 开头的 URL 原样保留，不访问也不入包；其余非本地 URL 不处理。
- 本地 URL 先还原 HTML 实体，再逐段做一次 UTF-8 百分号解码并消除 `.`/`..`；
  查询参数与片段不参与文件查找，改写后原值保留。
- 只打包从模块入口可达的文件；HTML 循环引用安全终止；同一源文件在 ZIP 中只存一份。
- 包内资源路径为纯 ASCII（`res/0001.html` 形式），无大小写不敏感冲突；
  非 HTML 文件逐字节不变。
- 根目录生成 SCORM 1.2 `imsmanifest.xml`：一个默认组织按模块顺序列出项目，
  每个入口对应一个 SCO 资源，其声明文件集合恰好等于该入口的可达闭包。
