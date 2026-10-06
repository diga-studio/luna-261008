# cert-revocation-publisher

供 VPN 管理系统调用的证书吊销发布库（TypeScript）。数据持久化在调用方给定的本地工作目录中，网关直接读取该目录下对外发布的 `crl.pem`。

## 运行要求

- Node.js >= 22.18（测试直接利用 Node 内置的 TypeScript 类型擦除运行）
- 仅本地文件持久化，无数据库 / 缓存 / 消息队列等外部服务

```sh
npm install
npm test        # 运行自动化测试
npm run build   # TypeScript 类型检查
```

## API

```ts
import { RevocationService } from "cert-revocation-publisher";

const service = await RevocationService.open({
  workDir: "/path/to/workdir",   // 本地工作目录（自动创建）
  caCertificatePem,              // 固定 RSA CA 证书（PEM）
  caPrivateKeyPem,               // CA 签名私钥（PKCS#8 PEM）
});

// 登记已签发的客户端证书（签发由上游完成，本库不签发）
await service.registerCertificate({ serialNumber: "0A1B2C", department: "eng" });

// 按部门整批吊销：覆盖本次调用前已登记的该部门全部证书
const { newlyRevoked, crlNumber } = await service.revokeDepartment("eng");

// 获取当前 CRL（PEM 字符串，与对外发布的 crl.pem 内容一致）
const crlPem = await service.getCurrentCrl();
```

## 行为约定

- 证书按序列号唯一识别（十六进制字符串，支持 `0x` 前缀、大小写不敏感），所属部门不可变；重复登记同一序列号是空操作，不改变已有吊销状态。
- 首次 `open` 初始化成功时，发布编号为 0 的空 CRL。
- 每次产生新增吊销项的 `revokeDepartment` 使 CRLNumber 加 1 并原子化重写 `crl.pem`；没有新增项时文件内容与编号均不变（幂等重试安全）。
- 吊销操作返回成功时，`crl.pem` 已包含整批证书；`getCurrentCrl()` 与对外文件一致。
- 已吊销证书不可恢复；吊销后新登记到该部门的证书不会被自动吊销，需要再次调用 `revokeDepartment`。
- 发布的 `crl.pem` 是标准的 PEM 编码 X.509v2 CRL（sha256WithRSAEncryption），包含全部已吊销证书序列号与 CRLNumber 扩展，可被 OpenSSL 等工具独立解析与验签。

## 工作目录内容

- `crl.pem` — 对外发布的 CRL，供网关直接读取。
- `state.json` — 内部登记与吊销状态（原子写入）；请勿手工修改。
