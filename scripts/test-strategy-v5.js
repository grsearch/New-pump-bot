'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const OrderFlowTracker = require('../src/core/OrderFlowTracker');
const PositionManager = require('../src/core/PositionManager');
const { estimateBuySlippagePct } = require('../src/core/ExecutionMath');
const { config } = require('../src/config');
Module._load = originalLoad;

const BASE = 1_800_000_000_000;
const MINT = 'TestMint111111111111111111111111111111111';

function event(offsetMs, side, solVolume, price, suffix, poolQuoteAfter = null) {
  return {
    mint: MINT,
    symbol: 'TEST',
    signer: `${side}-${suffix}`,
    side,
    solVolume,
    price,
    priceBefore: price,
    priceChangePct: 0,
    ts: BASE + offsetMs,
    slot: Math.floor((BASE + offsetMs) / 400),
    signature: `sig-${offsetMs}-${suffix}`,
    poolQuoteAfter,
  };
}

function tracker(overrides = {}) {
  return new OrderFlowTracker({
    entryMode: 'ACTIVITY_BURST_V5',
    minVolume1mSol: 0,
    minTrades1m: 0,
    armWindowMs: 30_000,
    armCancelMinVolume1mSol: 0,
    armMinUniqueTraders1m: 0,
    armMaxLargestBuyShare1m: 1,
    armCancelMaxLargestBuyShare1m: 1,
    armMinVolatility1mPct: 0,
    triggerMinVolume5sSol: 2,
    triggerMinTrades5s: 4,
    triggerMinUniqueBuyers5s: 2,
    triggerMinTxAcceleration5s: 2,
    triggerMinRange5sPct: 1,
    triggerMinPriceChange10sPct: 0,
    triggerMaxPriceChange10sPct: 6,
    triggerConfirmMinGapMs: 1_000,
    triggerConfirmMaxGapMs: 3_000,
    maxSignalAgeMs: 0,
    cooldownMs: 0,
    ...overrides,
  });
}

function runEntryTests() {
  const subject = tracker();
  const signals = [];
  subject.on('flowReversalSignal', (signal) => signals.push(signal));

  subject.handleSwap(event(0, 'SELL', 1, 1.00, 'prior-a'));
  assert.strictEqual(signals.length, 0, 'arming must not buy immediately');
  assert.strictEqual(subject.states.get(MINT).armedAt, BASE);
  const armedView = subject.getStrategyCandidates(10, BASE);
  assert.strictEqual(armedView.mode, 'ACTIVITY_BURST_V5');
  assert.strictEqual(armedView.candidates.length, 1);
  assert.strictEqual(armedView.candidates[0].stage, 'armed');
  assert.strictEqual(armedView.candidates[0].conditions.volume1m, true);
  assert.strictEqual(armedView.candidates[0].s60.volumeUsd, 72);

  subject.handleSwap(event(1_000, 'SELL', 1, 1.00, 'prior-b'));
  subject.handleSwap(event(5_500, 'BUY', 0.6, 1.01, 'buyer-a'));
  subject.handleSwap(event(6_000, 'BUY', 0.6, 1.02, 'buyer-b'));
  subject.handleSwap(event(6_500, 'BUY', 0.6, 1.03, 'buyer-c'));
  subject.handleSwap(event(7_100, 'BUY', 0.6, 1.04, 'buyer-d'));
  assert.strictEqual(signals.length, 0, 'the first qualifying observation must only start confirmation');
  const confirmingView = subject.getStrategyCandidates(10, BASE + 7_100);
  assert.strictEqual(confirmingView.candidates[0].stage, 'confirming');
  assert.strictEqual(confirmingView.candidates[0].conditions.netTurn5s, true);
  subject.handleSwap(event(8_200, 'BUY', 0.6, 1.04, 'buyer-e'));

  assert.strictEqual(signals.length, 1);
  assert.strictEqual(signals[0]._flow.entryV5.previousNet5s < 0, true);
  assert.strictEqual(signals[0]._flow.entryV5.currentNet5s > 0, true);
  assert.strictEqual(signals[0]._flow.entryV5.txAcceleration5s >= 2, true);
  assert.strictEqual(signals[0].poolQuoteSol, null, 'entry must not repeat the watchlist pool filter');
  const signaledView = subject.getStrategyCandidates(10, BASE + 8_200);
  assert.strictEqual(signaledView.candidates[0].stage, 'signaled');
  assert.strictEqual(signaledView.summary.signaled, 1);

  const cancel = tracker();
  cancel.handleSwap(event(0, 'SELL', 1, 1.00, 'cancel-arm'));
  cancel.handleSwap(event(1_000, 'BUY', 1, 1.10, 'already-pumped'));
  assert.strictEqual(cancel.states.get(MINT).armedAt, null, 'a >6% 10s move must cancel arming');

  const concentration = tracker({ armMaxLargestBuyShare1m: 0.25 });
  concentration.handleSwap(event(0, 'BUY', 1, 1.00, 'share-a'));
  concentration.handleSwap(event(500, 'BUY', 1, 1.00, 'share-b'));
  concentration.handleSwap(event(1_000, 'BUY', 1, 1.00, 'share-c'));
  assert.strictEqual(concentration.states.get(MINT).armedAt, null, 'a largest buy above 25% must not arm');
  const concentrationView = concentration.getStrategyCandidates(10, BASE + 1_000);
  assert.strictEqual(concentrationView.candidates[0].conditions.largestBuy1m, false);
  assert.strictEqual(concentrationView.candidates[0].stage, 'monitoring');
  concentration.handleSwap(event(1_500, 'BUY', 1, 1.00, 'share-d'));
  assert.strictEqual(concentration.states.get(MINT).armedAt, BASE + 1_500, '25% largest buy share may arm');

  const volumeGate = tracker({ minVolume1mSol: 10, minVolume1mUsd: 3_000 });
  volumeGate.handleSwap(event(0, 'BUY', 1, 1.00, 'volume-gate'));
  const volumeView = volumeGate.getStrategyCandidates(10, BASE);
  assert.strictEqual(volumeView.thresholds.volume1mUsd, 3_000);
  assert.strictEqual(volumeView.candidates[0].conditions.volume1m, false);
  assert.strictEqual(volumeView.candidates[0].stage, 'monitoring');
}

function runExitTests() {
  const now = Date.now();
  const manager = Object.create(PositionManager.prototype);
  manager.positions = new Map([["position-1", {
    positionId: 'position-1',
    mint: MINT,
    symbol: 'TEST',
    entryPrice: 1,
    highWaterMark: 1.04,
    openedAt: now - 91_000,
    reconciled: true,
    dryRun: false,
    exiting: false,
  }]]);
  manager._flowExitEvents = new Map([[MINT, [
    { ts: now - 2_000, side: 'SELL', solVolume: 1 },
  ]]]);
  manager.priceTracker = { getPrice: () => 0.99 };
  manager._fillPreVolFallback = () => {};
  manager._tickCount = 0;
  manager._exitCalls = [];
  manager._exitForCondition = function exitForCondition(pos, price, reason) {
    pos.exiting = true;
    this._exitCalls.push({ pos, price, reason });
  };
  manager._tick();
  assert.strictEqual(manager._exitCalls.length, 1);
  assert.strictEqual(manager._exitCalls[0].reason, 'NO_BOUNCE_EXIT');

  const timeout = Object.create(PositionManager.prototype);
  timeout.positions = new Map([["position-2", {
    positionId: 'position-2',
    mint: MINT,
    symbol: 'TEST',
    entryPrice: 1,
    highWaterMark: 1.10,
    openedAt: now - 181_000,
    reconciled: true,
    dryRun: false,
    exiting: false,
  }]]);
  timeout._flowExitEvents = new Map();
  timeout.priceTracker = { getPrice: () => 1.05 };
  timeout._fillPreVolFallback = () => {};
  timeout._tickCount = 0;
  timeout._exitCalls = [];
  timeout._exitForCondition = manager._exitForCondition;
  timeout._tick();
  assert.strictEqual(timeout._exitCalls.length, 1);
  assert.strictEqual(timeout._exitCalls[0].reason, 'TIMEOUT_3M');
}

function runSlippageTests() {
  const state = {
    poolBaseAmount: 1_000_000_000_000n,
    poolQuoteAmount: 100_000_000_000n,
  };
  assert.strictEqual(estimateBuySlippagePct(state, 1, 10_000, 6), 0);
  const fivePct = estimateBuySlippagePct(state, 1, 1 / 0.000105, 6);
  assert(Math.abs(fivePct - 5) < 1e-9);
  assert(estimateBuySlippagePct(state, 1, 9_000, 6) > 5);
  assert.strictEqual(config.strategy.buySlippageBps, 500);
  assert.strictEqual(config.strategy.buyMaxEstimatedSlippagePct, 5);
  assert.strictEqual(config.strategy.noBounceExitMs, 90_000);
  assert.strictEqual(config.strategy.maxHoldMs, 180_000);
  assert.strictEqual(config.activityFlow.minPoolQuoteSol, undefined);
}

runEntryTests();
runExitTests();
runSlippageTests();
console.log('Strategy V5 tests: PASS');
process.exit(0);
