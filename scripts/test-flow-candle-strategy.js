'use strict';

const assert = require('assert');
const Module = require('module');
const {
  buildClosedCandles,
  evaluateFlowAccelerationEntry,
  evaluateFlowTurnExit,
} = require('../src/core/FlowCandleStrategy');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const OrderFlowTracker = require('../src/core/OrderFlowTracker');
const PositionManager = require('../src/core/PositionManager');
const { config } = require('../src/config');
Module._load = originalLoad;

const FRAME_MS = 15_000;
const BASE = 1_800_000_000_000;

function event(ts, side, solVolume, price, suffix = '') {
  return {
    mint: 'TestMint111111111111111111111111111111111',
    symbol: 'TEST',
    signer: `${side}-${suffix || ts}`,
    side,
    solVolume,
    price,
    priceBefore: price,
    priceChangePct: 0,
    ts,
    slot: Math.floor(ts / 400),
    signature: `sig-${ts}-${side}-${suffix}`,
    poolQuoteAfter: 100,
  };
}

function candleEvents(bucketTs, open, close, buySol, sellSol) {
  return [
    event(bucketTs, 'BUY', buySol, open, 'open'),
    event(bucketTs + 10_000, 'SELL', sellSol, close, 'close'),
  ];
}

function run() {
  assert.strictEqual(config.activityFlow.minVolume1mUsd, 3000);
  assert.strictEqual(config.activityFlow.entryMode, 'FLOW_ACCEL_15S');
  assert.strictEqual(config.strategy.flowReversalExitEnabled, true);
  assert.strictEqual(config.strategy.flowReversalExitMode, 'FLOW_TURN_15S');

  const entryEvents = [
    ...candleEvents(BASE, 1.00, 0.95, 4, 2),
    ...candleEvents(BASE + FRAME_MS, 0.95, 0.90, 1, 6),
    ...candleEvents(BASE + 2 * FRAME_MS, 0.90, 0.85, 2, 4),
    ...candleEvents(BASE + 3 * FRAME_MS, 0.85, 0.80, 3, 2),
  ];
  const entryNow = BASE + 4 * FRAME_MS + 1_000;
  const entry = evaluateFlowAccelerationEntry(entryEvents, entryNow);
  assert.strictEqual(entry.matched, true);
  assert.deepStrictEqual(entry.candles.map((candle) => candle.netFlow), [2, -5, -2, 1]);
  assert.strictEqual(entry.previousAcceleration, -7);
  assert.strictEqual(entry.currentAcceleration, 3);
  assert.strictEqual(entry.latestAcceleration, 3);
  assert(
    entry.candles.every((candle) => candle.close < candle.open),
    'price direction must not be part of the entry rule',
  );

  const incomplete = evaluateFlowAccelerationEntry(entryEvents, BASE + 4 * FRAME_MS - 1);
  assert.strictEqual(incomplete.matched, false, 'the current unfinished 15s candle must not be used');

  const missingMiddle = entryEvents.filter((row) => (
    row.ts < BASE + FRAME_MS || row.ts >= BASE + 2 * FRAME_MS
  ));
  assert.strictEqual(
    buildClosedCandles(missingMiddle, entryNow, 4).length,
    0,
    'flow windows must be contiguous and non-empty',
  );

  const tracker = new OrderFlowTracker({
    entryMode: 'FLOW_ACCEL_15S',
    minVolume1mSol: 0,
    minTrades1m: 0,
    minPoolQuoteSol: 0,
    maxSignalAgeMs: 0,
    cooldownMs: 0,
  });
  const signals = [];
  tracker.on('flowReversalSignal', (signal) => signals.push(signal));
  for (const row of entryEvents) tracker.handleSwap(row);
  tracker.handleSwap(event(entryNow, 'SELL', 1, 0.79, 'trigger'));
  tracker.handleSwap(event(entryNow + 1_000, 'BUY', 1, 0.81, 'same-bucket'));
  assert.strictEqual(signals.length, 1, 'one completed candle set must emit at most one buy signal');
  assert.strictEqual(signals[0]._flow.entry15s.currentAcceleration, 3);
  assert.strictEqual(signals[0]._flow.entry15s.latestAcceleration, 3);

  const exitEvents = [
    ...candleEvents(BASE, 2.00, 2.10, 4, 1),
    ...candleEvents(BASE + FRAME_MS, 2.10, 2.20, 1, 4),
  ];
  const exitNow = BASE + 2 * FRAME_MS + 1_000;
  const exit = evaluateFlowTurnExit(exitEvents, exitNow, { sinceTs: BASE - 1 });
  assert.strictEqual(exit.matched, true);
  assert.strictEqual(exit.previousNetFlow, 3);
  assert.strictEqual(exit.currentNetFlow, -3);
  assert(
    exit.candles.every((candle) => candle.close > candle.open),
    'price direction must not be part of the exit rule',
  );
  assert.strictEqual(
    evaluateFlowTurnExit(exitEvents, exitNow, { sinceTs: BASE + 1 }).matched,
    false,
    'a partial entry candle must not count toward the two post-entry exit candles',
  );

  const manager = Object.create(PositionManager.prototype);
  manager._flowExitEvents = new Map([[event(0, 'BUY', 1, 1).mint, exitEvents]]);
  manager._exitCalls = [];
  manager._exitForCondition = function exitForCondition(pos, price, reason) {
    this._exitCalls.push({ pos, price, reason });
  };
  const pos = {
    mint: event(0, 'BUY', 1, 1).mint,
    symbol: 'TEST',
    entryPrice: 2,
    openedAt: BASE - 1,
    reconciledAt: BASE - 1,
    reconciled: true,
    dryRun: false,
    exiting: false,
    status: 'open',
  };
  manager._maybeFlowReversalExit(pos, 2.20, exitNow);
  assert.strictEqual(manager._exitCalls.length, 1);
  assert.strictEqual(manager._exitCalls[0].reason, 'FLOW_REVERSAL_EXIT');

  console.log('15s flow candle strategy tests: PASS');
}

run();
process.exit(0);
