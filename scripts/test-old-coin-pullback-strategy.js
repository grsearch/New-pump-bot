'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
process.env.OLD_COIN_PULLBACK_RUNUP_LOOKBACK_MS = '30000';
process.env.OLD_COIN_PULLBACK_MIN_PRE_PEAK_CONTEXT_MS = '5000';
process.env.OLD_COIN_PULLBACK_MIN_DRIVING_SELL_SOL = '2.5';
process.env.OLD_COIN_PULLBACK_MIN_CONFIRMING_BUYERS = '1';
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
    tokenRegistry: {
      getToken: () => ({
        migration_time: BASE - (72 * 60 * 60_000),
        fdv: 125_000,
        liquidity: 25_000,
      }),
    },
    entryMode: 'OLD_COIN_PULLBACK_V10',
    oldCoinWindowMs: 10_000,
    oldCoinMinDropPct: 5,
    oldCoinPriorityDropPct: 15,
    oldCoinMaxDropPct: 20,
    oldCoinMinRecoveryPct: 2,
    oldCoinMaxRecoveryPct: 5,
    oldCoinRunupLookbackMs: 60_000,
    oldCoinMinPrePeakContextMs: 30_000,
    oldCoinMaxNetGain10sPct: 5,
    oldCoinMaxPrePeakRunupPct: 15,
    oldCoinMinDrivingSellSol: 5,
    oldCoinMinCumulativeSellSol: 5,
    oldCoinMinCumulativeSellers: 2,
    oldCoinMinConfirmingBuyers: 2,
    oldCoinPriorityMinCumulativeSellSol: 10,
    oldCoinPriorityMinConfirmingBuyers: 3,
    oldCoinPriorityMaxRecoveryPct: 10,
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
  subject.handleSwap(event(mint, -40_000, { price: options.contextPrice ?? 1, wallet: 'context-buyer' }));
  subject.handleSwap(event(mint, 0, { price: 1, wallet: 'pre-buyer' }));
  subject.handleSwap(event(mint, 100, {
    side: 'SELL',
    wallet: 'driving-seller',
    priceBefore: 1,
    price: dropPrice,
    solVolume: options.drivingSellSol ?? 10,
    poolQuoteAfter: 100,
  }));
  for (const extra of options.extra || []) subject.handleSwap(event(mint, ...extra));
  const confirmingWallets = options.confirmingWallets || ['confirming-buyer-1', 'confirming-buyer-2'];
  confirmingWallets.forEach((wallet, index) => {
    const isLast = index === confirmingWallets.length - 1;
    subject.handleSwap(event(mint, 300 - ((confirmingWallets.length - 1 - index) * 50), {
      side: 'BUY',
      wallet,
      price: isLast ? recoveryPrice : dropPrice + ((recoveryPrice - dropPrice) / 2),
      solVolume: 2,
      poolQuoteAfter: isLast ? (options.finalPoolQuote ?? 99) : 100,
    }));
  });
}

assert.strictEqual(config.strategy.exitMode, 'OLD_COIN_PULLBACK_V10');
assert.strictEqual(config.strategy.minMintAgeHours, 48);
assert.strictEqual(config.strategy.maxTokenAgeMs, 0);
assert.strictEqual(config.strategy.fixedStopLossPct, 0);
assert.strictEqual(config.strategy.trailingActivatePct, 10);
assert.strictEqual(config.strategy.trailingDrawdownPct, 5);
assert.strictEqual(config.strategy.maxHoldMs, 60 * 60_000);
assert.strictEqual(config.activityFlow.oldCoinRunupLookbackMs, 60_000);
assert.strictEqual(config.activityFlow.oldCoinMinPrePeakContextMs, 30_000);
assert.strictEqual(config.activityFlow.oldCoinMinDrivingSellSol, 5);
assert.strictEqual(config.activityFlow.oldCoinMinCumulativeSellSol, 5);
assert.strictEqual(config.activityFlow.oldCoinMinCumulativeSellers, 2);
assert.strictEqual(config.activityFlow.oldCoinMinConfirmingBuyers, 2);
assert.strictEqual(config.activityFlow.oldCoinPriorityMinCumulativeSellSol, 10);
assert.strictEqual(config.activityFlow.oldCoinPriorityMinConfirmingBuyers, 3);
assert.strictEqual(config.activityFlow.oldCoinPriorityMaxRecoveryPct, 10);

const passing = tracker();
const passingSignals = signals(passing);
replay(passing, 'old-pass', 0.82, 0.84);
assert.strictEqual(passingSignals.length, 1, 'an 18% sell drop with a 2-5% recovery must signal');
assert.strictEqual(passingSignals[0]._oldCoinPullbackEntry, true);
assert.strictEqual(passingSignals[0]._flow.entryOldCoin.priority, false);
assert.strictEqual(passingSignals[0]._flow.entryOldCoin.confirmingBuyerCount, 2);
const panel = passing.getStrategyCandidates(10, BASE + 300);
assert.strictEqual(panel.mode, 'OLD_COIN_PULLBACK_V10');
assert.strictEqual(panel.thresholds.oldCoinMinDropPct, 5);
assert.strictEqual(panel.thresholds.oldCoinMaxRecoveryPct, 5);
assert.strictEqual(panel.thresholds.oldCoinMaxNetGain10sPct, 5);
assert.strictEqual(panel.thresholds.oldCoinMaxPrePeakRunupPct, 15);
assert.strictEqual(panel.thresholds.oldCoinMinDrivingSellSol, 5);
assert.strictEqual(panel.thresholds.oldCoinMinCumulativeSellSol, 5);
assert.strictEqual(panel.thresholds.oldCoinMinCumulativeSellers, 2);
assert.strictEqual(panel.thresholds.oldCoinMinConfirmingBuyers, 2);
assert.strictEqual(panel.thresholds.oldCoinPriorityMinCumulativeSellSol, 10);
assert.strictEqual(panel.thresholds.oldCoinPriorityMinConfirmingBuyers, 3);
assert.strictEqual(panel.thresholds.oldCoinPriorityMaxRecoveryPct, 10);
assert.strictEqual(panel.candidates[0].stage, 'signaled');
assert.strictEqual(panel.candidates[0].trigger.priority, false);
assert.strictEqual(panel.candidates[0].trigger.dropPct, 18);
assert.strictEqual(panel.candidates[0].s10.tradeCount, 4);
assert.strictEqual(panel.candidates[0].trigger.confirmingBuyerCount, 2);
assert.strictEqual(panel.candidates[0].fdvUsd, 125_000);
assert.strictEqual(panel.candidates[0].liquidityUsd, 25_000);
assert.strictEqual(Math.round(panel.candidates[0].tokenAgeMs / 3_600_000), 72);

const intraSwapDrop = tracker();
const intraSwapSignals = signals(intraSwapDrop);
intraSwapDrop.handleSwap(event('old-intra-swap', -40_000, { price: 1, wallet: 'context-buyer' }));
intraSwapDrop.handleSwap(event('old-intra-swap', 0, {
  side: 'SELL', wallet: 'single-seller', priceBefore: 1, price: 0.9, solVolume: 6,
}));
intraSwapDrop.handleSwap(event('old-intra-swap', 500, {
  side: 'BUY', wallet: 'confirming-buyer-1', priceBefore: 0.9, price: 0.91,
}));
intraSwapDrop.handleSwap(event('old-intra-swap', 800, {
  side: 'BUY', wallet: 'confirming-buyer-2', priceBefore: 0.91, price: 0.923,
}));
assert.strictEqual(
  intraSwapSignals.length,
  1,
  'the priceBefore-to-price drop inside the driving sell must be visible without a pre-buy event',
);
assert.strictEqual(intraSwapSignals[0]._flow.entryOldCoin.dropPct, 10);
assert.strictEqual(intraSwapSignals[0]._flow.entryOldCoin.sellQualification, 'single');

const cumulativeSell = tracker();
const cumulativeSignals = signals(cumulativeSell);
cumulativeSell.handleSwap(event('old-cumulative', -40_000, { price: 1, wallet: 'context-buyer' }));
cumulativeSell.handleSwap(event('old-cumulative', 0, {
  side: 'SELL', wallet: 'seller-a', priceBefore: 1, price: 0.95, solVolume: 2.8,
}));
cumulativeSell.handleSwap(event('old-cumulative', 100, {
  side: 'SELL', wallet: 'seller-b', priceBefore: 0.95, price: 0.9, solVolume: 2.7,
}));
cumulativeSell.handleSwap(event('old-cumulative', 300, {
  side: 'BUY', wallet: 'confirming-buyer-1', priceBefore: 0.9, price: 0.91,
}));
cumulativeSell.handleSwap(event('old-cumulative', 500, {
  side: 'BUY', wallet: 'confirming-buyer-2', priceBefore: 0.91, price: 0.927,
}));
assert.strictEqual(cumulativeSignals.length, 1, 'two independent sellers totaling 5 SOL must qualify');
assert.strictEqual(cumulativeSignals[0]._flow.entryOldCoin.sellQualification, 'cumulative');
assert.strictEqual(cumulativeSignals[0]._flow.entryOldCoin.drivingSellerCount, 2);
assert.strictEqual(cumulativeSignals[0]._flow.entryOldCoin.cumulativeSellSol, 5.5);

const oneCumulativeSeller = tracker();
const oneCumulativeSellerSignals = signals(oneCumulativeSeller);
oneCumulativeSeller.handleSwap(event('old-one-cumulative-seller', -40_000, { price: 1 }));
oneCumulativeSeller.handleSwap(event('old-one-cumulative-seller', 0, {
  side: 'SELL', wallet: 'seller-a', priceBefore: 1, price: 0.95, solVolume: 2.8,
}));
oneCumulativeSeller.handleSwap(event('old-one-cumulative-seller', 100, {
  side: 'SELL', wallet: 'seller-a', priceBefore: 0.95, price: 0.9, solVolume: 2.7,
}));
oneCumulativeSeller.handleSwap(event('old-one-cumulative-seller', 300, {
  side: 'BUY', wallet: 'confirming-buyer-1', price: 0.91,
}));
oneCumulativeSeller.handleSwap(event('old-one-cumulative-seller', 500, {
  side: 'BUY', wallet: 'confirming-buyer-2', price: 0.927,
}));
assert.strictEqual(
  oneCumulativeSellerSignals.length,
  0,
  'sub-5 SOL sells from one wallet must not pass the cumulative route',
);

const priorityRecovery = tracker();
const prioritySignals = signals(priorityRecovery);
priorityRecovery.handleSwap(event('old-priority', -40_000, { price: 1, wallet: 'context-buyer' }));
priorityRecovery.handleSwap(event('old-priority', 0, {
  side: 'SELL', wallet: 'seller-a', priceBefore: 1, price: 0.9, solVolume: 6,
}));
priorityRecovery.handleSwap(event('old-priority', 100, {
  side: 'SELL', wallet: 'seller-b', priceBefore: 0.9, price: 0.82, solVolume: 5,
}));
priorityRecovery.handleSwap(event('old-priority', 300, {
  side: 'BUY', wallet: 'confirming-buyer-1', priceBefore: 0.82, price: 0.86,
}));
priorityRecovery.handleSwap(event('old-priority', 500, {
  side: 'BUY', wallet: 'confirming-buyer-2', priceBefore: 0.86, price: 0.875,
}));
priorityRecovery.handleSwap(event('old-priority', 700, {
  side: 'BUY', wallet: 'confirming-buyer-3', priceBefore: 0.875, price: 0.8856,
}));
assert.strictEqual(prioritySignals.length, 1, 'strong deep pullbacks may recover up to 10%');
assert.strictEqual(prioritySignals[0]._flow.entryOldCoin.priority, true);
assert.strictEqual(prioritySignals[0]._flow.entryOldCoin.effectiveMaxRecoveryPct, 10);

const standardRecoveryCap = tracker();
const standardRecoverySignals = signals(standardRecoveryCap);
standardRecoveryCap.handleSwap(event('old-standard-cap', -40_000, { price: 1 }));
standardRecoveryCap.handleSwap(event('old-standard-cap', 0, {
  side: 'SELL', wallet: 'seller-a', priceBefore: 1, price: 0.82, solVolume: 9,
}));
standardRecoveryCap.handleSwap(event('old-standard-cap', 300, {
  side: 'BUY', wallet: 'confirming-buyer-1', price: 0.86,
}));
standardRecoveryCap.handleSwap(event('old-standard-cap', 500, {
  side: 'BUY', wallet: 'confirming-buyer-2', price: 0.875,
}));
standardRecoveryCap.handleSwap(event('old-standard-cap', 700, {
  side: 'BUY', wallet: 'confirming-buyer-3', price: 0.8856,
}));
assert.strictEqual(
  standardRecoverySignals.length,
  0,
  'a deep pullback below 10 cumulative SOL must retain the standard 5% recovery cap',
);

const topChase = tracker({ oldCoinMaxNetGain10sPct: 100 });
const topChaseSignals = signals(topChase);
replay(topChase, 'old-top-chase', 1.18, 1.21, { contextPrice: 0.8 });
assert.strictEqual(
  topChaseSignals.length,
  0,
  'a small pullback at the top of a >15% 30-second run-up must be rejected',
);

const sameWindowPump = tracker({ oldCoinMaxPrePeakRunupPct: 100 });
const sameWindowSignals = signals(sameWindowPump);
sameWindowPump.handleSwap(event('old-window-pump', -40_000, { price: 1, wallet: 'context-buyer' }));
sameWindowPump.handleSwap(event('old-window-pump', 0, { price: 1, wallet: 'pre-buyer' }));
sameWindowPump.handleSwap(event('old-window-pump', 100, { price: 1.35, wallet: 'pump-buyer' }));
sameWindowPump.handleSwap(event('old-window-pump', 200, {
  side: 'SELL', wallet: 'driving-seller', priceBefore: 1.35, price: 1.2, solVolume: 10,
}));
sameWindowPump.handleSwap(event('old-window-pump', 250, {
  side: 'BUY', wallet: 'confirming-buyer-1', price: 1.22, solVolume: 2,
}));
sameWindowPump.handleSwap(event('old-window-pump', 300, {
  side: 'BUY', wallet: 'confirming-buyer', price: 1.23, solVolume: 2,
}));
assert.strictEqual(
  sameWindowSignals.length,
  0,
  'a pullback whose current price is still >5% above the 10-second start must be rejected',
);

const waterfall = tracker();
const waterfallSignals = signals(waterfall);
replay(waterfall, 'old-waterfall', 0.79, 0.81);
assert.strictEqual(waterfallSignals.length, 0, 'a pullback deeper than 20% must be rejected');

const lowSell = tracker();
const lowSellSignals = signals(lowSell);
replay(lowSell, 'old-low-sell', 0.9, 0.92, { drivingSellSol: 4.9 });
assert.strictEqual(lowSellSignals.length, 0, 'a driving sell below 5 SOL must be rejected');

const oneBuyer = tracker();
const oneBuyerSignals = signals(oneBuyer);
replay(oneBuyer, 'old-one-buyer', 0.9, 0.92, { confirmingWallets: ['only-buyer'] });
assert.strictEqual(oneBuyerSignals.length, 0, 'one confirming buyer must be rejected');

const sameWallet = tracker();
const sameWalletSignals = signals(sameWallet);
replay(sameWallet, 'old-same-wallet', 0.9, 0.92, {
  confirmingWallets: ['driving-seller', 'driving-seller'],
});
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
