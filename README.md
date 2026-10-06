# secure-audit-log

防篡改安全事件审计库（TypeScript + SQLite，无接口层）。提供四种能力：

- **追加记录** `AuditLog.append(timestampMs, prevState, nextState)`：整数毫秒时间，
  按追加顺序不递减；模块分配从 1 开始连续递增的序号。
- **取得封存凭据** `AuditLog.seal()`：返回 `{ count, head }`，承诺生成时全部记录
  的内容与顺序。凭据须由调用方在模块之外可信保存。
- **按时间窗导出** `AuditLog.export(window, credential)`：左闭右开窗口，针对凭据
  封存的前缀生成导出包。命中记录带全文，未命中位置只带时间戳与内容哈希，
  不泄露前后状态原文；空窗口同样可证。
- **独立验证** `verifyExport(pkg, window, credential)`：只依赖导出包、调用方
  指定的窗口和可信凭据，不访问数据库。通过即表示命中记录无替换、无遗漏、
  无重复、无重排，且窗口与前缀确为调用方所指定。

## 密码学构造

每条记录计算内容哈希 `H("AUDIT-CONTENT-V1" ‖ encode(record))`（编码为定长
大端序号/时间戳 + 长度前缀的 UTF-8 状态文本），再折叠进哈希链
`h_i = H("AUDIT-CHAIN-V1" ‖ h_{i-1} ‖ seq ‖ ts ‖ contentHash_i)`。凭据即链头
加记录总数。导出包覆盖前缀内每个序号各一次；验证方重放整条链并与可信链头
比对，同时逐条检查命中落在窗口内、未命中落在窗口外。由于时间戳也被链绑定，
"把非空窗口伪装成空窗口"或"漏掉一条命中"都会破坏链头或窗口检查。

## 使用

```ts
import { AuditLog, verifyExport } from "secure-audit-log";

const log = new AuditLog("audit.db");
log.append(Date.now(), "prev-state", "next-state");
const cred = log.seal();              // 调用方可信保存
const pkg = log.export({ startMs: t0, endMs: t1 }, cred);
log.close();

// 复盘方（不接触数据库）：
const hits = verifyExport(pkg, { startMs: t0, endMs: t1 }, cred);
```

重新打开数据库后，已有凭据继续有效，可继续追加与导出。

## 构建与测试

要求 Node.js ≥ 22.5（使用内置 `node:sqlite`，无原生编译依赖）。

```sh
npm install
npm test
```
