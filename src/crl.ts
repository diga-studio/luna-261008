/** CRL (X.509v2) generation, signed by the caller-provided CA. */

import { sign as cryptoSign } from "node:crypto";
import {
  bitString,
  children,
  derToPem,
  explicit0,
  integerFromBytes,
  integerFromNumber,
  nullValue,
  octetString,
  oid,
  pemToDer,
  readElement,
  sequence,
  sequenceOf,
  utcTime,
} from "./der.ts";

/** One revoked certificate entry inside a CRL. */
export interface RevokedEntry {
  /** Normalized serial number (uppercase hex, even length). */
  readonly serialNumber: string;
  /** When the certificate was revoked. */
  readonly revocationDate: Date;
}

/** Material needed to issue CRLs on behalf of the CA. */
export interface CaMaterial {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

/**
 * Build a PEM-encoded X.509v2 CRL signed by the CA, containing the given
 * revoked entries and the given CRL number.
 */
export async function buildCrlPem(
  ca: CaMaterial,
  crlNumber: number,
  entries: readonly RevokedEntry[],
): Promise<string> {
  const issuerName = extractIssuerName(pemToDer(ca.certificatePem, "CERTIFICATE"));

  // sha256WithRSAEncryption, RFC 8017
  const signatureAlgorithm = sequence(
    oid("1.2.840.113549.1.1.11"),
    nullValue(),
  );

  const now = new Date();
  const nextUpdate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const revokedCertificates =
    entries.length === 0
      ? Buffer.alloc(0)
      : sequenceOf(
          entries.map((entry) =>
            sequence(
              integerFromBytes(Buffer.from(entry.serialNumber, "hex")),
              utcTime(entry.revocationDate),
            ),
          ),
        );

  // CRLNumber extension, RFC 5280 section 5.2.3 (OID 2.5.29.20)
  const crlNumberExtension = sequence(
    oid("2.5.29.20"),
    octetString(integerFromNumber(crlNumber)),
  );

  const tbsCertList = sequence(
    integerFromNumber(1), // version: v2
    signatureAlgorithm,
    issuerName,
    utcTime(now),
    utcTime(nextUpdate),
    revokedCertificates,
    explicit0(sequenceOf([crlNumberExtension])),
  );

  const signature = cryptoSign("sha256", tbsCertList, ca.privateKeyPem);

  const certificateList = sequence(
    tbsCertList,
    signatureAlgorithm,
    bitString(signature),
  );

  return derToPem(certificateList, "X509 CRL");
}

/** Normalize a caller-provided serial number to uppercase even-length hex. */
export function normalizeSerial(serial: string): string {
  let hex = serial.trim().replace(/^0[xX]/, "").toUpperCase();
  if (hex.length === 0 || !/^[0-9A-F]+$/.test(hex)) {
    throw new Error(`invalid serial number: ${JSON.stringify(serial)}`);
  }
  if (hex.length % 2 === 1) {
    hex = "0" + hex;
  }
  while (hex.length > 2 && hex.startsWith("00")) {
    hex = hex.slice(2);
  }
  return hex;
}

/** Read the CRLNumber extension from a PEM-encoded CRL. */
export function readCrlNumber(crlPem: string): number {
  const certificateList = readElement(pemToDer(crlPem, "X509 CRL"));
  const tbsCertList = readElement(certificateList.content, 0);
  const fields = children(tbsCertList);
  // version, signature, issuer, thisUpdate, nextUpdate, [revokedCertificates],
  // then [0] extensions.
  const extensionsWrapper = fields[fields.length - 1];
  if (!extensionsWrapper || extensionsWrapper.tag !== 0xa0) {
    throw new Error("CRL has no extensions");
  }
  for (const extension of children(readElement(extensionsWrapper.content, 0))) {
    const parts = children(extension);
    const extnId = parts[0];
    if (extnId.tag === 0x06 && extnId.content.equals(oidContent("2.5.29.20"))) {
      const extnValue = parts[parts.length - 1];
      const integer = readElement(extnValue.content, 0);
      let value = 0;
      for (const byte of integer.content) {
        value = value * 256 + byte;
      }
      return value;
    }
  }
  throw new Error("CRL has no CRLNumber extension");
}

/** Raw OID content bytes (without tag/length) for comparison. */
function oidContent(dotted: string): Buffer {
  return readElement(oid(dotted)).content;
}

/** Extract the raw DER issuer Name from a DER-encoded X.509 certificate. */
function extractIssuerName(certDer: Buffer): Buffer {
  const certificate = readElement(certDer);
  if (certificate.tag !== 0x30) {
    throw new Error("invalid CA certificate: not a SEQUENCE");
  }
  const tbsCertificate = readElement(certificate.content, 0);
  if (tbsCertificate.tag !== 0x30) {
    throw new Error("invalid CA certificate: missing tbsCertificate");
  }
  const fields = children(tbsCertificate);
  // Optional [0] version, then serialNumber, signature, issuer.
  const hasVersion = fields.length > 0 && fields[0].tag === 0xa0;
  const issuerIndex = hasVersion ? 3 : 2;
  const issuer = fields[issuerIndex];
  if (!issuer || issuer.tag !== 0x30) {
    throw new Error("invalid CA certificate: missing issuer name");
  }
  return issuer.raw;
}
