# FleetGuard 增量配置解析库

设备与组绑定配置，设备可加入多个组；任何设备的有效策略精确等价于
对它当前适用的全部配置执行最严格合并。撤销绑定、退出组或改写配置后，
限制随之放宽；同一配置经多条路径命中时，撤销单条路径不影响其余路径。

## 使用

```ts
import { FleetGuard } from './src/index.js';

const fg = new FleetGuard();
fg.putProfile('p1', { minPinLength: 8, allowedSsids: ['corp'] });
fg.bindProfiles({ kind: 'group', id: 'g1' }, ['p1'], []);
fg.joinGroups('device-1', ['g1'], []);
fg.bindProfiles({ kind: 'device', id: 'device-1' }, ['p2'], []);
fg.resolve('device-1'); // EffectivePolicy
```

## 合并语义

| 字段 | 合并 | 基础值 |
| --- | --- | --- |
| `minPinLength` | 取最大 | 6 |
| `maxAutoLockSeconds` | 取最小 | 120 |
| `allowCamera` / `allowScreenshots` | 逻辑与 | true |
| `allowedSsids` | 所有已声明白名单的交集 | 无声明时 `null`；空白名单禁止所有 WiFi |

## 复杂度设计

- 每个「设备直接绑定集合」与每个「组」各维护一个增量聚合
  （极值多重集合 + false 计数 + SSID 交集计数索引）。
- 单份配置修改/单条绑定增删只折叠该配置本身，均摊 O(log n)，
  与未变绑定数、SSID 总数、组成员设备数无关。
- `resolve` 现场合并设备直接聚合与至多 32 个组聚合，不重扫原始配置；
  SSID 只枚举交集结果。测试用 `getStats().profileReads` 确定性验证。

## 构建与测试

```sh
npm install
npm test
```
