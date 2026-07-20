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
    entryMode: 'BREADTH_BURST_V6',
    minVolume1mSol: 0,
    armWindowMs: 30_000,
    breadthMinUniqueBuyers1m: 0,
    breadthMinNewBuyers1m: 0,
    breadthMinBuyCount1m: 0,
    breadthMaxLargestBuyShare1m: 1,
    breadthMinUniqueBuyers5s: 4,
    breadthMaxAvgBuyPerWallet5sSol: Number.POSITIVE_INFINITY,
    breadthPreviousRatioMax5s: 0.8,
    breadthCurrentRatioMin5s: 0.8,
    breadthCurrentRatioMax5s: 1.0,
    breadthMinAccelerationFactor5s: 1.5,
    breadthMinPriceChange10sPct: -5,
    breadthMaxPriceChange10sPct: 6,
    breadthMaxPriceChange60sPct: 20,
    breadthMinConfirmations: 4,
    breadthCooldownMs: 60_000,
    breadthWarmupMs: 0,
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
  assert.strictEqual(armedView.mode, 'BREADTH_BURST_V6');
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
  assert.strictEqual(confirmingView.candidates[0].conditions.buyers5s, true);
  assert.strictEqual(confirmingView.candidates[0].conditions.supportScore, true);
  subject.handleSwap(event(8_200, 'BUY', 0.6, 1.04, 'buyer-e'));

  assert.strictEqual(signals.length, 1);
  assert.strictEqual(signals[0]._flow.entryV6.supportScore >= 4, true);
  assert.strictEqual(signals[0]._flow.s60.newUniqueBuyers, 5);
  assert.strictEqual(signals[0]._flow.entryV6.txAccelerationFactor5s >= 1.5, true);
  assert.strictEqual(signals[0].poolQuoteSol, null, 'entry must not repeat the watchlist pool filter');
  const signaledView = subject.getStrategyCandidates(10, BASE + 8_200);
  assert.strictEqual(signaledView.candidates[0].stage, 'signaled');
  assert.strictEqual(signaledView.summary.signaled, 1);

  const cancel = tracker({ breadthMinConfirmations: 0 });
  cancel.handleSwap(event(0, 'SELL', 1, 1.00, 'cancel-arm'));
  cancel.handleSwap(event(1_000, 'BUY', 1, 1.10, 'already-pumped'));
  assert.strictEqual(cancel.states.get(MINT).armedAt, BASE, 'a transient >6% 10s move must keep the arm open');
  assert.match(cancel.states.get(MINT).lastArmWaitReason, /10s price/);
  assert.strictEqual(cancel.states.get(MINT).triggerConfirmFirstTs, null);
  const waitingView = cancel.getStrategyCandidates(10, BASE + 1_000);
  assert.strictEqual(waitingView.candidates[0].stage, 'waiting');
  assert.match(waitingView.candidates[0].waitReason, /10s price/);

  cancel.handleSwap(event(11_001, 'BUY', 0.2, 1.10, 'price-recovered-a'));
  assert.strictEqual(cancel.states.get(MINT).lastArmWaitReason, null, 'price recovery must resume confirmation');
  assert.strictEqual(cancel.states.get(MINT).triggerConfirmFirstTs, BASE + 11_001);
  cancel.handleSwap(event(12_101, 'BUY', 0.2, 1.10, 'price-recovered-b'));
  assert.strictEqual(cancel.states.get(MINT).lastV5SignalTs, BASE + 12_101);

  const breadthGate = tracker({ breadthMinUniqueBuyers1m: 3, breadthMinNewBuyers1m: 3 });
  breadthGate.handleSwap(event(0, 'BUY', 1, 1.00, 'breadth-a'));
  breadthGate.handleSwap(event(500, 'BUY', 1, 1.00, 'breadth-b'));
  assert.strictEqual(breadthGate.states.get(MINT).armedAt, null, 'two buyers must not pass a three-buyer core gate');
  breadthGate.handleSwap(event(1_000, 'BUY', 1, 1.00, 'breadth-c'));
  assert.strictEqual(breadthGate.states.get(MINT).armedAt, BASE + 1_000, 'three new buyers must arm');

  const repeatBuyer = tracker({ breadthMinUniqueBuyers1m: 2, breadthMinNewBuyers1m: 2 });
  repeatBuyer.handleSwap(event(0, 'BUY', 1, 1.00, 'same-wallet'));
  repeatBuyer.handleSwap(event(500, 'BUY', 1, 1.00, 'same-wallet'));
  assert.strictEqual(repeatBuyer.states.get(MINT).armedAt, null, 'repeat buys from one wallet count once');
  repeatBuyer.handleSwap(event(1_000, 'BUY', 1, 1.00, 'second-wallet'));
  assert.strictEqual(repeatBuyer.states.get(MINT).armedAt, BASE + 1_000, 'a second new wallet must complete the gate');

  const concentratedBuy = tracker({
    breadthMinUniqueBuyers1m: 2,
    breadthMinNewBuyers1m: 2,
    breadthMaxAvgBuyPerWallet5sSol: 0.4,
  });
  concentratedBuy.handleSwap(event(0, 'BUY', 0.5, 1.00, 'avg-high-a'));
  concentratedBuy.handleSwap(event(500, 'BUY', 0.5, 1.00, 'avg-high-b'));
  assert.strictEqual(
    concentratedBuy.states.get(MINT).armedAt,
    null,
    '5s average buy above 0.4 SOL per unique buyer must block arming',
  );
  const concentratedView = concentratedBuy.getStrategyCandidates(10, BASE + 500);
  assert.strictEqual(concentratedView.candidates[0].conditions.avgBuyPerWallet5s, false);
  assert.strictEqual(concentratedView.thresholds.maxAvgBuyPerWallet5sSol, 0.4);

  const distributedBuy = tracker({
    breadthMinUniqueBuyers1m: 2,
    breadthMinNewBuyers1m: 2,
    breadthMaxAvgBuyPerWallet5sSol: 0.4,
  });
  distributedBuy.handleSwap(event(0, 'BUY', 0.3, 1.00, 'avg-low-a'));
  distributedBuy.handleSwap(event(500, 'BUY', 0.3, 1.00, 'avg-low-b'));
  assert.strictEqual(
    distributedBuy.states.get(MINT).armedAt,
    BASE + 500,
    'distributed 5s buying at or below 0.4 SOL per wallet may arm',
  );

  const avgBuyWait = tracker({
    breadthMaxAvgBuyPerWallet5sSol: 0.4,
    breadthMinConfirmations: 0,
  });
  avgBuyWait.handleSwap(event(0, 'BUY', 0.3, 1.00, 'avg-wait-arm'));
  avgBuyWait.handleSwap(event(1_000, 'BUY', 1.0, 1.00, 'avg-wait-spike'));
  assert.strictEqual(avgBuyWait.states.get(MINT).armedAt, BASE, 'a transient large buy must not cancel the arm');
  assert.match(avgBuyWait.states.get(MINT).lastArmWaitReason, /avg buy\/wallet/);
  assert.strictEqual(avgBuyWait.states.get(MINT).triggerConfirmFirstTs, null);
  avgBuyWait.handleSwap(event(6_100, 'BUY', 0.2, 1.00, 'avg-wait-recover-a'));
  assert.strictEqual(avgBuyWait.states.get(MINT).lastArmWaitReason, null);
  assert.strictEqual(avgBuyWait.states.get(MINT).triggerConfirmFirstTs, BASE + 6_100);
  avgBuyWait.handleSwap(event(7_200, 'BUY', 0.2, 1.00, 'avg-wait-recover-b'));
  assert.strictEqual(avgBuyWait.states.get(MINT).lastV5SignalTs, BASE + 7_200);

  const volumeGate = tracker({ minVolume1mSol: 10, minVolume1mUsd: 3_000 });
  volumeGate.handleSwap(event(0, 'BUY', 1, 1.00, 'volume-gate'));
  const volumeView = volumeGate.getStrategyCandidates(10, BASE);
  assert.strictEqual(volumeView.thresholds.volume1mUsd, 3_000);
  assert.strictEqual(volumeView.candidates[0].conditions.volume1m, false);
  assert.strictEqual(volumeView.candidates[0].stage, 'monitoring');

  const legacyMode = tracker({ entryMode: 'ACTIVITY_BURST_V5' });
  assert.strictEqual(legacyMode.entryMode, 'BREADTH_BURST_V6', 'production V5 env must activate V6 rules');

  const antiChase = tracker({ armWindowMs: 120_000 });
  antiChase.handleSwap(event(0, 'SELL', 1, 1.00, 'anti-chase-arm'));
  antiChase.handleSwap(event(50_000, 'BUY', 1, 1.25, 'anti-chase-pump'));
  assert.strictEqual(antiChase.states.get(MINT).armedAt, null, 'a >20% rolling 60s pump must cancel entry');
  assert.match(antiChase.states.get(MINT).lastArmCancelReason, /60s price/);
  const antiChaseView = antiChase.getStrategyCandidates(10, BASE + 50_000);
  assert.strictEqual(antiChaseView.candidates[0].conditions.price60s, false);

  const warmup = tracker({ breadthWarmupMs: 60_000 });
  warmup.handleSwap(event(0, 'BUY', 1, 1.00, 'warmup-a'));
  assert.strictEqual(warmup.states.get(MINT).armedAt, null, 'restart warmup must block early signals');
  warmup.handleSwap(event(60_000, 'BUY', 1, 1.00, 'warmup-b'));
  assert.strictEqual(warmup.states.get(MINT).armedAt, BASE + 60_000, 'strategy may arm after one rolling minute');

  const rolling = tracker();
  rolling.handleSwap(event(0, 'BUY', 1, 1.00, 'returning-wallet'));
  rolling.handleSwap(event(60_001, 'BUY', 1, 1.00, 'returning-wallet'));
  const rollingStats = rolling._stats(rolling.states.get(MINT), BASE + 60_001, 60_000);
  assert.strictEqual(rollingStats.buyCount, 1, 'events older than 60 seconds must leave the rolling window');
  assert.strictEqual(rollingStats.uniqueBuyers, 1, 'a returning wallet is still an active buyer');
  assert.strictEqual(rollingStats.newUniqueBuyers, 0, 'a returning wallet must not become new again');
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
  assert.strictEqual(config.activityFlow.entryMode, 'BREADTH_BURST_V6');
  assert.strictEqual(config.activityFlow.breadthMinUniqueBuyers1m, 100);
  assert.strictEqual(config.activityFlow.breadthMinNewBuyers1m, 40);
  assert.strictEqual(config.activityFlow.breadthMaxAvgBuyPerWallet5sSol, 0.4);
  assert.strictEqual(config.activityFlow.breadthMaxPriceChange60sPct, 20);
  assert.strictEqual(config.activityFlow.breadthMinConfirmations, 3);
  assert.strictEqual(config.activityFlow.breadthCooldownMs, 60_000);
  assert.strictEqual(config.activityFlow.breadthWarmupMs, 60_000);
}

runEntryTests();
runExitTests();
runSlippageTests();
console.log('Strategy V6 tests: PASS');
process.exit(0);

