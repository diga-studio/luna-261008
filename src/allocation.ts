import { DatabaseSync } from 'node:sqlite';
import { nextSeq } from './db.js';

interface HoldRow {
  hold_id: number;
  pickup_branch: string;
}

interface CopyRow {
  barcode: string;
  status: string;
  branch: string | null;
}

/**
 * 对单个题名执行一轮分配（须在调用方事务内调用）。
 *
 * 按 queue_seq 顺序处理每个未绑定预约：
 * 候选册 = 任意分馆的在架空闲册 ∪ 既定目的分馆等于领取分馆的无绑定在途册。
 * 较早预约无法使用剩余册时跳过，继续尝试后面的兼容预约。
 * 选择优先级：领取分馆在架 > 运往领取分馆的在途 > 其他分馆在架；同级按条码字典序。
 */
export function allocateTitle(db: DatabaseSync, title: string): void {
  const holds = db
    .prepare(
      `SELECT hold_id, pickup_branch FROM holds
       WHERE title = ? AND status = 'pending'
       ORDER BY queue_seq ASC`,
    )
    .all(title) as unknown as HoldRow[];
  if (holds.length === 0) return;

  // 一次性取出该题名的全部空闲册，内存中匹配，避免逐预约查询
  const freeCopies = db
    .prepare(
      `SELECT barcode, status, branch FROM copies
       WHERE title = ? AND hold_id IS NULL AND status IN ('on_shelf', 'in_transit')
       ORDER BY barcode ASC`,
    )
    .all(title) as unknown as CopyRow[];
  if (freeCopies.length === 0) return;

  const onShelf: CopyRow[] = [];
  const inTransitByBranch = new Map<string, CopyRow[]>();
  for (const copy of freeCopies) {
    if (copy.status === 'on_shelf') {
      onShelf.push(copy);
    } else {
      const list = inTransitByBranch.get(copy.branch as string) ?? [];
      list.push(copy);
      inTransitByBranch.set(copy.branch as string, list);
    }
  }

  const bindHold = db.prepare(`UPDATE holds SET status = ?, barcode = ? WHERE hold_id = ?`);
  const insertTransfer = db.prepare(
    `INSERT INTO transfers (credential, barcode, dest_branch, hold_id, status)
     VALUES (?, ?, ?, ?, 'open')`,
  );

  // 本轮内已被绑走的册
  const taken = new Set<string>();

  for (const hold of holds) {
    const inbound = inTransitByBranch.get(hold.pickup_branch) ?? [];
    let best: CopyRow | null = null;
    let bestRank = Infinity;
    for (const copy of onShelf) {
      if (taken.has(copy.barcode)) continue;
      const rank = copy.branch === hold.pickup_branch ? 0 : 2;
      // 列表已按条码升序，同级先见者即字典序最小
      if (rank < bestRank) {
        best = copy;
        bestRank = rank;
        if (rank === 0) break;
      }
    }
    if (bestRank > 1) {
      for (const copy of inbound) {
        if (taken.has(copy.barcode)) continue;
        best = copy;
        bestRank = 1;
        break;
      }
    }
    if (!best) continue; // 该预约无法用剩余册，跳过后续兼容预约可继续

    const chosen = best;
    taken.add(chosen.barcode);

    if (chosen.status === 'on_shelf' && chosen.branch === hold.pickup_branch) {
      // 领取分馆在架：直接可领取
      db.prepare(`UPDATE copies SET hold_id = ? WHERE barcode = ?`).run(hold.hold_id, chosen.barcode);
      bindHold.run('ready', chosen.barcode, hold.hold_id);
    } else if (chosen.status === 'in_transit') {
      // 已在运往领取分馆途中：绑定，目的分馆与调拨凭据不变
      db.prepare(`UPDATE copies SET hold_id = ? WHERE barcode = ?`).run(hold.hold_id, chosen.barcode);
      bindHold.run('bound', chosen.barcode, hold.hold_id);
      db.prepare(`UPDATE transfers SET hold_id = ? WHERE barcode = ? AND status = 'open'`).run(
        hold.hold_id,
        chosen.barcode,
      );
    } else {
      // 其他分馆在架：产生调拨，目的分馆固定为领取分馆
      const credential = `T-${nextSeq(db, 'transfer')}`;
      db.prepare(
        `UPDATE copies SET hold_id = ?, status = 'in_transit', branch = ?, transfer_credential = ?
         WHERE barcode = ?`,
      ).run(hold.hold_id, hold.pickup_branch, credential, chosen.barcode);
      bindHold.run('bound', chosen.barcode, hold.hold_id);
      insertTransfer.run(credential, chosen.barcode, hold.pickup_branch, hold.hold_id);
    }
  }
}
