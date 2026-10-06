# task26100842

离线门禁权限追溯库（TypeScript，纯内存，单固定出入口）。

权威端已算好权限，本库只负责缓存判定与延迟对账：

- `ingestAuthority(records)` — 导入权威记录（变更/封口），可乱序、重复。
- `makeCache()` — 导出最新完整封口对应的不可变缓存。
- `checkOffline(cache, token, window)` — 仅依据传入缓存做本地放行判定，产出入场记录。
- `reconcile(events)` — 对入场记录给出最终结论（`allowed` / `denied` / `uncertain`）或 `pending`。

## 语义要点

- 变更记录自 `effectiveAt` 起适用；同一身份同毫秒取最大 `seq`；首次变更之前视为拒绝。
- 准入 = 状态 `active` + 有准入权限 + 所属单位不在黑名单。
- 令牌有效期左闭右开 `[validFrom, validTo)`；入场窗口为闭区间 `[start, end]`。
- 只有 seq 从 1 连续到齐、且封口 W 之前的记录完整时，W 才是已知完整边界；缺号后的记录不影响缓存与对账。
- `checkOffline` 仅在缓存对整个窗口允许、且整个窗口都在令牌有效期内时放行。
- `reconcile` 仅在窗口上界 ≤ 已知完整边界时给最终结论，否则 `pending`；最终结论不翻转；本地放行但最终 `denied` 标记 `anomaly`。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js 与 `devDependencies` 中的 `typescript` / `@types/node`，无其他服务。
