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
assert.strictEqual(config.strategy.oldCoinFastExitPnlPct, -5);

{
  const now = Date.now();
  const pos = position(now, 4_000, { _lastNewLowAt: now - 250 });
  const manager = makeManager(pos, 0.94, [{
    side: 'SELL', price: 0.94, solVolume: 2, ts: now - 100,
  }]);
  assert.strictEqual(manager._maybeOldCoinStagedExit(pos, now), true);
  assert.strictEqual(manager.exits[0].reason, 'WRONG_ENTRY_3S');
}

{
  const now = Date.now();
  const pos = position(now, 16_000, {
    highWaterMark: 1.019,
    _maxObservedNetFlow: -0.1,
  });
  const manager = makeManager(pos, 0.99, []);
  assert.strictEqual(manager._maybeOldCoinStagedExit(pos, now), true);
  assert.strictEqual(manager.exits[0].reason, 'NO_BOUNCE_15S');
}

{
  const now = Date.now();
  const pos = position(now, 61_000, {
    highWaterMark: 1.049,
    _oldCoin15sChecked: true,
    _maxObservedNetFlow: 1,
  });
  const manager = makeManager(pos, 1.01, []);
  assert.strictEqual(manager._maybeOldCoinStagedExit(pos, now), true);
  assert.strictEqual(manager.exits[0].reason, 'WEAK_BOUNCE_60S');
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

console.log('Old-coin staged exit tests: PASS');
process.exit(0);
