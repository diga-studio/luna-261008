import { verify as cryptoVerify } from "crypto";
import { readChildren, readTlv, type DerNode } from "../src/der";
import { pemToDer } from "../src/crl";

export interface ParsedCrl {
  readonly version: number;
  readonly issuerDer: Buffer;
  readonly crlNumber: number;
  readonly revokedSerials: string[];
  readonly tbsDer: Buffer;
  readonly signature: Buffer;
}

function derIntegerToNumber(node: DerNode): number {
  let value = 0;
  for (const byte of node.value) {
    value = value * 256 + byte;
  }
  return value;
}

export function parseCrl(pem: string): ParsedCrl {
  const der = pemToDer(pem, "X509 CRL");
  const root = readTlv(der);
  if (root.totalLength !== der.length) {
    throw new Error("trailing data after CRL");
  }
  const [tbs, , sigValue] = readChildren(root);
  const tbsChildren = readChildren(tbs);
  const version = derIntegerToNumber(tbsChildren[0]);
  const issuerDer = tbsChildren[2].full;

  let index = 5;
  const revokedSerials: string[] = [];
  if (tbsChildren[index].tag === 0x30) {
    for (const entry of readChildren(tbsChildren[index])) {
      const entryChildren = readChildren(entry);
      let serial = entryChildren[0].value;
      if (serial.length > 1 && serial[0] === 0x00) {
        serial = serial.subarray(1);
      }
      let hex = Buffer.from(serial).toString("hex");
      if (hex.length % 2 !== 0) {
        hex = `0${hex}`;
      }
      revokedSerials.push(hex);
    }
    index++;
  }

  let crlNumber = -1;
  if (index < tbsChildren.length && tbsChildren[index].tag === 0xa0) {
    const extensions = readChildren(tbsChildren[index])[0];
    for (const ext of readChildren(extensions)) {
      const extChildren = readChildren(ext);
      const oid = extChildren[0].value;
      if (oid.equals(Buffer.from([0x55, 0x1d, 0x14]))) {
        const inner = readTlv(extChildren[extChildren.length - 1].value);
        crlNumber = derIntegerToNumber(inner);
      }
    }
  }

  return {
    version,
    issuerDer,
    crlNumber,
    revokedSerials,
    tbsDer: tbs.full,
    signature: sigValue.value.subarray(1),
  };
}

export function verifyCrlSignature(parsed: ParsedCrl, caCertPem: string): boolean {
  return cryptoVerify("RSA-SHA256", parsed.tbsDer, caCertPem, parsed.signature);
}

export function caSubjectDer(caCertPem: string): Buffer {
  const certDer = pemToDer(caCertPem, "CERTIFICATE");
  const cert = readTlv(certDer);
  const tbs = readChildren(cert)[0];
  const tbsChildren = readChildren(tbs);
  const offset = tbsChildren[0].tag === 0xa0 ? 1 : 0;
  return tbsChildren[offset + 4].full;
}
