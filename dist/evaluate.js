import { compilePolicy } from './compile.js';
import { parseAddress } from './ip.js';
/** 判定一条具体连接：返回首个命中的规则及动作；无命中为默认 deny。 */
export function evaluateConnection(rules, conn) {
    const needsPort = conn.protocol === 'TCP' || conn.protocol === 'UDP';
    if (needsPort) {
        if (conn.destPort === undefined ||
            !Number.isInteger(conn.destPort) ||
            conn.destPort < 0 ||
            conn.destPort > 65535) {
            throw new Error(`${conn.protocol} connection requires destPort in [0, 65535]`);
        }
    }
    else if (conn.destPort !== undefined) {
        throw new Error('ICMP connection must not carry destPort');
    }
    const src = parseAddress(conn.sourceAddress);
    const dst = parseAddress(conn.destAddress);
    if (src.family !== dst.family) {
        throw new Error('connection source and destination must share an address family');
    }
    const compiled = compilePolicy(rules);
    for (const entry of compiled) {
        if (entry.family !== src.family || entry.rule.direction !== conn.direction) {
            continue;
        }
        for (const atom of entry.atoms) {
            if (atom.protocol !== conn.protocol) {
                continue;
            }
            const rect = atom.rect;
            if (src.value >= rect.srcMin &&
                src.value <= rect.srcMax &&
                dst.value >= rect.dstMin &&
                dst.value <= rect.dstMax &&
                (conn.protocol === 'ICMP' ||
                    (conn.destPort >= rect.portMin && conn.destPort <= rect.portMax))) {
                return { ruleId: entry.rule.id, action: entry.rule.action };
            }
        }
    }
    return { ruleId: null, action: 'default-deny' };
}
//# sourceMappingURL=evaluate.js.map