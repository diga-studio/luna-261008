export interface CertificateInput {
  readonly serialNumber: string;
  readonly department: string;
}

export interface CertificateRecord {
  readonly serialNumber: string;
  readonly department: string;
  readonly revoked: boolean;
  readonly revocationDate?: string;
}

export interface RevokeDepartmentResult {
  readonly department: string;
  readonly newlyRevoked: readonly string[];
  readonly crlNumber: number;
  readonly published: boolean;
}

export interface PersistedState {
  readonly crlNumber: number;
  readonly certificates: CertificateRecord[];
}
