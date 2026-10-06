# netfabric-key-rotation

NetFabric 风格的双端密钥轮换库（TypeScript）。控制器与 A、B 端点各自持有独立的本地持久化状态（JSON 文件，目录由调用方传入），端点通过本机函数调用执行命令，不建立真实 VPN。

## API

- `new Controller(storageDir)`
- `createTunnel(id)`：初始化双方共用的一代 32 字节密码学安全随机密钥。
- `rotate(id, requestId)`：推动一轮换钥；同一 `requestId` 复用同一份密钥材料，完成后重放为空操作。
- `inspect(id)`：按实际密钥字节检查双向可通信性。

## 轮换协议

1. 双端安装新接收密钥 → 2. A 切换发送密钥 → 3. B 切换发送密钥 → 4. 双端移除旧接收密钥。

每个阶段落盘，任意中间状态均保持双向可通信；端点按 `commandId` 去重，旧命令重放不会回退发送密钥或复活已淘汰密钥。

## 构建与测试

```sh
npm install
npm test
```
