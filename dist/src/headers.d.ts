export interface ParsedHeaders {
    get(name: string): string | undefined;
}
export interface ContentTypeInfo {
    mediaType: string;
    params: Map<string, string>;
}
export declare function parseHeaders(raw: string): ParsedHeaders;
export declare function parseContentType(value: string): ContentTypeInfo;
