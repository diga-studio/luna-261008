# traffic-guard

进程内实时流量判定库，供 API 安全网关直接调用，精确识别请求频率滥用
（`RATE_ABUSE`）和端点扫描（`ENDPOINT_SCAN`）。

## 使用

```ts
import { TrafficGuard } from "traffic-guard";

const guard = new TrafficGuard();

// 每条请求调用一次；t 为毫秒整数时间戳，全局单调不减。
const hits = guard.observe("203.0.113.7", "/api/users", 1_700_000_000_000);
// hits: ("RATE_ABUSE" | "ENDPOINT_SCAN")[]，两者可同时命中。

// 只推进时间并清理到期状态，不产生请求或分类。
guard.advance(1_700_000_100_000);
```

## 判定规则

- `RATE_ABUSE`：同一 IP 对同一 endpoint 在最近 60000ms 内请求数 > 100。
- `ENDPOINT_SCAN`：同一 IP 在最近 300000ms 内访问的不同 endpoint 数 > 20。
- 两个窗口均为左开右闭：`(t - window, t]`。
- 每条请求都重新判定；已被分类的请求仍参与后续统计。
- 重复访问同一 endpoint 不增加端点种类，但会延长该组合的存活期。
- 时间只由调用方推进，不使用系统时钟。

## 实现与复杂度

状态由三部分组成（`src/TrafficGuard.ts`）：

- 全局事件队列：最近 300s 内的全部事件，按时间单调 FIFO，到期整体出队。
- `(ip, endpoint)` 双端队列：该组合的请求时间戳，用于 60s 频率窗口计数。
- 每 IP 的 `endpoint -> 最近时间` 映射：用于 300s 不同端点计数，懒删除
  （全局事件出队时若该事件仍是此端点的最近一次访问，才将其移除）。

复杂度（N = 最近 300s 窗口内的请求数）：

- `observe`：摊还 O(1)。每个事件入队/出队各一次，窗口计数与端点计数
  均为 O(1) 均摊的哈希表与队首操作。
- `advance`：O(k)，k 为本次到期的事件数；全程摊还仍为每事件 O(1)。
- 空间：O(N)，即两个窗口内留存的请求事件与活跃 (IP, endpoint) 组合数。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>=18）与 devDependency `typescript`；测试使用 Node 内置
`node:test` 运行器，先 `tsc` 编译再执行 `dist/test/*.test.js`。
