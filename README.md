# threat-scan-planner

本地威胁扫描的文件选择模块（TypeScript 库）。读取本地文件系统，生成保存在
内存中的扫描清单；不负责文件内容检测。由上层调用。

## 使用

```ts
import { planScan } from "threat-scan-planner";

const manifest = planScan({
  roots: ["/work/proj", "/data"],      // 最多 20 个已规范化的绝对路径
  whitelist: ["/work/proj/node_modules"], // 最多 200 条已规范化的绝对路径
});

for (const rec of manifest.files) {
  console.log(rec.path, rec.dev, rec.ino);
}
```

- `planScan(plan: ScanPlan): ScanManifest` — 同步遍历并返回清单。
- `ScanManifest.files: ScanRecord[]` — 每个底层文件实体一条记录，按代表路径
  的 UTF-8 字节序排序。
- `ScanRecord.path` — 该实体的代表路径：所有合法候选路径中分量数最少、
  其次按完整路径 UTF-8 字节序最小的一条。

## 语义

- 遍历普通目录并跟随文件/目录符号链接（包括指向扫描根之外的链接）；只将
  普通文件列入清单，悬空链接与其他文件类型不贡献文件。
- 候选路径保留从扫描根逐层访问时使用的名称，不替换成链接目标路径。
- 白名单按路径分量边界排除与其完全相同的候选路径及其全部后代；只作用于
  访问路径，不作用于底层文件实体。扫描根被白名单覆盖时该入口不贡献文件。
- 硬链接与符号链接最终指向同一底层文件（同一 dev+ino）时只输出一条记录；
  内容相同但彼此独立的文件分别输出。
- 结果与扫描根输入顺序、目录遍历顺序无关。

## 实现要点

- 遍历在“目录实体”（dev+ino）状态图上做 Dijkstra 式松弛，而不是枚举访问
  路径：链接环与指数级汇合路线（如 28 层双分支、2^28 条路线）的开销只与
  底层目录图规模相关。
- 白名单以前缀 trie 表示。凡不是任何白名单条目前缀的路径，其所有后代必然
  合法，归入实体状态；白名单前缀路径（至多 200×32 条）单独成状态精确匹配，
  因此“绕过白名单的环线路线”也能被发现。
- 路径比较使用扩展不变的全序（分量数优先，同分量数按全路径字节序、串尾
  视为 0x2F），保证每个目录实体只需保留一条最优访问路径即可推出正确的
  代表路径。
- 符号链接由库逐分量手动解析（`src/fsresolve.ts`），任意长的链接链与链接
  环都不会触发内核的嵌套符号链接上限（ELOOP）。

## 构建与测试

```sh
npm install
npm test        # tsc 编译 + node --test
```

只依赖 Node.js（>= 18）与 devDependencies 中的 typescript、@types/node。
