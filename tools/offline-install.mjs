// Dev-environment helper: reconstruct node_modules from the local pnpm store
// (used only where the npm registry is unreachable). Not needed on a clean
// machine: `npm install` fetches the same pinned versions from the registry.
import fs from 'node:fs';
import path from 'node:path';

const STORE = process.env.PNPM_STORE_DIR ?? '/Users/ivan/Library/pnpm/store/v10';
const INDEX_DIR = path.join(STORE, 'index');
const ROOT = process.cwd();
const NM = path.join(ROOT, 'node_modules');

// ---- index of all packages available in the store ----
const available = new Map(); // name -> Map(version -> indexFilePath)
for (const dirEntry of fs.readdirSync(INDEX_DIR)) {
  const sub = path.join(INDEX_DIR, dirEntry);
  if (!fs.statSync(sub).isDirectory()) continue;
  for (const file of fs.readdirSync(sub)) {
    if (!file.endsWith('.json')) continue;
    const body = file.slice(0, -5); // strip .json
    const dash = body.indexOf('-');
    if (dash < 0) continue;
    const nameVer = body.slice(dash + 1);
    const at = nameVer.lastIndexOf('@');
    if (at <= 0) continue;
    const name = nameVer.slice(0, at).replace('+', '/');
    const version = nameVer.slice(at + 1);
    if (!available.has(name)) available.set(name, new Map());
    available.get(name).set(version, path.join(sub, file));
  }
}

// ---- minimal semver (handles exact, ^, ~, *, and comparator sets) ----
function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)([-+].*)?$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function satisfies(version, range) {
  const v = parse(version);
  if (!v) return false;
  range = range.trim();
  if (range === '*' || range === '') return true;
  for (const part of range.split(/\s+/)) {
    let m;
    if ((m = /^>=?(\d+\.\d+\.\d+)$/.exec(part))) { if (cmp(v, parse(m[1])) < 0) return false; }
    else if ((m = /^<=?(\d+\.\d+\.\d+)$/.exec(part))) { if (cmp(v, parse(m[1])) > 0) return false; }
    else if ((m = /^>(\d+\.\d+\.\d+)$/.exec(part))) { if (cmp(v, parse(m[1])) <= 0) return false; }
    else if ((m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(part))) {
      const [maj, min] = [Number(m[1]), Number(m[2])];
      if (v[0] !== maj) return false;
      if (maj === 0 && v[1] !== min) return false;
      if (cmp(v, [maj, min, Number(m[3])]) < 0) return false;
    }
    else if ((m = /^~(\d+)\.(\d+)\.(\d+)$/.exec(part))) {
      if (v[0] !== Number(m[1]) || v[1] !== Number(m[2])) return false;
      if (cmp(v, [Number(m[1]), Number(m[2]), Number(m[3])]) < 0) return false;
    }
    else if ((m = /^(\d+\.\d+\.\d+)$/.exec(part))) { if (cmp(v, parse(m[1])) !== 0) return false; }
    else throw new Error(`unsupported range: ${range}`);
  }
  return true;
}
const SYNTHESIZABLE = new Map([
  ['bin/tsc', "#!/usr/bin/env node\nrequire('../lib/tsc.js')\n"],
  ['bin/tsserver', "#!/usr/bin/env node\nrequire('../lib/tsserver.js')\n"],
]);
function blobAvailable(rel, meta) {
  return fs.existsSync(blobPath(meta.integrity)) || SYNTHESIZABLE.has(rel);
}
function blobsPresent(indexFile) {
  const entry = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  return Object.entries(entry.files).every(([rel, meta]) => blobAvailable(rel, meta));
}
function resolve(name, range) {
  const versions = available.get(name);
  if (!versions) throw new Error(`not in store: ${name}`);
  const ok = [...versions.keys()].filter((v) => satisfies(v, range) && blobsPresent(versions.get(v))).sort((a, b) => cmp(parse(a), parse(b)));
  if (ok.length === 0) throw new Error(`no version of ${name} satisfies ${range} (have: ${[...versions.keys()].join(', ')})`);
  return ok[ok.length - 1];
}

// ---- installer ----
const installed = new Map(); // name@version -> package dir
function blobPath(integrity) {
  const hex = Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
  return path.join(STORE, 'files', hex.slice(0, 2), hex.slice(2));
}
function installPkg(name, version) {
  const key = `${name}@${version}`;
  if (installed.has(key)) return installed.get(key);
  const indexFile = available.get(name)?.get(version);
  if (!indexFile) throw new Error(`missing index for ${key}`);
  const entry = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const dir = path.join(NM, '.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name);
  for (const [rel, meta] of Object.entries(entry.files)) {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const src = blobPath(meta.integrity);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    else if (SYNTHESIZABLE.has(rel)) fs.writeFileSync(dst, SYNTHESIZABLE.get(rel));
    else throw new Error(`missing blob for ${name}@${version}: ${rel}`);
    if (meta.mode) fs.chmodSync(dst, meta.mode);
  }
  installed.set(key, dir);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const deps = { ...pj.dependencies };
  for (const [dn, range] of Object.entries(deps)) {
    const dv = resolve(dn, range);
    const ddir = installPkg(dn, dv);
    linkDep(path.dirname(dir), dn, ddir);
  }
  return dir;
}
function linkDep(nodeModulesDir, depName, targetDir) {
  const link = path.join(nodeModulesDir, depName);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true, recursive: true });
  fs.symlinkSync(path.relative(path.dirname(link), targetDir), link);
}
function linkBin(pkgDir, binName, binPath) {
  const binDir = path.join(NM, '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const link = path.join(binDir, binName);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.relative(binDir, path.join(pkgDir, binPath)), link);
}

// ---- resolve from root package.json ----
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const wanted = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
for (const [name, range] of Object.entries(wanted)) {
  const version = resolve(name, range);
  const dir = installPkg(name, version);
  linkDep(NM, name, dir);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (pj.bin) {
    const bins = typeof pj.bin === 'string' ? { [name.split('/').pop()]: pj.bin } : pj.bin;
    for (const [binName, binPath] of Object.entries(bins)) linkBin(dir, binName, binPath);
  }
  console.log(`installed ${name}@${version}`);
}
console.log('done');
