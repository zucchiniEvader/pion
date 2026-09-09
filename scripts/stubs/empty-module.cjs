// Empty stub for ws's OPTIONAL native accelerators (bufferutil / utf-8-validate).
// electron-vite bundles `ws` into the main process (R2-A remote client); the
// optional-dep imports must resolve at BUILD time even though the packages are
// intentionally not installed — ws falls back to its pure-JS path when the stub
// resolves to an empty module (same runtime outcome as esbuild's `external` in
// scripts/build-daemon.mjs).
module.exports = {}
