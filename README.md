# guest-message-delivery

用 TypeScript + SQLite 实现的会话消息投递库，只处理「访客向固定坐席发送文本」这一条方向。
会话标识与接收方身份由调用方提供，库不做账号和路由。

## 要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无原生编译依赖）
- `npm install` 后 `npm test` 即可运行全部测试

## API

```ts
import { DeliveryLibrary } from "guest-message-delivery";

const lib = new DeliveryLibrary("data.db", async (conversationId, seq, messageId, text) => {
  // 调用方注入的投递函数；完成不代表接收方确认
  await sendToAgent(conversationId, seq, messageId, text);
});

const seq = lib.enqueue("conv-1", "msg-1", "你好"); // 持久化并返回会话内从 1 递增的 seq
lib.setOnline("conv-1", true);                      // 接收方上线
lib.pump(Date.now());                               // 触发当前到期的投递（now 非递减，不依赖真实定时器）
lib.acknowledge("conv-1", seq);                     // 确认单条消息（非累计）
lib.close();
```

## 语义

- `enqueue`：同一会话重复提交相同 `messageId` + 文本返回原 `seq`；相同 `messageId` 换文本抛错。
- `setOnline`：初始离线；重复设置相同状态无副作用；每次真正离线→在线，所有未确认消息获得新额度。
- `acknowledge`：确认指定单条消息；重复 ACK 与迟到 ACK 无害；只有 ACK 能确认，deliver 完成不算。
- `pump(now)`：每段连续在线期间，每条未确认消息允许首次投递 + 最多 3 次重试，
  重试距上次发起至少 5000ms，失败（含同步抛错）也占额度；额度耗尽后保留消息，不再主动重试。
- 任何已接受未确认的消息不会因失败、重试耗尽或连接切换而丢失；重连后从下一次 `pump` 起补发。
- 同会话首次投递按 `seq` 递增发起，重传沿用原 `seq`；未确认的旧消息不阻塞新消息首次投递。
- SQLite 事务不跨越 `deliver` 调用；`deliver` 同步重入 `acknowledge`/`setOnline`/`enqueue`/`pump` 均安全。
- 正常关闭重开后消息、`seq`、确认结果保持，新实例从离线开始。

## 开发

```sh
npm run build   # tsc
npm test        # 编译并运行 node:test 测试
```
