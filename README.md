# zero-trust-cycle-check

零信任微隔离策略闭环检查库。由配置发布流程直接以库形式调用，输入策略与分析结果只保存在内存中，无接口层、无持久化、不监听任何端口。

## 能力

- 输入一次完整的候选策略集（分析期间不修改），逐协议判定跨网段闭环。
- 每条策略：源网段、目标网段、协议（TCP/UDP/ICMP）、动作（Allow / Deny / Log-and-Allow）、整数优先级；TCP/UDP 另含 0-65535 闭区间目的端口范围。
- 生效规则：同一有向网段对、同一协议、同一目的端口上，匹配策略中优先级数值最小者生效；无匹配即拒绝；Deny 胜出会截断低优先级 Allow 的通行范围；反方向单独判定。
- 闭环定义：至少经过两个不同网段并返回起点，除首尾外网段不重复；所有跳使用同一协议，TCP/UDP 还必须使用同一目的端口。
- 输出：TCP/UDP 各自返回所有存在闭环的目的端口及可逐跳核验的证据路径；ICMP 返回是否存在闭环，存在时附一条证据。

## 使用

```ts
import { analyzePolicies } from "zero-trust-cycle-check";

const result = analyzePolicies(policies);
result.tcp.ports;            // 存在闭环的 TCP 目的端口（升序）
result.tcp.evidence.get(p);  // 端口 p 的一条可逐跳核验闭环证据
result.icmp.hasCycle;        // ICMP 是否存在闭环
result.icmp.evidence;        // 存在时的证据路径
```

网段标识由调用方提供（`SegmentId = string`），库不处理 CIDR 或拓扑管理。

## 构建与测试

```sh
npm install
npm test        # 先 tsc 编译到 dist/，再用 node:test 运行全部测试
```

仅依赖 `typescript` 与 `@types/node`（均为 devDependencies），不需要 Docker、数据库或任何常驻服务。
