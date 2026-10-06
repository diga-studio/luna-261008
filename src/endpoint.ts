import { JsonStore } from "./storage";
import type {
  CommandReceipt,
  EndpointCommand,
  EndpointId,
  EndpointState,
} from "./types";

/**
 * 隧道端点：持有独立的本地持久化状态，执行控制器下发的命令。
 * 每条命令携带全局唯一的 commandId，已应用过的命令重放时直接忽略，
 * 因此旧命令重放不会让发送密钥回退，也不会让已淘汰密钥重新可用。
 */
export class Endpoint {
  private readonly store: JsonStore;
  private readonly storageKey: string;
  private state: EndpointState;

  constructor(storageDir: string, tunnelId: string, endpointId: EndpointId) {
    this.store = new JsonStore(storageDir);
    this.storageKey = `tunnel-${tunnelId}-endpoint-${endpointId}`;
    const loaded = this.store.read<EndpointState>(this.storageKey);
    if (!loaded) {
      throw new Error(
        `endpoint ${endpointId} of tunnel ${tunnelId} is not initialized`,
      );
    }
    this.state = loaded;
  }

  /** 初始化端点本地状态（仅隧道创建时调用一次）。 */
  static initialize(
    storageDir: string,
    tunnelId: string,
    endpointId: EndpointId,
    initialKey: string,
  ): void {
    const store = new JsonStore(storageDir);
    const storageKey = `tunnel-${tunnelId}-endpoint-${endpointId}`;
    if (store.has(storageKey)) {
      throw new Error(
        `endpoint ${endpointId} of tunnel ${tunnelId} already initialized`,
      );
    }
    store.write<EndpointState>(storageKey, {
      endpointId,
      sendKey: initialKey,
      receiveKeys: [initialKey],
      appliedCommands: [],
    });
  }

  static exists(storageDir: string, tunnelId: string, endpointId: EndpointId): boolean {
    return new JsonStore(storageDir).has(`tunnel-${tunnelId}-endpoint-${endpointId}`);
  }

  /** 当前本地状态的只读快照。 */
  snapshot(): EndpointState {
    return {
      endpointId: this.state.endpointId,
      sendKey: this.state.sendKey,
      receiveKeys: [...this.state.receiveKeys],
      appliedCommands: [...this.state.appliedCommands],
    };
  }

  private persist(): void {
    this.store.write(this.storageKey, this.state);
  }

  /** 执行一条命令并返回回执；重放命令为幂等空操作。 */
  execute(command: EndpointCommand): CommandReceipt {
    if (this.state.appliedCommands.includes(command.commandId)) {
      return { commandId: command.commandId, applied: false };
    }
    let applied = false;
    switch (command.kind) {
      case "installReceiveKey":
        if (!this.state.receiveKeys.includes(command.key)) {
          this.state.receiveKeys.push(command.key);
        }
        applied = true;
        break;
      case "switchSendKey":
        // 只接受本地已安装的接收密钥作为发送密钥，避免切到来路不明的密钥。
        if (this.state.receiveKeys.includes(command.key)) {
          this.state.sendKey = command.key;
          applied = true;
        }
        break;
      case "removeReceiveKey":
        // 当前发送密钥不可移除，保证本端发送始终可被对端验证链路。
        if (command.key !== this.state.sendKey) {
          this.state.receiveKeys = this.state.receiveKeys.filter(
            (k) => k !== command.key,
          );
          applied = true;
        }
        break;
    }
    if (applied) {
      this.state.appliedCommands.push(command.commandId);
      this.persist();
    }
    return { commandId: command.commandId, applied };
  }
}
