'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const OrderFlowTracker = require('../src/core/OrderFlowTracker');
const { config } = require('../src/config');
Module._load = originalLoad;

const BASE = Date.now();

function event(mint, offsetMs, {
  side = 'BUY',
  wallet = `wallet-${offsetMs}`,
  price,
  priceBefore = price,
  solVolume = 1,
  poolQuoteAfter = 100,
} = {}) {
  return {
    mint,
    symbol: 'OLDTEST',
    signer: wallet,
    side,
    solVolume,
    price,
    priceBefore,
    priceChangePct: ((price - priceBefore) / priceBefore) * 100,
    poolQuoteAfter,
    ts: BASE + offsetMs,
    slot: 1000 + offsetMs,
    signature: `${mint}-${offsetMs}-${wallet}`,
    featureEligible: true,
  };
}

function tracker(overrides = {}) {
  return new OrderFlowTracker({
    entryMode: 'OLD_COIN_PULLBACK_V10',
    oldCoinWindowMs: 10_000,
    oldCoinMinDropPct: 5,
    oldCoinPriorityDropPct: 15,
    oldCoinMaxDropPct: 20,
    oldCoinMinRecoveryPct: 2,
    oldCoinMaxRecoveryPct: 5,
    oldCoinMinTrades10s: 2,
    oldCoinMaxLpDrop10sPct: 5,
    oldCoinSignalCooldownMs: 10_000,
    maxSignalAgeMs: 0,
    ...overrides,
  });
}

function signals(subject) {
  const rows = [];
  subject.on('flowReversalSignal', (signal) => rows.push(signal));
  return rows;
}

function replay(subject, mint, dropPrice, recoveryPrice, options = {}) {
  subject.handleSwap(event(mint, 0, { price: 1, wallet: 'pre-buyer' }));
  subject.handleSwap(event(mint, 100, {
    side: 'SELL',
    wallet: 'driving-seller',
    priceBefore: 1,
    price: dropPrice,
    solVolume: 10,
    poolQuoteAfter: 100,
  }));
  for (const extra of options.extra || []) subject.handleSwap(event(mint, ...extra));
  subject.handleSwap(event(mint, 300, {
    side: 'BUY',
    wallet: options.confirmingWallet || 'confirming-buyer',
    price: recoveryPrice,
    solVolume: 2,
    poolQuoteAfter: options.finalPoolQuote ?? 99,
  }));
}

assert.strictEqual(config.strategy.exitMode, 'OLD_COIN_PULLBACK_V10');
assert.strictEqual(config.strategy.minMintAgeHours, 48);
assert.strictEqual(config.strategy.maxTokenAgeMs, 0);
assert.strictEqual(config.strategy.fixedStopLossPct, 0);
assert.strictEqual(config.strategy.trailingActivatePct, 10);
assert.strictEqual(config.strategy.trailingDrawdownPct, 5);
assert.strictEqual(config.strategy.maxHoldMs, 60 * 60_000);

const passing = tracker();
const passingSignals = signals(passing);
replay(passing, 'old-pass', 0.82, 0.84);
assert.strictEqual(passingSignals.length, 1, 'an 18% sell drop with a 2-5% recovery must signal');
assert.strictEqual(passingSignals[0]._oldCoinPullbackEntry, true);
assert.strictEqual(passingSignals[0]._flow.entryOldCoin.priority, true);
assert.strictEqual(passingSignals[0]._flow.entryOldCoin.confirmingBuyerCount, 1);
const panel = passing.getStrategyCandidates(10, BASE + 300);
assert.strictEqual(panel.mode, 'OLD_COIN_PULLBACK_V10');
assert.strictEqual(panel.thresholds.oldCoinMinDropPct, 5);
assert.strictEqual(panel.thresholds.oldCoinMaxRecoveryPct, 5);
assert.strictEqual(panel.candidates[0].stage, 'signaled');
assert.strictEqual(panel.candidates[0].trigger.priority, true);

const waterfall = tracker();
const waterfallSignals = signals(waterfall);
replay(waterfall, 'old-waterfall', 0.79, 0.81);
assert.strictEqual(waterfallSignals.length, 0, 'a pullback deeper than 20% must be rejected');

const sameWallet = tracker();
const sameWalletSignals = signals(sameWallet);
replay(sameWallet, 'old-same-wallet', 0.9, 0.92, { confirmingWallet: 'driving-seller' });
assert.strictEqual(sameWalletSignals.length, 0, 'the confirming BUY must come from another wallet');

const sellerPressure = tracker();
const sellerPressureSignals = signals(sellerPressure);
replay(sellerPressure, 'old-seller-pressure', 0.85, 0.88, {
  extra: [[200, {
    side: 'SELL',
    wallet: 'later-seller',
    priceBefore: 0.85,
    price: 0.86,
    solVolume: 11,
    poolQuoteAfter: 100,
  }]],
});
assert.strictEqual(sellerPressureSignals.length, 0, 'seller pressure that grows after the low must reject');

const unstablePool = tracker();
const unstablePoolSignals = signals(unstablePool);
replay(unstablePool, 'old-pool-drop', 0.9, 0.92, { finalPoolQuote: 90 });
assert.strictEqual(unstablePoolSignals.length, 0, 'a pool depth drop over 5% must reject');

console.log('Old-coin pullback V10 tests: PASS');
