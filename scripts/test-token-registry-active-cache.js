'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDependencyStubs(request, parent, isMain) {
  if (request === 'better-sqlite3') return function DatabaseStub() {};
  if (request === '@solana/web3.js') return { PublicKey: class PublicKeyStub {} };
  if (request === '../config') return { config: { storage: { dbPath: ':memory:' } } };
  if (request === '../utils/tokenMeta') {
    return {
      fetchTokenFullInfo: async () => null,
      fetchTokenCreationTime: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const TokenRegistry = require('../src/data/TokenRegistry');
Module._load = originalLoad;

const MINT = 'So11111111111111111111111111111111111111112';

function createRegistry() {
  const registry = Object.create(TokenRegistry.prototype);
  let row = {
    mint: MINT,
    symbol: 'CACHE',
    is_active: 1,
    fdv: 50_000,
    liquidity: 10_000,
    price: 0.00005,
    meta_json: null,
    market_source: null,
    migration_time: Date.now(),
  };

  registry.cache = new Map([[MINT, row]]);
  registry.stmts = {
    get: { get: () => row },
    getActive: { all: () => (Number(row.is_active) === 1 ? [row] : []) },
    updateMarket: { run: () => {} },
    getPoolOwner: { get: () => null },
    setPool: { run: () => {} },
    setMigration: { run: () => {} },
    removeStaleByAge: {
      run: () => {
        if (Number(row.is_active) !== 1) return { changes: 0 };
        row = { ...row, is_active: 0 };
        return { changes: 1 };
      },
    },
  };

  return {
    registry,
    getRow: () => row,
    setRow: (next) => { row = next; },
  };
}

const fixture = createRegistry();
const { registry } = fixture;

assert.strictEqual(registry.listActive().length, 1);

fixture.setRow({ ...fixture.getRow(), is_active: 0 });
registry.updateMarket(MINT, {
  fdv: 45_000,
  liquidity: 9_000,
  price: 0.000045,
  fetchedAt: Date.now(),
});
assert.strictEqual(registry.cache.has(MINT), false, 'inactive market updates must evict cache rows');
assert.strictEqual(registry.listActive().length, 0, 'inactive rows must never appear in listActive');
assert.strictEqual(registry.getActiveMintSet().has(MINT), false);
assert.strictEqual(registry.isActive(MINT), false);
assert.strictEqual(registry.getToken(MINT).is_active, 0, 'inactive metadata must remain readable');
assert.strictEqual(registry.cache.has(MINT), false, 'inactive metadata must not be cached');

fixture.setRow({ ...fixture.getRow(), is_active: 1 });
registry._refreshCachedRow(MINT, fixture.getRow());
assert.strictEqual(registry.isActive(MINT), true, 'active cache rows must remain visible on the hot path');

fixture.setRow({ ...fixture.getRow(), is_active: 0 });
registry.setPoolInfo(MINT, { poolAddress: '11111111111111111111111111111111' });
assert.strictEqual(registry.listActive().length, 0, 'pool updates must not resurrect inactive rows');

fixture.setRow({
  ...fixture.getRow(),
  is_active: 1,
  migration_time: Date.now() - 121 * 60_000,
});
registry._refreshCachedRow(MINT, fixture.getRow());
assert.strictEqual(registry.removeStaleByAge(120 * 60_000), 1);
assert.strictEqual(registry.listActive().length, 0, 'bulk AGE removal must reload the active cache');

registry.cache.set(MINT, { ...fixture.getRow(), is_active: 0 });
assert.strictEqual(registry.listActive().length, 0, 'defensive filtering must hide stale inactive cache rows');

console.log('TokenRegistry active-cache tests: PASS');
