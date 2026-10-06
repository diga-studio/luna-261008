const IPV4_BITS = 32n;
const IPV6_BITS = 128n;
function parseIpv4(address) {
    const parts = address.split('.');
    if (parts.length !== 4) {
        throw new Error(`invalid IPv4 address: ${address}`);
    }
    let value = 0n;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) {
            throw new Error(`invalid IPv4 address: ${address}`);
        }
        const octet = Number(part);
        if (octet > 255) {
            throw new Error(`invalid IPv4 address: ${address}`);
        }
        value = (value << 8n) | BigInt(octet);
    }
    return value;
}
function parseIpv6(address) {
    let rest = address;
    let tail = null;
    // 处理内嵌 IPv4（如 ::ffff:1.2.3.4），其仍属于 IPv6 地址族。
    const v4Match = /(\d+\.\d+\.\d+\.\d+)$/.exec(rest);
    if (v4Match) {
        const v4Part = v4Match[1];
        tail = parseIpv4(v4Part);
        rest = rest.slice(0, rest.length - v4Part.length);
        if (rest.endsWith(':')) {
            rest = rest.slice(0, -1);
        }
    }
    const groups = [];
    let zerosInsert = -1;
    if (rest.length > 0 && rest !== '::') {
        const halves = rest.split('::');
        if (halves.length > 2) {
            throw new Error(`invalid IPv6 address: ${address}`);
        }
        const left = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
        const right = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : null;
        for (const g of left) {
            groups.push(parseHexGroup(g, address));
        }
        if (right !== null) {
            zerosInsert = groups.length;
            for (const g of right) {
                groups.push(parseHexGroup(g, address));
            }
        }
    }
    else if (rest === '::') {
        zerosInsert = 0;
    }
    const tailGroups = tail === null ? 0 : 2;
    const total = groups.length + tailGroups;
    if (zerosInsert === -1) {
        if (total !== 8) {
            throw new Error(`invalid IPv6 address: ${address}`);
        }
    }
    else {
        if (total > 7) {
            throw new Error(`invalid IPv6 address: ${address}`);
        }
        const fill = 8 - total;
        groups.splice(zerosInsert, 0, ...new Array(fill).fill(0));
    }
    let value = 0n;
    for (const g of groups) {
        value = (value << 16n) | BigInt(g);
    }
    if (tail !== null) {
        value = (value << 32n) | tail;
    }
    return value;
}
function parseHexGroup(group, full) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
        throw new Error(`invalid IPv6 address: ${full}`);
    }
    return parseInt(group, 16);
}
/** 解析 IPv4 或 IPv6 地址为 bigint；IPv4 映射 IPv6 地址属于 IPv6。 */
export function parseAddress(address) {
    if (address.includes(':')) {
        return { family: 'ipv6', value: parseIpv6(address) };
    }
    return { family: 'ipv4', value: parseIpv4(address) };
}
/** 解析 CIDR；非零主机位按网络前缀解释（清零）。 */
export function parseCidr(cidr) {
    const slash = cidr.lastIndexOf('/');
    if (slash === -1) {
        throw new Error(`invalid CIDR: ${cidr}`);
    }
    const { family, value } = parseAddress(cidr.slice(0, slash));
    const bits = family === 'ipv4' ? IPV4_BITS : IPV6_BITS;
    const prefix = Number(cidr.slice(slash + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || BigInt(prefix) > bits) {
        throw new Error(`invalid CIDR prefix: ${cidr}`);
    }
    const shift = bits - BigInt(prefix);
    const start = (value >> shift) << shift;
    const end = start + (1n << shift) - 1n;
    return { family, start, end };
}
export function formatAddress(family, value) {
    if (family === 'ipv4') {
        const octets = [];
        for (let i = 3; i >= 0; i--) {
            octets.push(String((value >> BigInt(i * 8)) & 0xffn));
        }
        return octets.join('.');
    }
    const groups = [];
    for (let i = 7; i >= 0; i--) {
        groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
    }
    // 找最长的全零段（长度>=2）压缩为 ::。
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    for (let i = 0; i <= 8; i++) {
        if (i < 8 && groups[i] === 0) {
            if (curStart === -1)
                curStart = i;
        }
        else if (curStart !== -1) {
            const len = i - curStart;
            if (len >= 2 && len > bestLen) {
                bestStart = curStart;
                bestLen = len;
            }
            curStart = -1;
        }
    }
    const hex = groups.map((g) => g.toString(16));
    if (bestStart === -1) {
        return hex.join(':');
    }
    const left = hex.slice(0, bestStart).join(':');
    const right = hex.slice(bestStart + bestLen).join(':');
    return `${left}::${right}`;
}
//# sourceMappingURL=ip.js.map