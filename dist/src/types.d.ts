/** A domain name as a list of labels; each label preserves raw octets. Root = []. */
export type Labels = Uint8Array[];
export interface Header {
    id: number;
    flags: number;
    qdcount: number;
    ancount: number;
    nscount: number;
    arcount: number;
}
export interface Question {
    name: Labels;
    qtype: number;
    qclass: number;
}
export type RData = {
    kind: "cname";
    name: Labels;
} | {
    kind: "soa";
    mname: Labels;
    rname: Labels;
    serial: number;
    refresh: number;
    retry: number;
    expire: number;
    minimum: number;
} | {
    kind: "opaque";
    data: Uint8Array;
};
export interface ResourceRecord {
    name: Labels;
    type: number;
    class: number;
    ttl: number;
    rdata: RData;
}
export interface Message {
    header: Header;
    questions: Question[];
    answers: ResourceRecord[];
    authorities: ResourceRecord[];
    additionals: ResourceRecord[];
}
