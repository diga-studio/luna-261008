# sql-destructive-scan

可嵌入调用的 SQL 破坏性操作识别库（TypeScript），供数据库监控程序以流式方式逐段提交事件字节，
识别顶层 `DROP TABLE`、`TRUNCATE` 与 `ALTER TABLE ... DROP COLUMN`，并给出受影响对象与关键字字节偏移。

## 构建与测试

```sh
npm install
npm test        # 等价于 tsc && node --expose-gc --test dist/test/*.test.js
```

仅依赖 Node.js（>= 18）与开发依赖 `typescript`、`@types/node`，不需要任何外部服务。

## 使用

```ts
import { DestructiveSqlAnalyzer, analyze } from "sql-destructive-scan";

// 流式：按事件逐段提交 UTF-8 字节（1 字节 ~ 64 KiB，可切在任意字节位置）
const a = new DestructiveSqlAnalyzer();
for (const chunk of chunks) a.push(chunk);   // chunk: Uint8Array
const result = a.end();                       // 事件结束

// 一次性：
const r2 = analyze("DROP TABLE users;");
```

结果类型：

```ts
interface AnalysisResult {
  status: "ok" | "incomplete"; // 末尾存在未闭合的字符串/引用标识符/块注释时为 incomplete
  hits: Hit[];                 // 仅包含已完整结束的语句的命中
}
interface Hit {
  operation: "dropTable" | "truncate" | "dropColumn";
  table: string[];             // 限定名按层级拆分，如 ["public", "users"]
  column?: string;             // 仅 dropColumn
  offset: number;              // 破坏性关键字的 UTF-8 字节偏移（从 0 开始）
}
```

## 识别规则

- 只识别顶层语句的 `DROP TABLE`（支持 `IF EXISTS`、多表、`CASCADE`/`RESTRICT`）、
  `TRUNCATE`（支持 `TABLE`、逐对象 `ONLY`、对象后 `*`、多表、身份序列与级联选项）、
  `ALTER TABLE`（支持 `IF EXISTS`、`ONLY`、`*`、多动作）中的删列动作
  （支持省略 `COLUMN`、`IF EXISTS`、级联选项）。
- `DELETE`、`DROP CONSTRAINT`、`DROP VIEW` 等不产生命中；字符串、注释、美元引号
  过程体中的命令文本不递归解释；其他 `ALTER` 动作表达式中的类似文本不产生命中。
- 词法遵循 PostgreSQL：行注释、可嵌套块注释、普通字符串（反斜杠不转义）、
  `E` 转义字符串（反斜杠转义）、美元引号字符串（结束标签大小写完全一致）、
  双引号标识符（`""` 还原为 `"`）；普通标识符内部的 `$` 不会误开美元字符串。
- 引号、注释、圆括号、方括号内部的分号/逗号不参与语句切分与列表切分。
- 名称规范化：未引用标识符仅将 ASCII 大写转小写；双引号标识符保留大小写并还原成对引号；
  引用名称内部的点不作为层级分隔符。
- 每个事件独立判断；事件结束后不留存任何原始 SQL 内容（字符串与注释正文从不落盘，
  标识符仅在词法分析期间短暂持有）。

## 资源约束

- 单事件 SQL 可达 128 MiB；除调用方持有的输入与返回结果外，峰值额外内存 < 16 MiB
  （词法器与分析器均为常数级状态机，长字符串/长注释不缓冲）。
- 事件结束时若字符串、引用标识符或块注释未闭合，返回 `status: "incomplete"`，
  已完成语句的命中保留，未完成语句的试探性命中被丢弃。

## 目录结构

- `src/lexer.ts` — 流式字节级 PostgreSQL 词法器（常数内存）
- `src/analyzer.ts` — 语句切分与破坏性操作识别状态机
- `src/index.ts` — 对外 API（`DestructiveSqlAnalyzer` / `analyze`）
- `test/` — node:test 自动化测试（功能、分块不变性、内存与截断）
