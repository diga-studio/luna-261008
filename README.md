# CraftBridge 人才推荐组件

进程内人才推荐库：从插画师、动画师、摄影摄像师、UX 设计师中按全局匹配规则为项目推荐最多 20 名人才。人才资料与规则只保存在内存中，不做持久化。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

```ts
import { CraftBridge } from "craftbridge-talent-recommender";

const bridge = new CraftBridge();
bridge.loadTalents([...]);      // 整批装载人才
bridge.replaceTalent(talent);   // 替换/新增一名人才
bridge.updateRules(rules);      // 调整全局匹配规则（五项权重合计 100 + 最低质量门槛）
const top = bridge.recommend(project); // 推荐最多 20 人，按总分降序、同分按编号升序
```

## 评分规则

- 入选条件：与项目有共同专业标签，且质量值达到门槛（允许名单仅豁免质量门槛；禁止名单无条件排除且优先于允许名单）。
- 五项评分：标签交集/并集、质量值/500、预算适配度 min(1, 时薪/预算下限, 预算上限/时薪)、可接单 1/0、min(工龄,20)/20。
- 每项先乘 10000 向下取整再乘权重求和；全程整数运算，无浮点误差。
- 推荐时对全部人才逐人评分排序，无缓存，资料/规则修改后下一次推荐立即生效。
