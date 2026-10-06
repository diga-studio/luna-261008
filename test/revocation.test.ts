import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { strict as assert } from "assert";
import { RevocationService } from "../src/service";
import { test } from "./framework";
import {
  caSubjectDer,
  parseCrl,
  verifyCrlSignature,
} from "./helpers";

const CA_CERT_PEM = readFileSync(
  join(__dirname, "../../test/fixtures/ca-cert.pem"),
  "utf8"
);
const CA_KEY_PEM = readFileSync(
  join(__dirname, "../../test/fixtures/ca-key.pem"),
  "utf8"
);

function makeService(): { service: RevocationService; workDir: string } {
  const workDir = mkdtempSync(join(tmpdir(), "crl-test-"));
  const service = new RevocationService({
    workDir,
    caCertPem: CA_CERT_PEM,
    caKeyPem: CA_KEY_PEM,
  });
  return { service, workDir };
}

function publishedCrl(workDir: string): string {
  return readFileSync(join(workDir, "crl.pem"), "utf8");
}

test("initialization publishes an empty CRL numbered 0", () => {
  const { service, workDir } = makeService();
  const pem = publishedCrl(workDir);
  assert.equal(service.getCurrentCrl(), pem);

  const parsed = parseCrl(pem);
  assert.equal(parsed.version, 1, "CRL must be X.509 v2");
  assert.equal(parsed.crlNumber, 0);
  assert.deepEqual(parsed.revokedSerials, []);
  assert.ok(
    verifyCrlSignature(parsed, CA_CERT_PEM),
    "CRL signature must verify against the CA certificate"
  );
  assert.ok(
    parsed.issuerDer.equals(caSubjectDer(CA_CERT_PEM)),
    "CRL issuer must equal the CA subject"
  );
});

test("department revocation publishes all of the department's certificates", () => {
  const { service, workDir } = makeService();
  service.registerCertificate("0a01", "engineering");
  service.registerCertificate("0a02", "engineering");
  service.registerCertificate("0b01", "sales");

  const result = service.revokeDepartment("engineering");
  assert.equal(result.published, true);
  assert.equal(result.crlNumber, 1);
  assert.deepEqual([...result.newlyRevoked].sort(), ["0a01", "0a02"]);

  const pem = publishedCrl(workDir);
  assert.equal(service.getCurrentCrl(), pem);

  const parsed = parseCrl(pem);
  assert.equal(parsed.crlNumber, 1);
  assert.deepEqual(parsed.revokedSerials.sort(), ["0a01", "0a02"]);
  assert.ok(verifyCrlSignature(parsed, CA_CERT_PEM));
});

test("later registrations need a new revocation; retries do not bump the number", () => {
  const { service, workDir } = makeService();
  service.registerCertificate("0a01", "engineering");
  service.registerCertificate("0a02", "engineering");
  service.revokeDepartment("engineering");

  service.registerCertificate("0a03", "engineering");
  const second = service.revokeDepartment("engineering");
  assert.equal(second.published, true);
  assert.equal(second.crlNumber, 2);
  assert.deepEqual(second.newlyRevoked, ["0a03"]);

  const parsed = parseCrl(publishedCrl(workDir));
  assert.equal(parsed.crlNumber, 2);
  assert.deepEqual(
    parsed.revokedSerials.sort(),
    ["0a01", "0a02", "0a03"],
    "old revocations must be retained alongside new ones"
  );
  assert.ok(verifyCrlSignature(parsed, CA_CERT_PEM));

  const before = publishedCrl(workDir);
  const retry = service.revokeDepartment("engineering");
  assert.equal(retry.published, false);
  assert.equal(retry.crlNumber, 2);
  assert.deepEqual(retry.newlyRevoked, []);
  assert.equal(
    publishedCrl(workDir),
    before,
    "retry without new registrations must not change the published file"
  );
  assert.equal(parseCrl(publishedCrl(workDir)).crlNumber, 2);
});

test("duplicate registration is a no-op and preserves revocation state", () => {
  const { service, workDir } = makeService();
  service.registerCertificate("0a01", "engineering");
  service.revokeDepartment("engineering");

  const again = service.registerCertificate("0A01", "engineering");
  assert.equal(again.revoked, true, "re-registration must not un-revoke");

  const other = service.registerCertificate("0a01", "sales");
  assert.equal(
    other.department,
    "engineering",
    "re-registration must not change the department"
  );

  const stateRaw = JSON.parse(
    readFileSync(join(workDir, "state.json"), "utf8")
  );
  assert.equal(stateRaw.certificates.length, 1);
  assert.equal(parseCrl(publishedCrl(workDir)).crlNumber, 1);
});

test("state survives re-instantiation on the same work directory", () => {
  const { service, workDir } = makeService();
  service.registerCertificate("0a01", "engineering");
  service.revokeDepartment("engineering");

  const reopened = new RevocationService({
    workDir,
    caCertPem: CA_CERT_PEM,
    caKeyPem: CA_KEY_PEM,
  });
  const parsed = parseCrl(reopened.getCurrentCrl());
  assert.equal(parsed.crlNumber, 1);
  assert.deepEqual(parsed.revokedSerials, ["0a01"]);
  assert.equal(reopened.getCurrentCrl(), publishedCrl(workDir));

  const retry = reopened.revokeDepartment("engineering");
  assert.equal(retry.published, false);
  assert.equal(retry.crlNumber, 1);
});

test("revoking an unknown or empty department changes nothing", () => {
  const { service, workDir } = makeService();
  service.registerCertificate("0a01", "engineering");
  const before = publishedCrl(workDir);

  const result = service.revokeDepartment("sales");
  assert.equal(result.published, false);
  assert.equal(result.crlNumber, 0);
  assert.equal(publishedCrl(workDir), before);
});

test("published files stay inside the work directory", () => {
  const { workDir } = makeService();
  const entries = readdirSync(workDir).sort();
  assert.deepEqual(entries, ["crl.pem", "state.json"]);
});
