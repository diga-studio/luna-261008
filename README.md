# task26100888 — SQL 破坏性操作识别库

可嵌入调用的 TypeScript 库，供数据库监控程序从事务文本中识别
**DROP TABLE**、**TRUNCATE**、**ALTER TABLE ... DROP COLUMN** 三类破坏性操作，
并给出受影响对象与破坏性关键字的原始 UTF-8 字节偏移。

## 使用

```ts
import { DestructiveScanner, scanSql } from 'sql-destructive-scan';

// 流式：调用方按事件逐段提交 UTF-8 字节，最后明确结束事件
const scanner = new DestructiveScanner();
scanner.push(chunk1);        // Uint8Array，1 字节至 64 KiB，可切在任意字节位置
scanner.push(chunk2);
const result = scanner.finish();

// 或一次性扫描
const result2 = scanSql('DROP TABLE foo;');
```

每个事件使用独立的 `DestructiveScanner` 实例；实例不跨事件复用，
`finish()` 后不保留原始 SQL 内容（仅保留规范化后的对象名）。

## 结果

```ts
interface ScanResult {
  hits: Hit[];      // 确定命中，按出现顺序
  complete: boolean; // false = 事件结束时字符串/引用标识符/块注释未闭合，无法完整判定
}

interface Hit {
  operation: 'DROP_TABLE' | 'TRUNCATE' | 'DROP_COLUMN';
  table: string;        // 规范化表名，层级以 . 连接
  tableParts: string[]; // 名称层级（引号标识符内的点不拆分）
  column?: string;      // 仅 DROP_COLUMN
  offset: number;       // 破坏性关键字的字节偏移（删列定位到该动作的 DROP）
}
```

`complete === false` 时，已完整结束的语句命中仍然有效，未完成语句不产生命中。

## 规则摘要

- 只识别顶层三类动作；字符串、注释、过程体中的命令文本不递归解释。
- 遵循 PostgreSQL 词法：行注释、可嵌套块注释、普通/E 前缀/美元引号字符串、双引号标识符。
- 未引用标识符仅 ASCII 大写转小写；双引号标识符还原成对双引号并保留大小写。
- 内存：字符串与注释内容不落地，单事件峰值额外内存与输入大小无关（实测 < 16 MiB / 128 MiB 事件）。

## 构建与测试

```sh
npm install
npm run build      # 编译到 dist/
npm test           # node --test（Node.js >= 22.18，无需额外服务）
npm run typecheck  # 含测试文件的严格类型检查
```
