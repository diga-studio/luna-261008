import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RevocationService } from "../src/index.ts";
import {
  bitString,
  derToPem,
  explicit0,
  integerFromNumber,
  nullValue,
  oid,
  sequence,
  tlv,
  utcTime,
} from "../src/der.ts";

// ---------------------------------------------------------------------------
// CA fixture: a self-signed RSA CA certificate built with the library's DER
// writer. The CRL *verification* below uses a parser written independently in
// this test file.
// ---------------------------------------------------------------------------

interface TestCa {
  certificatePem: string;
  privateKeyPem: string;
  publicKeyPem: string;
  /** Raw DER of the subject/issuer Name. */
  nameDer: Buffer;
}

function makeCa(commonName: string): TestCa {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const cn = sequence(
    oid("2.5.4.3"),
    tlv(0x0c, Buffer.from(commonName, "utf8")), // UTF8String
  );
  const nameDer = sequence(tlv(0x31, cn)); // RDNSequence with one SET
  const algorithm = sequence(oid("1.2.840.113549.1.1.11"), nullValue());
  const now = Date.now();
  const tbs = sequence(
    explicit0(integerFromNumber(2)), // v3
    integerFromNumber(1), // serial
    algorithm,
    nameDer, // issuer
    sequence(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))),
    nameDer, // subject
    publicKey.export({ format: "der", type: "spki" }),
  );
  const signature = cryptoSign("sha256", tbs, privateKey);
  const cert = sequence(tbs, algorithm, bitString(signature));
  return {
    certificatePem: derToPem(cert, "CERTIFICATE"),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    nameDer,
  };
}

// ---------------------------------------------------------------------------
// Independent CRL parser + verifier (does not reuse library parsing code).
// ---------------------------------------------------------------------------

interface Tlv {
  tag: number;
  content: Buffer;
  raw: Buffer;
  next: number;
}

function readTlv(buf: Buffer, off: number): Tlv {
  const tag = buf[off];
  let pos = off + 1;
  const first = buf[pos++];
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[pos++];
  }
  return {
    tag,
    content: buf.subarray(pos, pos + length),
    raw: buf.subarray(off, pos + length),
    next: pos + length,
  };
}

function tlvChildren(el: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let off = 0;
  while (off < el.content.length) {
    const child = readTlv(el.content, off);
    out.push(child);
    off = child.next;
  }
  return out;
}

function derIntegerToNumber(el: Tlv): number {
  let value = 0;
  for (const byte of el.content) value = value * 256 + byte;
  return value;
}

interface ParsedCrl {
  version: number;
  issuerRaw: Buffer;
  revokedSerials: string[];
  crlNumber: number;
  signatureValid: boolean;
}

function parseAndVerifyCrl(pem: string, caPublicKeyPem: string): ParsedCrl {
  const match = pem.match(
    /-----BEGIN X509 CRL-----\s*([A-Za-z0-9+/=\r\n]+?)\s*-----END X509 CRL-----/,
  );
  assert.ok(match, "CRL must be a PEM block labeled X509 CRL");
  const der = Buffer.from(match[1].replace(/\s+/g, ""), "base64");

  const certificateList = readTlv(der, 0);
  assert.equal(certificateList.tag, 0x30, "CertificateList must be a SEQUENCE");
  assert.equal(certificateList.next, der.length, "no trailing data after CRL");

  const listParts = tlvChildren(certificateList);
  assert.equal(listParts.length, 3, "CertificateList has tbs, algorithm, signature");
  const [tbs, outerAlgorithm, signatureBitString] = listParts;

  const tbsParts = tlvChildren(tbs);
  const version = derIntegerToNumber(tbsParts[0]);
  assert.equal(version, 1, "CRL version must be v2 (INTEGER 1)");

  const innerAlgorithm = tbsParts[1];
  const sha256WithRsa = Buffer.from([
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
  ]);
  assert.ok(
    tlvChildren(innerAlgorithm)[0].raw.equals(sha256WithRsa),
    "tbs signature algorithm must be sha256WithRSAEncryption",
  );
  assert.ok(
    tlvChildren(outerAlgorithm)[0].raw.equals(sha256WithRsa),
    "outer signature algorithm must be sha256WithRSAEncryption",
  );

  const issuerRaw = tbsParts[2].raw;

  // thisUpdate / nextUpdate occupy positions 3 and 4.
  assert.equal(tbsParts[3].tag, 0x17, "thisUpdate must be UTCTime");
  assert.equal(tbsParts[4].tag, 0x17, "nextUpdate must be UTCTime");

  const revokedSerials: string[] = [];
  let index = 5;
  if (index < tbsParts.length && tbsParts[index].tag === 0x30) {
    for (const entry of tlvChildren(tbsParts[index])) {
      const entryParts = tlvChildren(entry);
      revokedSerials.push(
        Buffer.from(entryParts[0].content)
          .toString("hex")
          .replace(/^0+(?=[0-9a-f])/i, "")
          .toUpperCase(),
      );
      assert.equal(entryParts[1].tag, 0x17, "revocationDate must be UTCTime");
    }
    index += 1;
  }

  assert.ok(index < tbsParts.length, "CRL must carry extensions");
  const extensionsWrapper = tbsParts[index];
  assert.equal(extensionsWrapper.tag, 0xa0, "extensions must be [0] EXPLICIT");
  let crlNumber: number | null = null;
  for (const extension of tlvChildren(readTlv(extensionsWrapper.content, 0))) {
    const parts = tlvChildren(extension);
    const extnId = parts[0];
    // OID 2.5.29.20 (cRLNumber)
    if (extnId.content.equals(Buffer.from([0x55, 0x1d, 0x14]))) {
      const extnValue = parts[parts.length - 1];
      crlNumber = derIntegerToNumber(readTlv(extnValue.content, 0));
    }
  }
  assert.ok(crlNumber !== null, "CRL must contain a CRLNumber extension");

  assert.equal(signatureBitString.tag, 0x03, "signature must be a BIT STRING");
  assert.equal(signatureBitString.content[0], 0, "no unused bits expected");
  const signature = signatureBitString.content.subarray(1);
  const signatureValid = cryptoVerify(
    "RSA-SHA256",
    tbs.raw,
    caPublicKeyPem,
    signature,
  );

  return { version, issuerRaw, revokedSerials, crlNumber, signatureValid };
}

/** Normalize a serial the way a reader would display it (no leading zeros). */
function displaySerial(hex: string): string {
  let h = hex.replace(/^0[xX]/, "").toUpperCase();
  if (h.length % 2 === 1) h = "0" + h;
  h = h.replace(/^00+(?=[0-9A-F])/, "");
  return h.replace(/^0(?=[0-9A-F])/, "");
}

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "crl-test-"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("department batch revocation publishes a verifiable CRL with all department certs", async () => {
  const ca = makeCa("Test CA");
  const workDir = makeWorkDir();

  const service = await RevocationService.open({
    workDir,
    caCertificatePem: ca.certificatePem,
    caPrivateKeyPem: ca.privateKeyPem,
  });

  // First initialization publishes an empty CRL numbered 0.
  const crlPath = join(workDir, "crl.pem");
  assert.ok(existsSync(crlPath), "crl.pem must exist after initialization");
  const initial = parseAndVerifyCrl(readFileSync(crlPath, "utf8"), ca.publicKeyPem);
  assert.equal(initial.crlNumber, 0);
  assert.deepEqual(initial.revokedSerials, []);
  assert.ok(initial.signatureValid, "initial CRL signature must verify");
  assert.ok(initial.issuerRaw.equals(ca.nameDer), "issuer must be the CA name");

  // Register certificates across two departments.
  const engSerials = ["0A0B0C", "0x0D0E", "ff10"];
  const opsSerial = "1234";
  for (const serial of engSerials) {
    await service.registerCertificate({ serialNumber: serial, department: "eng" });
  }
  await service.registerCertificate({ serialNumber: opsSerial, department: "ops" });

  // Registration alone must not touch the published CRL.
  assert.equal(
    parseAndVerifyCrl(readFileSync(crlPath, "utf8"), ca.publicKeyPem).crlNumber,
    0,
    "registration must not advance the CRL number",
  );

  const result = await service.revokeDepartment("eng");
  assert.equal(result.newlyRevoked, 3);
  assert.equal(result.crlNumber, 1);

  const published = readFileSync(crlPath, "utf8");
  const parsed = parseAndVerifyCrl(published, ca.publicKeyPem);
  assert.equal(parsed.crlNumber, 1);
  assert.ok(parsed.signatureValid, "CRL signature must verify against the CA");
  assert.ok(parsed.issuerRaw.equals(ca.nameDer), "issuer must be the CA name");
  assert.deepEqual(
    [...parsed.revokedSerials].sort(),
    engSerials.map(displaySerial).sort(),
    "CRL must contain exactly the eng certificates",
  );
  assert.ok(
    !parsed.revokedSerials.includes(displaySerial(opsSerial)),
    "ops certificate must not be revoked",
  );

  // getCurrentCrl must match the published file exactly.
  assert.equal(await service.getCurrentCrl(), published);
});

test("follow-up revocation keeps old entries, advances number only on new revocations", async () => {
  const ca = makeCa("Test CA 2");
  const workDir = makeWorkDir();

  const service = await RevocationService.open({
    workDir,
    caCertificatePem: ca.certificatePem,
    caPrivateKeyPem: ca.privateKeyPem,
  });

  await service.registerCertificate({ serialNumber: "AA01", department: "eng" });
  await service.registerCertificate({ serialNumber: "AA02", department: "eng" });
  const first = await service.revokeDepartment("eng");
  assert.equal(first.newlyRevoked, 2);
  assert.equal(first.crlNumber, 1);

  // New certificates registered after the first revocation are not auto-revoked.
  await service.registerCertificate({ serialNumber: "AA03", department: "eng" });
  await service.registerCertificate({ serialNumber: "AA04", department: "eng" });
  const crlPath = join(workDir, "crl.pem");
  assert.equal(
    parseAndVerifyCrl(readFileSync(crlPath, "utf8"), ca.publicKeyPem).crlNumber,
    1,
    "new registrations must not change the published CRL",
  );

  const second = await service.revokeDepartment("eng");
  assert.equal(second.newlyRevoked, 2);
  assert.equal(second.crlNumber, 2);

  const publishedV2 = readFileSync(crlPath, "utf8");
  const parsedV2 = parseAndVerifyCrl(publishedV2, ca.publicKeyPem);
  assert.equal(parsedV2.crlNumber, 2);
  assert.ok(parsedV2.signatureValid);
  assert.deepEqual(
    [...parsedV2.revokedSerials].sort(),
    ["AA01", "AA02", "AA03", "AA04"],
    "old revocations must be kept and new ones added",
  );

  // Idempotent retry: no new certificates, so no new CRL version.
  const retry = await service.revokeDepartment("eng");
  assert.equal(retry.newlyRevoked, 0);
  assert.equal(retry.crlNumber, 2);
  assert.equal(
    readFileSync(crlPath, "utf8"),
    publishedV2,
    "retry without new revocations must not change the file",
  );

  // Re-registering an existing (revoked) certificate is a no-op and does not
  // restore validity.
  await service.registerCertificate({ serialNumber: "AA01", department: "eng" });
  const afterDup = await service.revokeDepartment("eng");
  assert.equal(afterDup.newlyRevoked, 0);
  assert.equal(afterDup.crlNumber, 2);
  assert.equal(readFileSync(crlPath, "utf8"), publishedV2);

  // Reopening the working directory keeps serving the same CRL.
  const reopened = await RevocationService.open({
    workDir,
    caCertificatePem: ca.certificatePem,
    caPrivateKeyPem: ca.privateKeyPem,
  });
  assert.equal(await reopened.getCurrentCrl(), publishedV2);
  const parsedReopened = parseAndVerifyCrl(
    await reopened.getCurrentCrl(),
    ca.publicKeyPem,
  );
  assert.equal(parsedReopened.crlNumber, 2);
  assert.deepEqual([...parsedReopened.revokedSerials].sort(), [
    "AA01",
    "AA02",
    "AA03",
    "AA04",
  ]);
});
