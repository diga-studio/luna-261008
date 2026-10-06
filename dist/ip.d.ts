export type AddressFamily = 'ipv4' | 'ipv6';
export interface CidrRange {
    readonly family: AddressFamily;
    /** 网络前缀起始地址（主机位已清零）。 */
    readonly start: bigint;
    readonly end: bigint;
}
/** 解析 IPv4 或 IPv6 地址为 bigint；IPv4 映射 IPv6 地址属于 IPv6。 */
export declare function parseAddress(address: string): {
    family: AddressFamily;
    value: bigint;
};
/** 解析 CIDR；非零主机位按网络前缀解释（清零）。 */
export declare function parseCidr(cidr: string): CidrRange;
export declare function formatAddress(family: AddressFamily, value: bigint): string;
