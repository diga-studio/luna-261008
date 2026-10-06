# firewall-shadow-audit

防火墙策略遮蔽审查库（TypeScript）。由上层管理程序调用：策略由调用方传入，运行数据只保存在内存，无任何外部服务依赖。

## 功能

- **`auditPolicy(rules)`**：对整份策略（最多 500 条）逐条给出 `reachable` / `shadowed` 结论。
  - `reachable`：至少存在一条连接以该规则为首个命中者，并附一条具体连接作为见证（地址、方向、具体协议、适用的目的端口）。
  - `shadowed`：所有符合该规则自身条件的连接都会先命中其他规则——包括被多条前序规则**联合**遮蔽的情况，与规则动作是否相同无关。
- **`evaluateConnection(rules, conn)`**：判定一条具体连接，返回首个命中的规则及动作；无命中时返回默认 `default-deny`。可用于核验见证。

## 语义

- 优先级 1–1000，数字越小越先检查；相同优先级按输入列表顺序。命中第一条符合所有条件的规则后立即结束（包括 `log` 动作）。
- 协议为 `TCP` / `UDP` / `ICMP` / `ANY`。`ANY` 覆盖三种具体协议且不设端口条件；`ICMP` 不设端口条件；TCP/UDP 规则的端口闭区间（0–65535）不适用于 ICMP 连接。
- 支持 IPv4 与 IPv6。规则的源/目的 CIDR 属于同一地址族，两种地址族互不匹配；IPv4 映射 IPv6 地址属于 IPv6。CIDR 中的非零主机位按网络前缀解释。
- 分析是精确的：覆盖完整地址与端口空间（含 IPv6 全地址范围、仅剩一个地址+端口组合的情况），不会把“没找到示例”误判为完全遮蔽。

## 使用

```ts
import { auditPolicy, evaluateConnection, type Rule } from 'firewall-shadow-audit';

const rules: Rule[] = [
  { id: 'r1', priority: 10, direction: 'inbound', protocol: 'TCP',
    sourceCidr: '10.0.0.0/9', destCidr: '10.0.0.0/8',
    action: 'allow', portRange: { start: 80, end: 80 } },
  { id: 'r2', priority: 20, direction: 'inbound', protocol: 'TCP',
    sourceCidr: '10.128.0.0/9', destCidr: '10.0.0.0/8',
    action: 'deny', portRange: { start: 80, end: 80 } },
  { id: 'r3', priority: 30, direction: 'inbound', protocol: 'TCP',
    sourceCidr: '10.0.0.0/8', destCidr: '10.0.0.0/8',
    action: 'allow', portRange: { start: 80, end: 80 } },
];

const audits = auditPolicy(rules);
// r3 => { status: 'shadowed' }（被 r1、r2 联合遮蔽）

for (const a of audits) {
  if (a.status === 'reachable') {
    // 见证可核验：首命中者必为该规则
    console.assert(evaluateConnection(rules, a.witness!).ruleId === a.ruleId);
  }
}
```

## 类型

```ts
interface Rule {
  id: string;
  priority: number;              // 1..1000
  direction: 'inbound' | 'outbound';
  protocol: 'TCP' | 'UDP' | 'ICMP' | 'ANY';
  sourceCidr: string;
  destCidr: string;
  action: 'allow' | 'deny' | 'log';
  portRange?: { start: number; end: number }; // 仅 TCP/UDP 规则
}

interface Connection {
  direction: 'inbound' | 'outbound';
  protocol: 'TCP' | 'UDP' | 'ICMP';
  sourceAddress: string;
  destAddress: string;
  destPort?: number;             // 仅 TCP/UDP 连接
}
```

## 性能

500 条混合地址族、地址/端口区间交叉重叠的策略，分析耗时远低于 15 秒、峰值内存远低于 256 MiB（见 `test/scale.test.ts` 的规模场景断言）。一次分析期间策略固定，不做并发修改。

## 开发

```sh
npm install
npm test        # 构建 + 运行全部测试
npm run build   # 仅构建到 dist/
```
