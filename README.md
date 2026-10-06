# ntfs-deleted-recovery

NTFS 删除文件恢复库（TypeScript），供上层取证工具直接调用。
输入为本地 raw/dd 镜像与卷分配位图文件，恢复内容写入本地新文件。

## 前提与固定参数

- 调用方提供可信的卷起始偏移、卷长度、目标 `$MFT` 记录的镜像偏移，
  以及覆盖整个卷的分配位图文件。
- 固定扇区 512 字节、簇 4096 字节、记录 1024 字节。
- 输入视为稳定的只读副本；本库不做分区扫描或路径重建。
- 支持最大 2 TiB 镜像与最大 500 MiB 逻辑文件；
  单次读取/恢复操作的额外工作内存不超过 64 MiB（内部流式块为 4 MiB）。

## 使用

```ts
import { Volume } from "ntfs-deleted-recovery";

const volume = await Volume.open({
  imagePath: "disk.dd",
  volumeOffset: 5 * 2 ** 30,   // 卷在镜像中的起始字节偏移
  volumeLength: 2 ** 40,       // 卷字节长度
  bitmapPath: "bitmap.bin",    // 覆盖整个卷的分配位图
});

// 1. 记录检查：解析记录结构，返回可恢复候选描述。
const candidate = await volume.inspectRecord(recordOffset);

// 2. 逻辑区间读取：返回请求区间与文件逻辑范围的交集。
const slice = await volume.readRange(recordOffset, 0, 64 * 1024);

// 3. 完整恢复：写入本地新文件。
await volume.recover(recordOffset, "recovered.bin");

await volume.close();
```

## 支持范围

- 未命名 `$DATA` 属性的驻留与非驻留形式，含碎片化与稀疏文件。
- 运行段物理簇位移按带符号相对值解释（可正可负）；
  稀疏段没有物理簇，且不改变后续段的相对位移基准。
- 命名数据流、压缩、加密、依赖扩展记录（起始 VCN 非 0 或
  base reference 非零）的文件明确不支持，抛出 `UnsupportedError`。

## 忠实性保证

- 按 NTFS 扇区尾保护信息（USA fixup）解释记录；保护值不匹配、记录截断、
  属性越界、运行段声明范围不完整、物理引用越过卷边界，均视为损坏，
  抛出 `CorruptRecordError`，不返回候选也不生成恢复文件。
- 非驻留逻辑长度以属性声明为准，簇尾填充不输出；
  稀疏区域与超出已初始化长度的尾部返回零。
- 区间读取只读取请求范围内的物理字节，
  跨运行段读取与完整恢复的对应字节一致。
- 仅当记录标为未使用、且数据属性引用的全部物理簇均在位图中标为空闲时，
  才允许读取或恢复，否则抛出 `NotRecoverableError` 且不留下输出文件。
  位图空闲只表示当前可提取，不代表内容从未被覆盖。

## 错误类型

- `CorruptRecordError`：记录结构损坏或物理引用越界。
- `UnsupportedError`：文件形式明确不支持（压缩、加密、扩展记录、命名流）。
- `NotRecoverableError`：记录仍被使用，或引用簇已被占用。

## 构建与测试

```sh
npm install
npm test
```

测试自动构造合成 NTFS 镜像与位图，覆盖：含正负簇位移、稀疏段与
未初始化尾部的碎片文件逐字节恢复与跨段区间读取；驻留内容穿过扇区尾
保护位置的合法记录与保护值错误、末段截断的损坏记录；仅最后一个引用簇
被占用时的拒绝恢复；以及 4 GiB 之后高偏移、500 MiB 逻辑文件下的
内容正确性与内存上界。
