# crl-publisher

供 VPN 管理系统调用的证书吊销发布库（TypeScript，零运行时依赖）。
数据持久化在调用方指定的本地工作目录中，网关直接读取该目录下对外发布的
`crl.pem`（PEM 格式 X.509v2 CRL，由调用方提供的 RSA CA 签名，含 CRLNumber 扩展）。

## 使用

```ts
import { RevocationService } from "crl-publisher";

const service = new RevocationService({
  workDir: "/var/lib/vpn/crl",   // 工作目录，状态与对外 CRL 都在此
  caCertPem,                     // 固定 RSA CA 证书（PEM）
  caKeyPem,                      // CA 签名私钥（PEM）
});

// 登记已签发的客户端证书（序列号 + 部门，幂等）
service.registerCertificate("4c7a91f2", "engineering");

// 按部门整批吊销：覆盖调用开始前已登记的该部门全部证书
const result = service.revokeDepartment("engineering");
// result.crlNumber 递增；无新增吊销项时 result.published === false 且文件不变

// 获取当前 CRL（与对外文件内容一致）
const pem = service.getCurrentCrl();
```

行为约定：

- 首次初始化发布编号为 0 的空 CRL；每次产生新增吊销项编号加 1。
- 重复登记同一序列号不增加记录，也不改变已有吊销状态。
- 吊销后新登记到该部门的证书不自动吊销，需再次调用 `revokeDepartment`。
- 已吊销证书不可恢复。

工作目录内容：

- `crl.pem` — 对外发布的 CRL（网关读取）
- `state.json` — 内部状态（证书登记与吊销记录、当前 CRL 编号）

## 构建与测试

```sh
npm install
npm test
```
