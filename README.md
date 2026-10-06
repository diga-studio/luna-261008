# PipeForge 单仓库版本保留组件

TypeScript 实现的 PipeForge 单仓库（generic）版本保留组件。每个版本只含一个文件，
二进制内容存入本地目录，元数据保存在内存中。版本字符串按 SemVer 2.0.0 解析。

## 运行

```sh
npm install
npm test
```

只依赖 Node.js（>= 18）与 `devDependencies` 中的 `typescript`、`@types/node`。

## API

```ts
import { Repository } from './src/repository';

const repo = new Repository({ dir: '/data/repo', retainCount: 25, hooks });

const handle = await repo.put('1.4.0', asyncByteSource); // 初始阶段 dev
repo.promote(handle, 'staging');                          // dev -> staging
repo.promote(handle, 'production');                       // staging -> production
const download = await repo.open(handle);                 // AsyncIterable<Uint8Array> + close()
const retired = await repo.collect();                     // 返回本次逻辑淘汰的句柄
await repo.whenIdle();                                    // 测试辅助：等待物理删除完成
```

- `put(version, source)`：流式写入临时文件，完整落盘并改名后才发布；同一版本字符串
  任意时刻最多一份可见内容，重复上传报错，绝不覆盖。
- `promote(handle, target)`：仅允许 `dev -> staging -> production` 逐级晋级；
  已淘汰或已被重传取代的句柄抛错。
- `open(handle)`：成功返回后，该流保证读到本次上传的完整原始字节，
  与后续回收无关；提前 `close()` 或读完后立即释放读引用。
- `collect()`：保留 SemVer 优先级最高的 25 个非 production 版本（预发布标识参与比较，
  构建元数据忽略，优先级相同则较晚发布者优先）；production 版本永久豁免且不占名额。
  返回本次逻辑淘汰的句柄。候选选中后、淘汰前会重新校验资格，
  期间完成的晋级（候选自身或更新版本晋级）都会使旧候选免于淘汰。

## 并发与资源模型

- 元数据的检查-修改在同步代码段内完成（JS 单线程天然原子），不持有任何覆盖
  文件 I/O 的锁；某个文件操作暂停时，其余上传、晋级、下载、清理均可完成。
- 上传逐块写入（输入分块 ≤ 1 MiB），下载每次读 1 MiB，单个上传/下载自身缓存
  不超过 4 MiB；500 MiB 文件不会整体进入内存，下载不复制文件。
- 逻辑淘汰是同步元数据变更，立即允许同版本号重传；新旧句柄按 `version#uploadId`
  区分，旧句柄与旧回收动作无法触碰新内容（每次上传使用独立 blob 文件）。
- 物理删除按读引用计数延迟：最后一个下载结束或关闭后自动释放，无需再次 Collect；
  `Collect` 不等待进行中的下载。

## 测试钩子

`RepositoryOptions.hooks` 提供确定性交错控制点（均可 async，测试用手动闸门暂停，
不依赖 sleep 或随机时序）：

- `afterCollectCandidates(candidates)`：Collect 选出超额候选后、任何淘汰之前。
- `beforeRetire(candidate)`：逐个淘汰前的资格重校验点。
- `beforePhysicalDelete(info)` / `afterPhysicalDelete(info)`：物理删除前后。

## 测试

`test/` 下共 19 个用例，覆盖：SemVer 解析与优先级（含非字符串排序证据）、
基本生命周期、重复上传拒绝、失败上传清理、保留排序（27 版本 / production 豁免 /
构建元数据平局 / 预发布参与 / 单次 Collect 清全部超额）、大文件分块流式、
同版本并发上传唯一胜出，以及规格要求的三个交错场景：

1. 27 个非 production 版本，Collect 暂停在选出两个最低候选后；将最低候选与一个
   保留中的较新版本晋级 production，继续清理后两个旧候选均不被淘汰。
2. 暂停旧版本的物理删除，重传同版本号并读到新内容；恢复删除后新内容完整，
   旧句柄不能打开或晋级。
3. Open 成功后未读第一块时 Collect 淘汰该版本并返回；继续下载逐字节匹配原内容，
   完整消费与提前关闭两种情况下旧文件都最终释放。
