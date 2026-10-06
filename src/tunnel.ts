import { Controller } from "./controller.js";
import { Endpoint } from "./endpoint.js";
import type { InspectResult } from "./types.js";

/**
 * 门面：按调用方传入的存储目录装配控制器。
 * A/B 端点各自持有独立的本地持久化状态文件，
 * 控制器通过本机函数调用向端点下发命令，不建立真实 VPN。
 */
export class KeyRotationService {
  readonly controller: Controller;
  private readonly storageDir: string;

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    this.controller = new Controller(storageDir);
  }

  /** 初始化隧道：双方共同使用一代 32 字节密码学安全随机密钥。 */
  createTunnel(id: string): void {
    this.controller.createTunnel(id);
  }

  /** 推动一轮换钥：每个新 requestId 最多产生一代密钥。 */
  rotate(id: string, requestId: string): void {
    this.controller.rotate(id, requestId);
  }

  /** 检查双向可通信性（按实际密钥字节判断）。 */
  inspect(id: string): InspectResult {
    return this.controller.inspect(id);
  }

  /** 访问 A 端点（其状态独立持久化于存储目录）。 */
  endpointA(id: string): Endpoint {
    return new Endpoint(this.storageDir, id, "A");
  }

  /** 访问 B 端点。 */
  endpointB(id: string): Endpoint {
    return new Endpoint(this.storageDir, id, "B");
  }
}
