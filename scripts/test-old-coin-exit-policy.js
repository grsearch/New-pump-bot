'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const PositionManager = require('../src/core/PositionManager');
const { config } = require('../src/config');
Module._load = originalLoad;

function makeManager(pos, price, events = []) {
  const manager = Object.create(PositionManager.prototype);
  manager.positions = new Map([[pos.positionId, pos]]);
  manager.byMint = new Map([[pos.mint, new Set([pos.positionId])]]);
  manager._flowExitEvents = new Map([[pos.mint, events]]);
  manager.priceTracker = { getPrice: () => price };
  manager.tokenRegistry = { getToken: () => null };
  manager._fillPreVolFallback = () => {};
  manager.exits = [];
  manager._exit = function mockExit(target, exitPrice, reason) {
    target.exiting = true;
    this.exits.push({ reason, exitPrice });
  };
  return manager;
}

function position(now, ageMs, overrides = {}) {
  return {
    positionId: `p-${ageMs}`,
    mint: 'OldExitMint111111111111111111111111111111',
    symbol: 'OLDX',
    entryPrice: 1,
    highWaterMark: 1,
    openedAt: now - ageMs,
    reconciledAt: now - ageMs,
    reconciled: true,
    dryRun: false,
    stabilizing: false,
    trailingArmed: false,
    exiting: false,
    status: 'open',
    ...overrides,
  };
}

assert.strictEqual(config.strategy.fixedStopLossPct, 0);
assert.strictEqual(config.strategy.takeProfitPct, 0);
assert.strictEqual(config.strategy.trailingActivatePct, 10);
assert.strictEqual(config.strategy.trailingDrawdownPct, 5);
assert.strictEqual(config.strategy.maxHoldMs, 30 * 60_000);
assert.strictEqual(config.strategy.noBounceExitEnabled, true);
assert.strictEqual(config.strategy.noBounceExitMs, 10 * 60_000);
assert.strictEqual(config.strategy.noBounceMaxPeakPnlPct, 3);
assert.strictEqual(config.strategy.noBounceMaxPnlPct, -3);
assert.strictEqual(config.strategy.noBounceFlowWindowMs, 30_000);
assert.strictEqual(config.strategy.oldCoinLpExitDropPct, 0);
assert.strictEqual(
  typeof PositionManager.prototype._maybeOldCoinStagedExit,
  'undefined',
  '3s/15s/60s staged exits must remain removed',
);

{
  const now = Date.now();
  const pos = position(now, 10_000);
  const manager = makeManager(pos, 0.99, [
    { side: 'BUY', price: 1, solVolume: 1, ts: now - 4_000, poolQuoteSol: 100 },
    { side: 'SELL', price: 0.99, solVolume: 1, ts: now - 100, poolQuoteSol: 89 },
  ]);
  manager._maybeOldCoinLpExit(pos, 0.99, now);
  assert.strictEqual(manager.exits.length, 0, 'LP depth changes must remain telemetry only');
  assert.strictEqual(pos.removeAfterExit, undefined);
}

{
  const now = Date.now();
  const pos = position(now, 10 * 60_000 + 1_000, { highWaterMark: 1.02 });
  const manager = makeManager(pos, 0.96, [
    { side: 'SELL', price: 0.96, solVolume: 2, ts: now - 1_000, poolQuoteSol: 100 },
  ]);
  manager._tick();
  assert.strictEqual(manager.exits[0].reason, 'NO_BOUNCE_EXIT');
}

{
  const now = Date.now();
  const pos = position(now, 10 * 60_000 + 1_000, { highWaterMark: 1.02 });
  const manager = makeManager(pos, 0.98, [
    { side: 'SELL', price: 0.98, solVolume: 2, ts: now - 1_000, poolQuoteSol: 100 },
  ]);
  manager._tick();
  assert.strictEqual(manager.exits.length, 0, 'PnL above -3% must not trigger no-bounce exit');
}

{
  const now = Date.now();
  const pos = position(now, 10 * 60_000 + 1_000, { highWaterMark: 1.04 });
  const manager = makeManager(pos, 0.96, [
    { side: 'SELL', price: 0.96, solVolume: 2, ts: now - 1_000, poolQuoteSol: 100 },
  ]);
  manager._tick();
  assert.strictEqual(manager.exits.length, 0, 'MFE at or above 3% must not trigger no-bounce exit');
}

{
  const now = Date.now();
  const pos = position(now, 10 * 60_000 + 1_000, { highWaterMark: 1.02 });
  const manager = makeManager(pos, 0.96, [
    { side: 'BUY', price: 0.96, solVolume: 2, ts: now - 1_000, poolQuoteSol: 100 },
  ]);
  manager._tick();
  assert.strictEqual(manager.exits.length, 0, 'positive net flow must not trigger no-bounce exit');
}

{
  const now = Date.now();
  const pos = position(now, 30 * 60_000 + 1_000, { highWaterMark: 1.04 });
  const manager = makeManager(pos, 1.01, []);
  manager._tick();
  assert.strictEqual(manager.exits[0].reason, 'TIMEOUT_30M');
}

{
  const now = Date.now();
  const pos = position(now, 10_000, {
    highWaterMark: 1.1,
    highWaterMarkTs: now - 2_000,
    trailingArmed: true,
    _armedHwm: 1.1,
    _armedHwmTs: now - 2_000,
  });
  const manager = makeManager(pos, 1.04, []);
  const originalGap = config.strategy.trailingExitConfirmMinGapMs;
  config.strategy.trailingExitConfirmMinGapMs = 0;
  manager._checkExit(pos.positionId, 1.04, { marketTs: now - 10 });
  assert.strictEqual(manager.exits.length, 0, 'one trailing event must not sell');
  manager._checkExit(pos.positionId, 1.04, { marketTs: now });
  config.strategy.trailingExitConfirmMinGapMs = originalGap;
  assert.strictEqual(manager.exits[0].reason, 'TRAILING_STOP');
}

console.log('Old-coin exit policy tests: PASS');
process.exit(0);
