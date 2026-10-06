# render-queue

内存态渲染队列库（TypeScript）：处理取消、阶段执行与成品交付的交错。
状态只在内存中，不考虑重启恢复；输入为已存在且不变的本地文件。

## 使用

```ts
import { createRenderQueue } from "render-queue";

const queue = createRenderQueue({
  runStage: async (jobId, stage, inputPath, workDir, signal, onProgress) => {
    // 调用方注入的本地异步渲染计算；返回 workDir 中的产物路径
    onProgress(0.5);
    return producedPath;
  },
  outputDir: "/path/to/finals", // 可选，成品发布目录
});

const id = queue.submit("/path/to/input.mov", "high");
queue.reprioritize(id, "low"); // 仅 queued 状态有效
queue.cancel(id);              // 非终态可取消，立即生效，不等待执行器
const snap = queue.snapshot(id); // { status, stage, progress, outputPath, error }
```

## 语义

- 作业状态机：`queued → running → completed | failed | cancelled`，终态不可逆。
- 阶段顺序固定：`compositing → encoding → applyingEffects`。
- 固定 10 个物理槽位（可用 `slots` 覆盖）：高优先级先启动，同级按提交顺序；
  槽位从作业启动占用到执行与收尾 I/O 结束，`cancelled` 可见不代表槽位已归还。
- `cancel` 立即生效且不等待执行器：迟到结果、错误、进度均不得改写终态；
  旧阶段的迟到进度不污染新阶段。
- 最终发布未结束时仍可取消；只有成品落盘可读且 `completed` 先可见后，`cancel` 才失败。
- 取消/失败的作业在 executor 停止后自动清理工作目录与迟到落盘的成品；原始输入绝不删除。
- 全部文件操作为异步；无跨阶段或跨文件 I/O 的全队列锁。

## 开发

```sh
npm install
npm test   # tsc 构建 + node --test
```

测试通过可控暂停点（deferred 门闩 + `beforePublish`/`afterCleanup` 钩子）组织交错，
不依赖 sleep；执行器在临时目录真实创建文件。
