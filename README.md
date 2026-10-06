# FleetGuard 增量配置解析库

设备与组通过稳定 ID 绑定配置，库以增量聚合维护“最严格合并”的有效策略：
任何撤销（解绑、退组、改写配置）都会精确放宽到剩余来源共同要求的值。

## 使用

```ts
import { FleetGuard } from './src';

const fg = new FleetGuard();
fg.putProfile('p1', { minPinLength: 10, allowedSsids: ['corp'] });
fg.bindProfiles({ kind: 'group', id: 'g1' }, ['p1'], []);
fg.joinGroups('dev1', ['g1'], []);
fg.resolve('dev1');
// { minPinLength: 10, maxAutoLockSeconds: 120, allowCamera: true,
//   allowScreenshots: true, allowedSsids: ['corp'] }
```

## 合并语义

- `minPinLength` 取最大值（基础值 6）；`maxAutoLockSeconds` 取最小值（基础值 120）。
- `allowCamera` / `allowScreenshots` 取逻辑与（基础值均为允许）。
- `allowedSsids` 为所有已声明白名单的交集；缺省不约束，空白名单禁止所有 WiFi；
  无任何声明白名单时返回 `null`（不返回空数组）。
- 绑定与成员关系均为集合：重复添加不增加份数，同一配置经多条路径命中时，
  撤销一条路径不影响其它路径提供的约束。

## 结构

- `src/multiset.ts`：懒删除二叉堆的极值多重集合（max/min），增删查摊还 O(log n)。
- `src/aggregate.ts`：单目标的增量聚合。数值维度用多重集合；布尔维度用取反计数；
  白名单用“ssid → 声明它的配置数”再按计数分桶，交集即计数等于声明配置数的桶，
  单份配置增删只触碰其自身 SSID（≤64），与目标上 SSID 总数无关。
- `src/fleetguard.ts`：主类。设备/组各自只聚合直接绑定的配置；设备记录自己的组
  （≤32），组不记录成员；`resolve` 在读取时合并设备聚合与 ≤32 个组聚合。
  `profileTargets` 反向索引使 `putProfile` 只更新直接绑定该配置的目标。

因此单份配置修改或单条绑定增删的摊还工作量，只随该配置直接绑定的目标数与
对数因子增长，不随未变绑定数、SSID 总数或成员设备数增长；组策略刷新不触碰
任何成员设备。

## 验证

```sh
npm install
npm test
```

- `test/random.test.ts`：逐份合并参考模型 + 多种子随机操作核对，覆盖字段缺省、
  空白名单、白名单交集为空。
- `test/multipath.test.ts`：同一配置经直接绑定与两个组命中，逐条撤销路径；
  WiFi 从禁止全部 → 有限集合 → 无限制。
- `test/scale.test.ts`：2 万份配置、1 万台设备的共享组，用 `fg.stats`
  （profileFolds / ssidEntryTouches / memberIterations）确定性证明更新不重扫
  其它原始配置、不触碰全部 SSID、不遍历成员设备，且 resolve 零折叠。
