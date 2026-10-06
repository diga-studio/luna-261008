// Minimal ambient declarations so the project compiles without @types/node.
declare module 'node:test' {
  const test: any;
  export default test;
  export { test };
}
declare module 'node:assert/strict' {
  const assert: any;
  export = assert;
}
declare const process: any;
declare const console: any;
