import * as path from "node:path";
import { JsonFileStore } from "./store.js";
import type { EndpointRole, EndpointState, KeyMaterial, Receipt } from "./types.js";

/**
 * 隧道端点：持有一把发送密钥与一组可接收密钥。
 * 状态持久化在 <storageDir>/endpoint-<tunnelId>-<role>.json。
 * 所有命令幂等：相同 commandId 重放直接返回已记录的回执，不重复应用。
 */
export class Endpoint {
  private readonly role: EndpointRole;
  private readonly store: JsonFileStore<EndpointState>;

  constructor(storageDir: string, tunnelId: string, role: EndpointRole) {
    this.role = role;
    const file = path.join(storageDir, `endpoint-${tunnelId}-${role}.json`);
    this.store = new JsonFileStore<EndpointState>(file, () => ({
      role,
      sendKey: null,
      recvKeys: {},
      executedCommands: {},
      maxGenerationSeen: 0,
    }));
  }

  /** 安装一把接收密钥。旧代（<= 当前发送代）密钥拒绝重新进入。 */
  installRecvKey(commandId: string, key: KeyMaterial): Receipt {
    return this.execute(commandId, (state) => {
      const currentGen = state.sendKey ? state.sendKey.generation : 0;
      if (key.generation <= currentGen && state.recvKeys[String(key.generation)] !== undefined) {
        return false; // 已存在，无需变更
      }
      if (key.generation < currentGen) {
        return false; // 已淘汰的旧代密钥不得重新可用
      }
      if (key.generation === currentGen) {
        return false; // 当前发送代必然已在接收集合中
      }
      state.recvKeys[String(key.generation)] = key.key;
      if (key.generation > state.maxGenerationSeen) {
        state.maxGenerationSeen = key.generation;
      }
      return true;
    });
  }

  /** 切换发送密钥：只允许向更新代切换，绝不回退。 */
  switchSendKey(commandId: string, key: KeyMaterial): Receipt {
    return this.execute(commandId, (state) => {
      const currentGen = state.sendKey ? state.sendKey.generation : 0;
      if (key.generation <= currentGen) {
        return false; // 相同或更旧的代：拒绝回退
      }
      state.sendKey = { generation: key.generation, key: key.key };
      // 自己的发送密钥自己也应能接收（保持集合一致）
      state.recvKeys[String(key.generation)] = key.key;
      if (key.generation > state.maxGenerationSeen) {
        state.maxGenerationSeen = key.generation;
      }
      return true;
    });
  }

  /** 移除一把接收密钥：不得移除当前发送代。 */
  removeRecvKey(commandId: string, generation: number): Receipt {
    return this.execute(commandId, (state) => {
      if (state.sendKey && generation === state.sendKey.generation) {
        return false;
      }
      if (state.recvKeys[String(generation)] === undefined) {
        return false;
      }
      delete state.recvKeys[String(generation)];
      return true;
    });
  }

  /** 判断本端能否接收对方用 key 发送的流量（按密钥字节判断）。 */
  accepts(key: KeyMaterial): boolean {
    const state = this.store.load();
    const stored = state.recvKeys[String(key.generation)];
    return stored !== undefined && stored === key.key;
  }

  /** 当前发送密钥。 */
  currentSendKey(): KeyMaterial | null {
    const state = this.store.load();
    return state.sendKey ? { ...state.sendKey } : null;
  }

  /** 当前可接收密钥集合（代数列表，升序）。 */
  recvGenerations(): number[] {
    const state = this.store.load();
    return Object.keys(state.recvKeys)
      .map((g) => Number(g))
      .sort((a, b) => a - b);
  }

  /** 读取某代接收密钥材料（测试/调试用）。 */
  recvKey(generation: number): string | undefined {
    const state = this.store.load();
    return state.recvKeys[String(generation)];
  }

  private execute(commandId: string, apply: (state: EndpointState) => boolean): Receipt {
    const state = this.store.load();
    const existing = state.executedCommands[commandId];
    if (existing) {
      return { ...existing, replayed: true };
    }
    const applied = apply(state);
    const receipt: Receipt = {
      commandId,
      endpoint: this.role,
      applied,
      replayed: false,
    };
    state.executedCommands[commandId] = receipt;
    this.store.save(state);
    return receipt;
  }
}
