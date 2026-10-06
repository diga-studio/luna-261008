import type { DatabaseSync } from 'node:sqlite';

/** 录入一个传输接口。重复录入同一 id 为幂等操作。 */
export function addInterface(db: DatabaseSync, interfaceId: string): void {
  db.prepare('INSERT OR IGNORE INTO interfaces (id) VALUES (?)').run(interfaceId);
}

/**
 * 录入一条无方向隧道：连接 siteA 与 siteB，
 * 两端分别绑定接口 ifaceA（属 siteA 侧）与 ifaceB（属 siteB 侧）。
 * 运行期间拓扑不变；重复录入同一隧道 id 为幂等操作。
 */
export function addTunnel(
  db: DatabaseSync,
  tunnelId: string,
  siteA: string,
  siteB: string,
  ifaceA: string,
  ifaceB: string,
): void {
  addInterface(db, ifaceA);
  addInterface(db, ifaceB);
  db.prepare(
    'INSERT OR IGNORE INTO tunnels (id, site_a, site_b, iface_a, iface_b) VALUES (?, ?, ?, ?, ?)',
  ).run(tunnelId, siteA, siteB, ifaceA, ifaceB);
}
