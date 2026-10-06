import { createSign } from "crypto";
import {
  derExplicit,
  derInteger,
  derIntegerFromNumber,
  derOctetString,
  derOid,
  derSequence,
  derUtcTime,
  derBitString,
  readChildren,
  readTlv,
} from "./der";

const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const OID_CRL_NUMBER = "2.5.29.20";

export interface CrlEntry {
  readonly serialNumber: string;
  readonly revocationDate: Date;
}

export function pemToDer(pem: string, label: string): Buffer {
  const pattern = new RegExp(
    `-----BEGIN ${label}-----([A-Za-z0-9+/=\\r\\n]+)-----END ${label}-----`
  );
  const match = pem.match(pattern);
  if (!match) {
    throw new Error(`no PEM block with label ${label} found`);
  }
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

export function derToPem(der: Buffer, label: string): string {
  const base64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function extractIssuerDer(caCertDer: Buffer): Buffer {
  const cert = readTlv(caCertDer);
  if (cert.tag !== 0x30) {
    throw new Error("CA certificate is not a DER SEQUENCE");
  }
  const certChildren = readChildren(cert);
  const tbs = certChildren[0];
  const tbsChildren = readChildren(tbs);
  let index = 0;
  if (tbsChildren[0].tag === 0xa0) {
    index = 1;
  }
  const issuer = tbsChildren[index + 2];
  if (!issuer || issuer.tag !== 0x30) {
    throw new Error("cannot locate issuer Name in CA certificate");
  }
  return issuer.full;
}

function algorithmIdentifier(): Buffer {
  return derSequence(derOid(OID_SHA256_WITH_RSA), Buffer.from([0x05, 0x00]));
}

function serialToBytes(serialNumber: string): Buffer {
  const hex = serialNumber.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`invalid certificate serial number: ${serialNumber}`);
  }
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  return Buffer.from(padded, "hex");
}

export function buildCrlPem(
  caCertPem: string,
  caKeyPem: string,
  crlNumber: number,
  entries: readonly CrlEntry[],
  thisUpdate: Date,
  nextUpdate: Date
): string {
  const caCertDer = pemToDer(caCertPem, "CERTIFICATE");
  const issuerDer = extractIssuerDer(caCertDer);

  const revoked =
    entries.length === 0
      ? Buffer.alloc(0)
      : derSequence(
          ...entries.map((entry) =>
            derSequence(
              derInteger(serialToBytes(entry.serialNumber)),
              derUtcTime(entry.revocationDate)
            )
          )
        );

  const extensions = derExplicit(
    0,
    derSequence(
      derSequence(
        derOid(OID_CRL_NUMBER),
        derOctetString(derIntegerFromNumber(crlNumber))
      )
    )
  );

  const tbs = derSequence(
    derIntegerFromNumber(1),
    algorithmIdentifier(),
    issuerDer,
    derUtcTime(thisUpdate),
    derUtcTime(nextUpdate),
    revoked,
    extensions
  );

  const signer = createSign("RSA-SHA256");
  signer.update(tbs);
  const signature = signer.sign(caKeyPem);

  const crl = derSequence(
    tbs,
    algorithmIdentifier(),
    derBitString(signature)
  );
  return derToPem(crl, "X509 CRL");
}
