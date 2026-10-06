# traffic-guard

进程内实时流量判定库，供 API 安全网关直接调用，识别请求频率滥用（`RATE_ABUSE`）与端点扫描（`ENDPOINT_SCAN`）。

## 使用

```ts
import { TrafficGuard } from "./src/index";

const guard = new TrafficGuard();

// 每条请求调用一次；t 为毫秒整数时间戳，全局单调不减，由调用方推进
const hits: Set<Classification> = guard.observe(ip, endpoint, t);
// hits 可能包含 "RATE_ABUSE" / "ENDPOINT_SCAN"，可同时命中

// 只推进时间并清理到期状态
guard.advance(t);
```

判定规则（窗口均为左开右闭 `(t - window, t]`，每条请求重新判定）：

- `RATE_ABUSE`：同一 IP 对同一 endpoint 在最近 60_000 ms 内请求数 > 100。
- `ENDPOINT_SCAN`：同一 IP 在最近 300_000 ms 内访问的不同 endpoint 数 > 20。

阈值与窗口可通过构造函数参数覆盖（`rateWindowMs`、`rateMaxRequests`、`scanWindowMs`、`scanMaxEndpoints`）。

## 实现要点

- 每个 IP 独立状态，互不影响：`(ip, endpoint)` 的请求时间戳队列（数组 + 头指针，摊还 O(1) 出队）；endpoint -> lastSeen 映射 + 惰性过期的时间戳 FIFO。
- 重复访问同一 endpoint 只刷新其 lastSeen，不增加端点种类，并延长该组合的存活期。
- 不使用系统时钟，时间完全由 `observe` / `advance` 的参数推进。

## 复杂度

设 W 为窗口内未过期请求总数，E 为窗口内活跃的不同 `(ip, endpoint)` 组合数。

- `observe`：摊还 O(1)。每条请求至多入队一次、出队一次；扫描窗口用惰性删除的 FIFO 维护不同 endpoint 计数。
- `advance`：O(活跃 IP 数 + 活跃 endpoint 组合数 + 本次实际过期移除的条目数)；被移除条目总量摊还到产生它们的 `observe` 上。
- 空间：O(W + E)。

## 构建与测试

```sh
npm install
npm test   # tsc 编译后用 node:test 运行全部测试
```
