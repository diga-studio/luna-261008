import { randomBytes } from "crypto";
import { Endpoint } from "./endpoint";
import { JsonStore } from "./storage";
import type { EndpointId, RotationRecord, TunnelState } from "./types";

const ENDPOINTS: EndpointId[] = ["A", "B"];

function newKey(): string {
  return randomBytes(32).toString("hex");
}

function sameKeyBytes(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.equals(bb);
}

/**
 * 控制器：编排双端密钥轮换。
 * 自身与两个端点各自持久化独立状态；轮换按阶段落盘，
 * 崩溃后可从中间状态幂等恢复，且任意中间状态都保持双向可通信。
 */
export class Controller {
  private readonly store: JsonStore;

  constructor(private readonly storageDir: string) {
    this.store = new JsonStore(storageDir);
  }

  private stateKey(tunnelId: string): string {
    return `tunnel-${tunnelId}-controller`;
  }

  private loadState(tunnelId: string): TunnelState {
    const state = this.store.read<TunnelState>(this.stateKey(tunnelId));
    if (!state) throw new Error(`tunnel ${tunnelId} does not exist`);
    return state;
  }

  private saveState(state: TunnelState): void {
    this.store.write(this.stateKey(state.tunnelId), state);
  }

  private endpoint(tunnelId: string, endpointId: EndpointId): Endpoint {
    return new Endpoint(this.storageDir, tunnelId, endpointId);
  }

  /** 初始化一条隧道：双方共同使用一代 32 字节密码学安全随机密钥。 */
  createTunnel(id: string): void {
    if (this.store.has(this.stateKey(id))) {
      throw new Error(`tunnel ${id} already exists`);
    }
    const key = newKey();
    for (const ep of ENDPOINTS) {
      Endpoint.initialize(this.storageDir, id, ep, key);
    }
    this.saveState({ tunnelId: id, generation: 1, rotations: [] });
  }

  /**
   * 推动一轮换钥。同一 requestId 复用同一份密钥材料；
   * 已完成的 requestId 重放时不重新应用。
   */
  rotate(id: string, requestId: string): void {
    const state = this.loadState(id);
    let record = state.rotations.find((r) => r.requestId === requestId);
    if (record && record.stage === "completed") {
      return; // 重放已完成的轮换：空操作
    }
    if (!record) {
      const pending = state.rotations.find((r) => r.stage !== "completed");
      if (pending) {
        throw new Error(
          `tunnel ${id} has an unfinished rotation ${pending.requestId}`,
        );
      }
      record = { requestId, key: newKey(), stage: "created" };
      state.rotations.push(record);
      this.saveState(state);
    }
    const key = record.key;

    // 阶段 1：双端安装新接收密钥。
    if (record.stage === "created") {
      for (const ep of ENDPOINTS) {
        this.endpoint(id, ep).execute({
          kind: "installReceiveKey",
          commandId: `${requestId}:install:${ep}`,
          key,
        });
      }
      record.stage = "installed";
      this.saveState(state);
    }

    // 阶段 2：A 切换发送密钥（B 已接受新密钥，链路不断）。
    if (record.stage === "installed") {
      this.endpoint(id, "A").execute({
        kind: "switchSendKey",
        commandId: `${requestId}:switch:A`,
        key,
      });
      record.stage = "switchedA";
      this.saveState(state);
    }

    // 阶段 3：B 切换发送密钥（A 已接受新密钥）。
    if (record.stage === "switchedA") {
      this.endpoint(id, "B").execute({
        kind: "switchSendKey",
        commandId: `${requestId}:switch:B`,
        key,
      });
      record.stage = "switched";
      this.saveState(state);
    }

    // 阶段 4：双端移除旧接收密钥，只保留新密钥。
    if (record.stage === "switched") {
      for (const ep of ENDPOINTS) {
        const endpoint = this.endpoint(id, ep);
        for (const old of endpoint.snapshot().receiveKeys) {
          if (!sameKeyBytes(old, key)) {
            endpoint.execute({
              kind: "removeReceiveKey",
              commandId: `${requestId}:remove:${ep}:${old}`,
              key: old,
            });
          }
        }
      }
      record.stage = "completed";
      state.generation += 1;
      this.saveState(state);
    }
  }

  /** 检查双向可通信性：按实际密钥字节判断双方互相接受对方的发送密钥。 */
  inspect(id: string): boolean {
    this.loadState(id);
    const a = this.endpoint(id, "A").snapshot();
    const b = this.endpoint(id, "B").snapshot();
    const accepts = (
      receiver: { receiveKeys: string[] },
      sendKey: string,
    ): boolean => receiver.receiveKeys.some((k) => sameKeyBytes(k, sendKey));
    return accepts(b, a.sendKey) && accepts(a, b.sendKey);
  }
}
