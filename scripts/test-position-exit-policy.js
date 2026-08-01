'use strict';

process.env.RSI_1M_EXIT_ENABLED = 'false';
process.env.RSI_1M_EXIT_THRESHOLD = '80';
process.env.ACTIVITY_FLOW_RSI_1M_MIN_BARS = '8';
process.env.FIXED_STOP_LOSS_PCT = '-20';
process.env.EMERGENCY_STOP_LOSS_PCT = '-15';
process.env.RANGE_STOP_ENABLED = '1';
process.env.TREND_STOP_ENABLED = '1';
process.env.TIMED_TP_ENABLED = '1';
process.env.EARLY_LOW_PEAK_CUT_ENABLED = '1';
process.env.TRAILING_ACTIVATE_PCT = '50';
process.env.TRAILING_DRAWDOWN_PCT = '10';
process.env.MAX_HOLD_MS = '0';
process.env.POSITION_FDV_EXIT_USD = '20000';
process.env.MAX_MINT_AGE_MINUTES = '120';
process.env.REBUY_COOLDOWN_MS = '300000';

const assert = require('assert');
const Module = require('module');

// This policy test does not need dotenv; stub it so the test also runs in a
// dependency-light checkout used by CI/static validation.
const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const PositionManager = require('../src/core/PositionManager');
const { config } = require('../src/config');
Module._load = originalLoad;

function position(id, mint, overrides = {}) {
  return {
    positionId: id,
    mint,
    symbol: 'TEST',
    reconciled: true,
    dryRun: false,
    stabilizing: false,
    trailingArmed: false,
    exiting: false,
    status: 'open',
    ...overrides,
  };
}

function managerWith(...positions) {
  const manager = Object.create(PositionManager.prototype);
  manager.positions = new Map();
  manager.byMint = new Map();
  manager._rsiExitSkipLogAt = new Map();
  manager._exitCalls = [];
  manager._exit = function mockExit(pos, price, reason) {
    if (pos.exiting) return;
    pos.exiting = true;
    pos.exitReason = reason;
    this._exitCalls.push({ id: pos.positionId, price, reason });
  };

  for (const pos of positions) {
    manager.positions.set(pos.positionId, pos);
    if (!manager.byMint.has(pos.mint)) manager.byMint.set(pos.mint, new Set());
    manager.byMint.get(pos.mint).add(pos.positionId);
  }
  return manager;
}

function rsiSnapshot(live, overrides = {}) {
  return {
    rsi1mLive: live,
    rsi1mClosed: 75,
    rsi1mClosedBars: 8,
    ...overrides,
  };
}

function run() {
  const mint = 'TestMint111111111111111111111111111111111';
  // This suite covers the retained V9 exit implementation. Pin its policy
  // explicitly so live V10 defaults do not turn a regression test into a
  // stale configuration assertion.
  Object.assign(config.strategy, {
    rebuyCooldownMs: 60_000,
    exitMode: 'DUMP_BACKRUN_V9',
    trailingActivatePct: 10,
    trailingDrawdownPct: 3,
    takeProfitPct: 0,
    fixedStopLossPct: -15,
    emergencyStopLossPct: 0,
    maxHoldMs: 20_000,
    maxTokenAgeMs: 0,
    positionFdvExitUsd: 0,
    dumpBackrunRugExitMaxPnlPct: -10,
    dumpBackrunNoBounceAgeMs: 5_000,
    dumpBackrunNoBounceMaxMfePct: 2,
    dumpBackrunNoBounceMaxPnlPct: -3,
    sellSlippageBps: 500,
    emergencySellSlippageBps: 5_000,
  });
  assert.strictEqual(config.strategy.rebuyCooldownMs, 60_000, 'V9 fixture cooldown must be 60 seconds');
  assert.strictEqual(config.strategy.exitMode, 'DUMP_BACKRUN_V9');
  assert.strictEqual(config.strategy.trailingActivatePct, 10);
  assert.strictEqual(config.strategy.trailingDrawdownPct, 3);
  assert.strictEqual(config.strategy.takeProfitPct, 0);
  assert.strictEqual(config.strategy.fixedStopLossPct, -15);
  assert.strictEqual(config.strategy.emergencyStopLossPct, 0);
  assert.strictEqual(config.strategy.maxHoldMs, 20_000);
  assert.strictEqual(config.strategy.maxTokenAgeMs, 0);
  assert.strictEqual(config.strategy.positionFdvExitUsd, 0);
  assert.strictEqual(config.strategy.dumpBackrunRugExitMaxPnlPct, -10);
  assert.strictEqual(config.strategy.dumpBackrunNoBounceAgeMs, 5_000);
  assert.strictEqual(config.strategy.dumpBackrunNoBounceMaxMfePct, 2);
  assert.strictEqual(config.strategy.dumpBackrunNoBounceMaxPnlPct, -3);
  assert.strictEqual(config.strategy.sellSlippageBps, 500);
  assert.strictEqual(config.strategy.emergencySellSlippageBps, 5_000);

  {
    const manager = managerWith();
    const price = manager._priceFromState({
      poolBaseAmount: { toString: () => '100000000000000' },
      poolQuoteAmount: { toString: () => '135800000000' },
      pool: { virtualQuoteReserves: { toString: () => '17900000000' } },
    }, 6);
    assert(Math.abs(price - 1.537e-6) < 1e-15, 'position polling must include virtual reserves');
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1,
      openedAt: now,
      reconciledAt: now,
      stabilizing: true,
      _stabilizeSamples: [],
    });
    const manager = managerWith(first);
    manager._checkExit('p1', 0.85);
    assert.strictEqual(manager._exitCalls[0].reason, 'FIXED_STOP_LOSS');
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1,
      openedAt: now,
      reconciledAt: now,
      stabilizing: true,
      _stabilizeSamples: [],
    });
    const manager = managerWith(first);
    manager._checkExit('p1', 0.851);
    assert.strictEqual(manager._exitCalls.length, 0, 'a loss smaller than 15% must stay open');
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1.01,
      openedAt: now - 6_000,
      reconciledAt: now - 5_100,
    });
    const manager = managerWith(first);
    manager.priceTracker = { getPrice: () => 0.96 };
    manager.tokenRegistry = { getToken: () => null };
    manager._fillPreVolFallback = () => {};
    manager._tick();
    assert.strictEqual(manager._exitCalls[0].reason, 'NO_BOUNCE_5S');
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1.025,
      openedAt: now - 6_000,
      reconciledAt: now - 5_100,
    });
    const manager = managerWith(first);
    manager.priceTracker = { getPrice: () => 0.96 };
    manager.tokenRegistry = { getToken: () => null };
    manager._fillPreVolFallback = () => {};
    manager._tick();
    assert.strictEqual(
      manager._exitCalls.length,
      0,
      'a position that already achieved 2% MFE must not be cut by no-bounce',
    );
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1.01,
      openedAt: now - 5_000,
      reconciledAt: now - 4_900,
    });
    const manager = managerWith(first);
    manager.priceTracker = { getPrice: () => 0.96 };
    manager.tokenRegistry = { getToken: () => null };
    manager._fillPreVolFallback = () => {};
    manager._tick();
    assert.strictEqual(manager._exitCalls.length, 0, 'no-bounce must wait five seconds after reconcile');
  }

  {
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1,
      openedAt: Date.now() - 3_000,
    });
    const manager = managerWith(first);
    manager.priceTracker = { getPrice: () => 0.91 };
    assert.strictEqual(
      manager.handleDumpBackrunRugSignal({
        mint,
        priceAfter: 0.91,
        sellCount: 5,
        sellSol: 10,
      }),
      false,
    );
    assert.strictEqual(manager._exitCalls.length, 0, 'rug signal above -10% must not exit');
  }

  {
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1,
      openedAt: Date.now() - 3_000,
    });
    const manager = managerWith(first);
    manager.priceTracker = { getPrice: () => 0.89 };
    assert.strictEqual(
      manager.handleDumpBackrunRugSignal({
        mint,
        priceAfter: 0.89,
        sellCount: 5,
        sellSol: 10,
      }),
      true,
    );
    assert.strictEqual(manager._exitCalls[0].reason, 'RUG_PULL_EXIT');
  }

  {
    const manager = managerWith(position('p1', mint), position('p2', mint));
    assert.strictEqual(manager.handleRsiForExit(mint, 1, rsiSnapshot(95)), false);
    assert.strictEqual(manager._exitCalls.length, 0, 'RSI exit must stay disabled');
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1.1,
      openedAt: now - 10_000,
      reconciledAt: now - 10_000,
      trailingArmed: true,
      _armedHwm: 1.1,
      _armedHwmTs: now - 5_000,
    });
    const manager = managerWith(first);
    manager._checkExit('p1', 1.066);
    assert.strictEqual(manager._exitCalls.length, 1, '3% drawdown after +10% trailing arm should sell');
    assert.strictEqual(manager._exitCalls[0].reason, 'TRAILING_STOP');
  }

  {
    const now = Date.now();
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1,
      openedAt: now - 10_000,
      reconciledAt: now - 10_000,
    });
    const manager = managerWith(first);
    manager._checkExit('p1', 1.11);
    assert.strictEqual(manager._exitCalls.length, 0, 'fixed take profit must remain disabled');
    manager._checkExit('p1', 1.11);
    assert.strictEqual(first.trailingArmed, true, 'an 11% gain must arm the 10% trailing stop');
  }

  {
    const first = position('p1', mint, {
      entryPrice: 3e-7,
      highWaterMark: 3e-7,
      openedAt: Date.now(),
    });
    const manager = managerWith(first);
    manager._checkExit('p1', 2.7e-7);
    assert.strictEqual(manager._exitCalls.length, 0, 'V8 must not use an FDV floor exit');
  }

  {
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1,
      openedAt: Date.now(),
    });
    const manager = managerWith(first);
    manager.priceTracker = { getPrice: () => 0.9 };
    manager.tokenRegistry = {
      getToken: () => ({ migration_time: Date.now() - 7_200_100 }),
    };
    manager._fillPreVolFallback = () => {};
    manager._tick();
    assert.strictEqual(manager._exitCalls.length, 0, 'migration AGE must not force an exit');
    assert.strictEqual(first.removeAfterExit, undefined);
  }

  {
    const first = position('p1', mint, {
      entryPrice: 1,
      highWaterMark: 1.05,
      openedAt: Date.now() - 20_100,
    });
    const manager = managerWith(first);
    manager.priceTracker = { getPrice: () => 1.02 };
    manager.tokenRegistry = { getToken: () => null };
    manager._fillPreVolFallback = () => {};
    manager._tick();
    assert.strictEqual(manager._exitCalls[0].reason, 'TIMEOUT_20S');
  }

  {
    const first = position('p1', mint);
    const second = position('p2', mint);
    const manager = managerWith(first, second);
    manager._exitForCondition(second, 0.8, 'TRAILING_STOP');
    assert.deepStrictEqual(manager._exitCalls.map((x) => x.id), ['p1', 'p2']);
    assert(manager._exitCalls.every((x) => x.reason === 'TRAILING_STOP'));
  }

  {
    const first = position('p1', mint, {
      exiting: true,
      openedAt: 1,
      entryPrice: 1,
    });
    const manager = managerWith(first);
    manager.priceTracker = { getPrice: () => 0.7 };
    assert.strictEqual(manager.canAddOn(mint).reason, 'addon_removed');
  }

  console.log('Position exit policy tests: PASS');
}

run();
process.exit(0);
