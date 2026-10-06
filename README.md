# component-checkout-store

单进程内存中的组件签出与原子保存库（TypeScript）。

## API

- `checkout(actor, id)`：签出组件凭证；可签出尚不存在的 ID 用于创建。被其他 actor 持有效锁时失败；同一持有人再次签出相当于续期。
- `save(actor, edits, leases)`：原子执行一批创建 / 依赖替换 / 删除。调用方必须持有所有被修改 ID 的有效凭证；按整批最终结果校验悬空引用与有向环，失败不留残余、不续期。
- `read()`：返回已提交图的隔离深拷贝。

锁在最后一次成功签出或保存后 10 分钟到期；删除组件会使其旧凭证失效，重建后不得恢复。时钟可注入（`SystemClock` / `ManualClock`）。

## 构建与测试

```sh
npm install
npm test
```
