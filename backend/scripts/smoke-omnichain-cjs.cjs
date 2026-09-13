/**
 * Boot smoke test: proves the compiled CommonJS build can `require()` the
 * ESM-only @getomnichain/omnichain on this Node. The package is
 * `"type": "module"` with no CJS build, so this only works on Node >= 20.19
 * (require(esm)); below that the real service dies at startup with
 * ERR_REQUIRE_ESM. Run in CI on the pinned base image before deploy.
 *   node scripts/smoke-omnichain-cjs.cjs
 */
const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const omni = require('@getomnichain/omnichain');

assert.strictEqual(typeof omni.networkTypeOf, 'function', 'networkTypeOf export missing');
assert.strictEqual(typeof omni.registerNonEvmChain, 'function', 'registerNonEvmChain export missing');
assert.strictEqual(omni.networkTypeOf(56), 'EVM', 'EVM typing broken');

// Also load a COMPILED dist module that imports the ESM package, so this proves
// the tsc-emitted CommonJS graph (not just a hand-written .cjs) can require(esm).
// Skipped gracefully if run before `npm run build`.
require('reflect-metadata');
const built = join(__dirname, '..', 'dist', 'src', 'core', 'chain_config', 'chain_config.service.js');
if (existsSync(built)) {
  require(built);
  // eslint-disable-next-line no-console
  console.log('compiled dist chain_config.service.js loaded (CJS require(esm) through the build)');
} else {
  // eslint-disable-next-line no-console
  console.log('dist not built yet — skipped compiled-graph check (run after npm run build)');
}

// eslint-disable-next-line no-console
console.log(`omnichain CJS require OK on ${process.version} (require(esm) works)`);
