# firewall-shadow-audit

防火墙策略遮蔽审查库。由上层管理程序调用，策略由调用方传入，运行数据只保存在内存。

## 功能

- 对每条规则给出 `reachable`（可达）或 `shadowed`（完全遮蔽）结论。完全遮蔽指所有符合该规则自身条件的连接，都会先命中其他（优先级更高或同优先级但位置更靠前）规则，包括多条前序规则联合遮蔽的情况。
- 每条可达规则附一条具体连接作为见证（地址、方向、具体协议、适用的目的端口）。
- `evaluate` 提供具体连接的判定能力，返回首个命中的规则及动作，可用于核验见证。
- 判定基于地址/端口区间的精确矩形减法，覆盖完整地址与端口空间（含 IPv6 全 128 位空间），不是采样。

## 规则模型

- 一份策略最多 500 条规则；每条规则有唯一 `id`、`priority`（1–1000，数字越小越先检查，相同优先级按输入列表顺序）、`direction`（`in`/`out`）、`protocol`（`tcp`/`udp`/`icmp`/`any`）、源/目的 CIDR、`action`（`allow`/`deny`/`log`）。
- TCP/UDP 规则带目的端口闭区间 `portRange`（0–65535）；`any` 与 `icmp` 不设置端口条件。
- 支持 IPv4 与 IPv6；两种地址族互不匹配，IPv4 映射 IPv6 地址属于 IPv6。CIDR 中的非零主机位按网络前缀解释。
- 连接命中第一条符合所有条件的规则后立即结束（包括 `log`）；无命中时默认 `deny`。

## 使用

```ts
import { PolicyAuditor } from "firewall-shadow-audit";

const auditor = new PolicyAuditor(rules);

// 全量审查：每条规则的可达性结论与见证
const report = auditor.audit();
for (const verdict of report.verdicts) {
  console.log(verdict.ruleId, verdict.status, verdict.witness);
}

// 单条连接判定：返回首个命中的规则及动作
const res = auditor.evaluate({
  direction: "in",
  protocol: "tcp",
  sourceAddress: "10.1.2.3",
  destinationAddress: "10.4.5.6",
  destinationPort: 443,
});
// res = { ruleId: string | null, action: "allow" | "deny" | "log" }
```

## 开发

```sh
npm install
npm run build   # tsc 类型检查并输出 dist/
npm test        # node:test + tsx，含穷举一致性与 500 条规则规模场景
```
