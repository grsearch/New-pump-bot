'use strict';

process.env.ACTIVITY_FLOW_FORCE_DISABLED = 'false';
process.env.ACTIVITY_FLOW_ENABLED = 'false';
process.env.ACTIVITY_FLOW_REPLACE_DUMP_SIGNAL = 'false';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const OrderFlowTracker = require('../src/core/OrderFlowTracker');
const SignalEngine = require('../src/core/SignalEngine');
const { config } = require('../src/config');
Module._load = originalLoad;

const BASE = 1_800_000_000_000;
const MINT = 'Age3TestMint1111111111111111111111111111111';
const PRICE_PASS = 6e-7;

function tokenRegistry() {
  return {
    getToken: () => ({ migration_time: BASE }),
  };
}

function event(offsetMs, wallet, price = PRICE_PASS, side = 'BUY') {
  return {
    mint: MINT,
    symbol: 'AGE3',
    signer: wallet,
    side,
    solVolume: 0.001,
    price,
    priceBefore: price,
    priceChangePct: 0,
    ts: BASE + offsetMs,
    slot: Math.floor((BASE + offsetMs) / 400),
    signature: `sig-${offsetMs}-${wallet}`,
  };
}

function tracker(overrides = {}) {
  return new OrderFlowTracker({
    entryMode: 'AGE3_BREADTH_V7',
    tokenRegistry: tokenRegistry(),
    solPriceUsd: 72,
    age3EntryTargetMs: 180_000,
    age3EntryToleranceMs: 15_000,
    age3MinFdvUsd: 40_000,
    age3MinUniqueBuyers1m: 17,
    age3TokenSupply: 1_000_000_000,
    maxSignalAgeMs: 0,
    cooldownMs: 0,
    ...overrides,
  });
}

function seedBuyers(subject, count, firstOffset = 125_000, price = PRICE_PASS) {
  for (let i = 0; i < count; i += 1) {
    subject.handleSwap(event(firstOffset + (i * 3_000), `wallet-${i}`, price));
  }
}

async function run() {
  assert.strictEqual(config.activityFlow.entryMode, 'AGE3_BREADTH_V7');
  assert.strictEqual(config.activityFlow.enabled, true, 'V7 must run live unless the emergency kill switch is set');
  assert.strictEqual(config.activityFlow.replaceDumpSignal, true, 'V7 must suppress legacy dump entries');
  assert.strictEqual(config.strategy.exitMode, 'AGE3_TRAILING_V7');

  const subject = tracker();
  const signals = [];
  subject.on('flowReversalSignal', (signal) => signals.push(signal));
  seedBuyers(subject, 16);
  assert.strictEqual(signals.length, 0, 'V7 must not buy before absolute migration AGE 3m');

  subject.handleSwap(event(180_000, 'wallet-16'));
  assert.strictEqual(signals.length, 1, 'V7 should buy once when AGE, FDV and buyer breadth pass');
  assert.strictEqual(signals[0]._age3Entry, true);
  assert.strictEqual(signals[0]._flow.entryAge3.uniqueBuyers1m, 17);
  assert(signals[0]._flow.entryAge3.fdvUsd >= 40_000);
  assert(
    signals[0]._flow.s60.volumeSol < 0.1,
    'V7 entry must not silently retain the old volume threshold',
  );

  subject.handleSwap(event(181_000, 'wallet-17'));
  assert.strictEqual(signals.length, 1, 'the AGE3 decision must be one-shot per process');
  const view = subject.getStrategyCandidates(10, BASE + 181_000);
  assert.strictEqual(view.candidates[0].stage, 'signaled');
  assert.strictEqual(view.summary.signaled, 1);
  assert.strictEqual(view.thresholds.age3TargetMs, 180_000);

  const lowFdv = tracker();
  const lowFdvSignals = [];
  lowFdv.on('flowReversalSignal', (signal) => lowFdvSignals.push(signal));
  seedBuyers(lowFdv, 16, 125_000, 2e-7);
  lowFdv.handleSwap(event(180_000, 'wallet-16', 2e-7));
  lowFdv.handleSwap(event(181_000, 'wallet-17', PRICE_PASS));
  assert.strictEqual(lowFdvSignals.length, 0);
  assert.strictEqual(lowFdv.states.get(MINT).age3Decision, 'fdv_below_min');

  const lowBreadth = tracker();
  const lowBreadthSignals = [];
  lowBreadth.on('flowReversalSignal', (signal) => lowBreadthSignals.push(signal));
  seedBuyers(lowBreadth, 5, 165_000);
  lowBreadth.handleSwap(event(180_000, 'wallet-final'));
  seedBuyers(lowBreadth, 20, 181_000);
  assert.strictEqual(lowBreadthSignals.length, 0);
  assert.strictEqual(lowBreadth.states.get(MINT).age3Decision, 'buyers_below_min');

  const missed = tracker();
  const missedSignals = [];
  missed.on('flowReversalSignal', (signal) => missedSignals.push(signal));
  missed.handleSwap(event(196_000, 'late-wallet'));
  assert.strictEqual(missedSignals.length, 0);
  assert.strictEqual(missed.states.get(MINT).age3Decision, 'missed_window');

  let successfulBuyExists = false;
  const acceptedSignals = [];
  const engine = new SignalEngine({
    tradeLogger: {
      getRecentAcceptedSellerTxs: () => [],
      loadRecentPriceSamples: () => new Map(),
      hasSuccessfulBuyForMint: () => successfulBuyExists,
      logSignal: () => {},
    },
    positionManager: {
      openPositionCount: () => 0,
      hasOpenPosition: () => false,
    },
  });
  engine.on('buyOrder', (signal) => acceptedSignals.push(signal));

  await engine.handleDumpSignal(signals[0]);
  assert.strictEqual(acceptedSignals.length, 1, 'AGE3 signal must bypass all legacy dump/V6 filters');
  engine.markBuyDone(MINT);
  successfulBuyExists = true;
  await engine.handleDumpSignal({ ...signals[0], signature: 'second-signal' });
  assert.strictEqual(acceptedSignals.length, 1, 'a successful historical BUY must block the mint forever');
  engine.shutdown();

  console.log('Strategy V7 AGE3 breadth tests: PASS');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
