import { Store } from "./store";
import { DeliverFn, MAX_ATTEMPTS, RETRY_INTERVAL_MS } from "./types";

interface ConversationState {
  online: boolean;
  /** 每次真正发生上下线切换时递增，用于识别迟到的投递结果。 */
  generation: number;
}

interface InFlight {
  conversationId: string;
  seq: number;
  generation: number;
  initiatedAt: number;
}

/**
 * 会话消息投递库：只处理访客向固定坐席发送文本这一条方向。
 * 会话标识与接收方身份由调用方提供，不做账号和路由。
 *
 * 不变量：
 * - 只有 acknowledge 能确认消息；deliver 完成不代表确认。
 * - 任何已接受未确认的消息永远不会从补发集合中消失。
 * - 数据库事务绝不跨越 deliver 调用。
 */
export class DeliveryLibrary {
  private readonly store: Store;
  private readonly deliver: DeliverFn;
  private readonly conversations = new Map<string, ConversationState>();
  private readonly inFlight = new Map<string, InFlight>();

  constructor(dbPath: string, deliver: DeliverFn) {
    this.store = new Store(dbPath);
    this.deliver = deliver;
  }

  /** 持久化消息并返回会话内从 1 开始连续递增的 seq。 */
  enqueue(conversationId: string, messageId: string, text: string): number {
    return this.store.insertMessage(conversationId, messageId, text);
  }

  /** 设置接收方连接状态，初始离线；重复设置相同状态无副作用。 */
  setOnline(conversationId: string, online: boolean): void {
    const state = this.stateOf(conversationId);
    if (state.online === online) {
      return;
    }
    state.online = online;
    state.generation += 1;
    if (online) {
      // 真正从离线转为在线：所有未确认消息获得新的投递额度。
      this.store.resetQuota(conversationId);
    }
  }

  /** 确认指定单条消息（非累计）；重复 ACK 与迟到 ACK 无害。 */
  acknowledge(conversationId: string, seq: number): void {
    this.store.ack(conversationId, seq);
  }

  /** 触发当前到期的投递；now 为调用方提供的非递减毫秒时间。 */
  pump(now: number): void {
    for (const [conversationId, state] of this.conversations) {
      if (!state.online) {
        continue;
      }
      const eligible = this.store.eligibleMessages(conversationId, now, MAX_ATTEMPTS);
      for (const message of eligible) {
        // deliver 可能同步重入并切换在线状态；发起前必须重新检查。
        if (!state.online) {
          break;
        }
        // 重叠的 pump 或同步重入的 ACK 可能已使该消息不再可投递。
        if (!this.store.isEligible(conversationId, message.seq, now, MAX_ATTEMPTS)) {
          continue;
        }
        this.initiate(conversationId, state, message.seq, message.messageId, message.text, now);
      }
    }
  }

  close(): void {
    this.store.close();
  }

  private stateOf(conversationId: string): ConversationState {
    let state = this.conversations.get(conversationId);
    if (state === undefined) {
      state = { online: false, generation: 0 };
      this.conversations.set(conversationId, state);
    }
    return state;
  }

  private initiate(
    conversationId: string,
    state: ConversationState,
    seq: number,
    messageId: string,
    text: string,
    now: number
  ): void {
    // 先落库再调用 deliver：事务不跨越 deliver，且同步重入的 pump 不会重复发起。
    this.store.markAttempt(conversationId, seq);
    const key = `${conversationId}${seq}`;
    const attempt: InFlight = {
      conversationId,
      seq,
      generation: state.generation,
      initiatedAt: now,
    };
    this.inFlight.set(key, attempt);
    let result: Promise<unknown>;
    try {
      result = this.deliver(conversationId, seq, messageId, text);
    } catch {
      // deliver 同步抛错按失败处理。
      this.inFlight.delete(key);
      this.onFailure(attempt);
      return;
    }
    result.then(
      () => {
        this.inFlight.delete(key);
      },
      () => {
        this.inFlight.delete(key);
        this.onFailure(attempt);
      }
    );
  }

  private onFailure(attempt: InFlight): void {
    const state = this.conversations.get(attempt.conversationId);
    if (state === undefined || !state.online) {
      return; // 已离线：不排定重试，重连时会重置额度。
    }
    if (state.generation !== attempt.generation) {
      return; // 上一在线期间的迟到结果：不得污染本轮额度与到期时间。
    }
    if (this.store.isAcked(attempt.conversationId, attempt.seq)) {
      return; // 已确认：失败不得重新激活消息。
    }
    // 后续尝试距离上次发起至少 RETRY_INTERVAL_MS；额度耗尽则停止主动重试但保留消息。
    this.store.scheduleRetry(
      attempt.conversationId,
      attempt.seq,
      attempt.initiatedAt + RETRY_INTERVAL_MS,
      MAX_ATTEMPTS
    );
  }
}
