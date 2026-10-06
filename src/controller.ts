import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Endpoint } from "./endpoint.js";
import { JsonFileStore } from "./store.js";
import type { InspectResult, KeyMaterial, TunnelState } from "./types.js";

const KEY_BYTES = 32;

/**
 * 控制器：驱动 createTunnel / rotate / inspect。
 * 每个隧道的状态持久化在 <storageDir>/controller-<id>.json。
 * 轮换按固定顺序下发命令，保证任意持久化中间状态下：
 * A 的发送密钥被 B 接受，B 的发送密钥被 A 接受。
 */
export class Controller {
  private readonly storageDir: string;

  constructor(storageDir: string) {
    this.storageDir = storageDir;
  }

  endpointA(tunnelId: string): Endpoint {
    return new Endpoint(this.storageDir, tunnelId, "A");
  }

  endpointB(tunnelId: string): Endpoint {
    return new Endpoint(this.storageDir, tunnelId, "B");
  }

  createTunnel(id: string): void {
    const store = this.tunnelStore(id);
    if (store.exists()) {
      throw new Error(`tunnel ${id} already exists`);
    }
    const key: KeyMaterial = {
      generation: 1,
      key: randomBytes(KEY_BYTES).toString("base64"),
    };
    const a = this.endpointA(id);
    const b = this.endpointB(id);
    // 先装接收，再切发送：任何中间状态双方发送密钥都被对方接受。
    a.installRecvKey(this.cmd(id, "init", "install", "A"), key);
    b.installRecvKey(this.cmd(id, "init", "install", "B"), key);
    a.switchSendKey(this.cmd(id, "init", "switch", "A"), key);
    b.switchSendKey(this.cmd(id, "init", "switch", "B"), key);
    store.save({
      id,
      generation: 1,
      key: key.key,
      requests: {},
      keys: { "1": key.key },
      pending: null,
    });
  }

  rotate(id: string, requestId: string): void {
    const store = this.tunnelStore(id);
    const state = store.load();

    if (state.requests[requestId] !== undefined && state.pending === null) {
      return; // 该 requestId 已完成：复用同一代同一材料，不再应用任何命令
    }
    if (state.pending !== null && state.pending.requestId !== requestId) {
      throw new Error(
        `tunnel ${id} has a pending rotation ${state.pending.requestId}; ` +
          `submit new requestId only after it completes`,
      );
    }

    if (state.pending === null) {
      const generation = state.generation + 1;
      state.keys[String(generation)] = randomBytes(KEY_BYTES).toString("base64");
      state.requests[requestId] = generation;
      state.pending = { requestId, generation };
      store.save(state);
    }

    const generation = state.pending!.generation;
    const oldGeneration = state.generation;
    const key: KeyMaterial = {
      generation,
      key: state.keys[String(generation)],
    };
    const a = this.endpointA(id);
    const b = this.endpointB(id);

    // 顺序保证不变量：装接收（双端）→ 切发送（双端）→ 移除旧接收（双端）。
    // 所有命令幂等，崩溃后重入或整体重放均安全。
    a.installRecvKey(this.cmd(id, requestId, "install", "A"), key);
    b.installRecvKey(this.cmd(id, requestId, "install", "B"), key);
    a.switchSendKey(this.cmd(id, requestId, "switch", "A"), key);
    b.switchSendKey(this.cmd(id, requestId, "switch", "B"), key);
    a.removeRecvKey(this.cmd(id, requestId, "remove", "A"), oldGeneration);
    b.removeRecvKey(this.cmd(id, requestId, "remove", "B"), oldGeneration);

    state.generation = generation;
    state.key = key.key;
    state.pending = null;
    store.save(state);
  }

  inspect(id: string): InspectResult {
    const a = this.endpointA(id);
    const b = this.endpointB(id);
    const aSend = a.currentSendKey();
    const bSend = b.currentSendKey();
    const aToB = aSend !== null && b.accepts(aSend);
    const bToA = bSend !== null && a.accepts(bSend);
    return { aToB, bToA, ok: aToB && bToA };
  }

  /** 当前隧道状态（测试/调试用）。 */
  tunnelState(id: string): TunnelState {
    return this.tunnelStore(id).load();
  }

  private cmd(
    tunnelId: string,
    requestId: string,
    step: string,
    endpoint: string,
  ): string {
    return `${tunnelId}:${requestId}:${step}:${endpoint}`;
  }

  private tunnelStore(id: string): JsonFileStore<TunnelState> {
    return new JsonFileStore<TunnelState>(
      path.join(this.storageDir, `controller-${id}.json`),
      () => {
        throw new Error(`tunnel ${id} does not exist`);
      },
    );
  }
}
