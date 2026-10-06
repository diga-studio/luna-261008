# task26100862 — NetFabric 风格双端密钥轮换库（TypeScript）

控制器与 A、B 端点各自持有独立的本地持久化状态（JSON 文件，原子写入），
端点通过本机函数调用执行命令，不建立真实 VPN。存储目录由调用方传入。

## 使用

```ts
import { KeyRotationService } from "./src/tunnel.js";

const svc = new KeyRotationService("/path/to/storage");
svc.createTunnel("tunnel-1");          // 初始化一代 32 字节随机密钥
svc.rotate("tunnel-1", "request-1");   // 推动一轮换钥（按 requestId 幂等）
svc.inspect("tunnel-1");               // { aToB, bToA, ok } 按密钥字节判断
```

## 设计

- `src/controller.ts`：轮换编排。顺序为 双端装接收 → 双端切发送 → 双端移除旧接收，
  保证任意持久化中间状态下 A 的发送密钥被 B 接受、B 的发送密钥被 A 接受。
  每个 requestId 最多产生一代密钥；已完成的 requestId 重放直接返回，不再应用。
- `src/endpoint.ts`：端点状态机。一把发送密钥 + 可接收密钥集合。
  所有命令按 commandId 幂等去重；旧代密钥不得重新安装，发送密钥绝不回退。
- `src/store.ts`：JSON 文件持久化（临时文件 + 原子重命名）。
- `src/node-shims.d.ts`：最小 Node 类型声明，不依赖 @types/node。

## 构建与测试

干净机器上只需 Node.js：

```sh
npm install
npm test
```
