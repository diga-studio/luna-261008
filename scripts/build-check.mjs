import { readdir } from "node:fs/promises";
import { join } from "node:path";

const srcDir = new URL("../src/", import.meta.url);
const entries = await readdir(srcDir);
const modules = entries.filter((name) => name.endsWith(".ts"));
for (const name of modules) {
  await import(join(srcDir.pathname, name));
}
console.log(`build ok: loaded ${modules.length} modules`);
