# TalentBridge

离线双向匹配库：为候选人推荐岗位，也为岗位推荐候选人。两个方向使用同一套业务评分。

## 安装与测试

```sh
npm install
npm test        # 编译并运行全部正确性测试与规模性能测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js（>=18）与开发依赖 typescript / @types/node，无任何运行时依赖。

## 使用

```ts
import { TalentBridge } from "talentbridge";

const tb = new TalentBridge();
tb.loadData({ jobs, candidates, zips });        // 直接传入内存数据
// 或 tb.loadFromFiles({ jobs: "jobs.json", candidates: "candidates.ndjson", zips: "zips.json" });

const jobs25 = tb.recommendJobsForCandidate("C123");
const cands25 = tb.recommendCandidatesForJob("J456");
// => [{ id, score }, ...] 最多 25 条，score 为四舍五入到 6 位小数的综合分
```

输入文件支持 JSON 数组或 NDJSON（每行一个对象）。载入后数据不可变，重复查询结果确定。

## 评分规则

- 通勤距离：双方邮编中心点的球面最短距离（haversine，地球半径 3958.7613 英里），不取整。
- 技能比例 = 共同技能数 / 岗位所需技能数（岗位无技能要求时取 1）。
- 通勤比例 = 1 - 距离 / 该候选人通勤半径；距离超过半径的配对被排除，恰好在边界上可入选。
- 时间比例 = 共同时段数 / 岗位所需时段数（一周 14 个上午/下午时段，编号 0..13）。
- 综合分 = 50·技能比例 + 30·通勤比例 + 20·时间比例，四舍五入到 6 位小数。
- 排序：综合分降序，同分按被推荐对象 ID 的 ASCII 字典序升序；返回前 25 项。
- 反向推荐使用每个候选人自己的通勤半径，两个方向同一配对的得分一致。

排名是精确的：内部仅用空间网格跳过不可能入选的邮编，所有可能入选的配对都按精确距离与完整公式计分。
