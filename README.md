# offline-access-tracer

单出入口的离线门禁权限追溯库（TypeScript，纯内存，无外部服务依赖）。

权威端已完成权限计算，扫码与校时由外部保证可信。本库只负责两件事：

- **缓存判定**：基于已封口的权威历史导出不可变缓存，离线据此放行。
- **延迟对账**：权威记录补齐后，对本地入场记录给出最终结论。

## API

```ts
import { createAccessTracer } from "offline-access-tracer";

const tracer = createAccessTracer();
tracer.ingestAuthority(records);        // 导入权威记录，可乱序、可重复
const cache = tracer.makeCache();       // 最新完整封口对应的不可变缓存
const { allowed, event } = tracer.checkOffline(cache, token, window); // 本地放行判定
const results = tracer.reconcile([event]); // 同步后延迟对账
```

- `ingestAuthority(records)`：权威记录从 `seq=1` 连续编号，含权限变更（`change`）与封口（`seal`）。缺号之后的记录不参与任何判定；重复投递按 `seq` 去重。
- `makeCache()`：只包含从 1 到最新完整封口的记录所确定的历史，返回深冻结对象。
- `checkOffline(cache, token, window)`：只依据传入缓存。身份在窗口内每个整数毫秒均处于 `active`、有准入权限且不在黑名单，且整个闭区间窗口落在令牌有效期 `[validFrom, validTo)` 内时放行。首次变更之前视为拒绝。
- `reconcile(events)`：窗口上界 ≤ 已知完整边界时给出最终结论——全程允许为 `allowed`，全程拒绝为 `denied`，两者皆有（如中途暂停）为 `uncertain`；否则为 `pending`。本地已放行但最终 `denied` 的记录标记 `anomaly: true`；`uncertain` 不算确定违规。最终结论不可翻转。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js（≥18）与 npm；`npm install` 安装 `typescript` 与 `@types/node` 后即可直接构建、运行测试（Node 内置 test runner）。
