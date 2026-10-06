/** Public types for the certificate revocation publishing library. */

/** A client certificate registered by the caller (issuance happens upstream). */
export interface RegisteredCertificate {
  /** Certificate serial number, hex string (optionally 0x-prefixed, case-insensitive). */
  readonly serialNumber: string;
  /** Owning department; immutable once registered. */
  readonly department: string;
}

/** Options used to open (or initialize) a revocation service instance. */
export interface RevocationServiceOptions {
  /** Local working directory where state and the published CRL are persisted. */
  readonly workDir: string;
  /** PEM-encoded RSA CA certificate used as the CRL issuer. */
  readonly caCertificatePem: string;
  /** PEM-encoded PKCS#8 RSA private key of the CA, used to sign CRLs. */
  readonly caPrivateKeyPem: string;
}

/** Result of a department-wide revocation call. */
export interface RevokeDepartmentResult {
  /** Number of certificates newly revoked by this call (0 when idempotent retry). */
  readonly newlyRevoked: number;
  /** CRL number of the currently published CRL after this call. */
  readonly crlNumber: number;
}
