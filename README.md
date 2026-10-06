# zero-trust-cycle-check

零信任微隔离策略的**闭环检查库**。配置发布流程在上线候选策略前直接调用，
找出哪些通信条件会在网段之间形成闭环，并返回可逐跳复核的具体路径。
输入策略与分析结果只保存在内存中，不提供任何网络/存储接口。

## 使用

```ts
import { analyzePolicies, Policy } from './src';

const policies: Policy[] = [
  { source: 'dmz', destination: 'app', protocol: 'TCP', action: 'Allow',
    priority: 10, portRange: { start: 443, end: 443 } },
  { source: 'app', destination: 'db', protocol: 'TCP', action: 'Log-and-Allow',
    priority: 10, portRange: { start: 443, end: 443 } },
  { source: 'db', destination: 'dmz', protocol: 'TCP', action: 'Allow',
    priority: 10, portRange: { start: 443, end: 443 } },
];

const result = analyzePolicies(policies);
// result.tcp.ports   -> [443]        存在闭环的目的端口（升序、完整展开）
// result.tcp.evidence -> 每个端口一条可逐跳核验的闭环路径
// result.udp          -> 同上
// result.icmp         -> { hasCycle, evidence }（ICMP 无端口概念）
```

## 判定语义

- 一次分析接收完整候选策略集，分析期间不修改输入；网段标识由调用方提供，库不解析 CIDR/拓扑。
- 每条策略：源网段、目标网段、协议（`TCP`/`UDP`/`ICMP`）、动作（`Allow`/`Deny`/`Log-and-Allow`）、整数优先级；
  TCP/UDP 另带 `0–65535` 闭区间目的端口范围。同一有向网段对 + 同一协议的优先级不得重复（违反时抛错）。
- 对（源, 目标, 协议, 目的端口）：匹配策略中**优先级数值最小**的一条生效；
  无匹配默认拒绝；`Allow` 与 `Log-and-Allow` 均可通行；胜出为 `Deny` 时低优先级允许规则不补位；反方向单独判定。
- 闭环定义：经过至少两个不同网段并返回起点，除首尾外不重复网段；所有跳同协议，
  TCP/UDP 还必须同一目的端口（各跳分别可通行不同端口不算）。
- TCP/UDP 返回全部闭环端口及逐条证据；ICMP 返回是否存在闭环，存在时附一条证据。
  证据中每跳都带胜出策略的动作与优先级，可用 `createMatcher` 独立复核。

## 构建与测试

```sh
npm install
npm test        # 编译后运行 node:test 测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js 与 `typescript`（devDependency），无运行时依赖，不需要任何外部服务。
