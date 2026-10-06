/** Classification labels returned by observe(). */
export const RATE_ABUSE = "RATE_ABUSE" as const;
export const ENDPOINT_SCAN = "ENDPOINT_SCAN" as const;

export type Classification = typeof RATE_ABUSE | typeof ENDPOINT_SCAN;
