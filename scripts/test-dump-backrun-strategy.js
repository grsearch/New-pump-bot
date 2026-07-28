'use strict';

const assert = require('assert');
const Module = require('module');

// Simulate a production .env left behind by an older strategy. V9 must use
// its dedicated defaults unless a DUMP_BACKRUN_* override is explicitly set.
process.env.MIN_SELL_SOL = '99';
process.env.MIN_PRICE_IMPACT_PCT = '40';
process.env.MIN_TRIGGER_SELL_COUNT = '9';
process.env.MAX_PRICE_IMPACT_PCT = '45';
process.env.MIN_POOL_QUOTE_SOL = '90';

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const OrderFlowTracker = require('../src/core/OrderFlowTracker');
const SignalEngine = require('../src/core/SignalEngine');
const { config } = require('../src/config');
Module._load = originalLoad;

let mintSequence = 0;

function nextMint() {
  mintSequence += 1;
  return `DumpBackrunTestMint${mintSequence}111111111111111111111`;
}

function makeSignal(overrides = {}) {
  const mint = overrides.mint || nextMint();
  return {
    mint,
    symbol: 'V9TEST',
    sellSol: 8.5,
    priceImpactPct: 12,
    poolQuoteAfter: 150,
    seller: `seller-${mintSequence}`,
    signature: `signature-${mintSequence}-${Date.now()}`,
    ts: Date.now() - 50,
    slot: 500_000,
    priceBefore: 1.2e-6,
    priceAfter: 1e-6,
    _sellCount10s: 1,
    _dumpBackrunEntry: true,
    ...overrides,
  };
}

function makeEngine({ hasOpenPosition = false } = {}) {
  const logged = [];
  const engine = new SignalEngine({
    tradeLogger: {
      getRecentAcceptedSellerTxs: () => [],
      loadRecentPriceSamples: () => new Map(),
      logSignal: (row) => logged.push(row),
    },
    positionManager: {
      openPositionCount: () => (hasOpenPosition ? 1 : 0),
      hasOpenPosition: () => hasOpenPosition,
    },
    tokenRegistry: {
      isActive: () => true,
      getToken: () => ({ migration_time: Date.now() - 60_000 }),
    },
  });
  return { engine, logged };
}

async function run() {
  assert.strictEqual(config.activityFlow.entryMode, 'DUMP_BACKRUN_V9');
  assert.strictEqual(config.activityFlow.replaceDumpSignal, false);
  assert.strictEqual(config.strategy.exitMode, 'DUMP_BACKRUN_V9');
  assert.strictEqual(config.strategy.minSellSol, 8);
  assert.strictEqual(config.strategy.allowAggregatedDumpSignals, false);
  assert.strictEqual(config.strategy.minPriceImpactPct, 8);
  assert.strictEqual(config.strategy.maxPriceImpactPct, 65);
  assert.strictEqual(config.strategy.minPoolQuoteSol, 120);
  assert.strictEqual(config.strategy.dumpBackrunMaxSignalAgeMs, 1_500);
  assert.strictEqual(config.strategy.buyMaxPriceDeviationPct, 13);

  const accepted = makeEngine();
  const buyOrders = [];
  accepted.engine.on('buyOrder', (order) => buyOrders.push(order));
  const validSignal = makeSignal();
  await accepted.engine.handleDumpSignal(validSignal);
  assert.strictEqual(buyOrders.length, 1, 'a valid dump must emit BUY immediately');
  assert.match(buyOrders[0].reason, /dump_backrun_v9/);
  assert.strictEqual(buyOrders[0]._dumpBackrunEntry, true);

  accepted.engine.markBuyDone(validSignal.mint);
  await accepted.engine.handleDumpSignal(validSignal);
  assert.strictEqual(buyOrders.length, 1, 'the same seller transaction must be deduplicated');
  accepted.engine.shutdown();

  const stale = makeEngine();
  const staleOrders = [];
  stale.engine.on('buyOrder', (order) => staleOrders.push(order));
  await stale.engine.handleDumpSignal(makeSignal({
    ts: Date.now() - config.strategy.dumpBackrunMaxSignalAgeMs - 50,
  }));
  assert.strictEqual(staleOrders.length, 0, 'a stale dump must not buy');
  stale.engine.shutdown();

  const catastrophic = makeEngine();
  const catastrophicOrders = [];
  catastrophic.engine.on('buyOrder', (order) => catastrophicOrders.push(order));
  await catastrophic.engine.handleDumpSignal(makeSignal({
    priceImpactPct: config.strategy.maxPriceImpactPct,
  }));
  assert.strictEqual(catastrophicOrders.length, 0, 'a 65% dump must be rejected');
  catastrophic.engine.shutdown();

  const aggregated = makeEngine();
  const aggregatedOrders = [];
  aggregated.engine.on('buyOrder', (order) => aggregatedOrders.push(order));
  await aggregated.engine.handleDumpSignal(makeSignal({
    sellSol: 12,
    poolQuoteAfter: 180,
    _aggregated: true,
    _sellers: ['seller-a', 'seller-b'],
  }));
  assert.strictEqual(aggregatedOrders.length, 0, 'an aggregated dump must not buy');
  aggregated.engine.shutdown();

  const shallow = makeEngine();
  const shallowOrders = [];
  shallow.engine.on('buyOrder', (order) => shallowOrders.push(order));
  await shallow.engine.handleDumpSignal(makeSignal({
    sellSol: config.strategy.minSellSol - 0.01,
  }));
  assert.strictEqual(shallowOrders.length, 0, 'a sub-threshold sell must not buy');
  shallow.engine.shutdown();

  const lowLiquidity = makeEngine();
  const lowLiquidityOrders = [];
  lowLiquidity.engine.on('buyOrder', (order) => lowLiquidityOrders.push(order));
  await lowLiquidity.engine.handleDumpSignal(makeSignal({
    poolQuoteAfter: config.strategy.minPoolQuoteSol - 0.01,
  }));
  assert.strictEqual(lowLiquidityOrders.length, 0, 'a sub-threshold pool must not buy');
  lowLiquidity.engine.shutdown();

  const open = makeEngine({ hasOpenPosition: true });
  const openOrders = [];
  open.engine.on('buyOrder', (order) => openOrders.push(order));
  await open.engine.handleDumpSignal(makeSignal());
  assert.strictEqual(openOrders.length, 0, 'an open same-mint position must block another buy');
  open.engine.shutdown();

  const tracker = new OrderFlowTracker({
    entryMode: 'DUMP_BACKRUN_V9',
    maxSignalAgeMs: 0,
  });
  const flowSignals = [];
  tracker.on('flowReversalSignal', (signal) => flowSignals.push(signal));
  const panelMint = nextMint();
  const now = Date.now();
  tracker.handleSwap({
    mint: panelMint,
    symbol: 'PANEL',
    signer: 'panel-seller',
    side: 'SELL',
    solVolume: 6.5,
    price: 1e-6,
    priceBefore: 1.2e-6,
    priceChangePct: -16.67,
    poolQuoteAfter: 45,
    ts: now,
    slot: 500_001,
    signature: 'panel-swap',
  });
  assert.strictEqual(flowSignals.length, 0, 'V9 telemetry must not emit a delayed flow BUY');
  tracker.noteDumpSignal(makeSignal({
    mint: panelMint,
    symbol: 'PANEL',
    ts: now,
    signature: 'panel-dump',
  }));
  let panel = tracker.getStrategyCandidates(10, now + 100);
  assert.strictEqual(panel.mode, 'DUMP_BACKRUN_V9');
  assert.strictEqual(panel.thresholds.dumpAllowAggregated, false);
  assert.strictEqual(panel.candidates[0].conditions.singleSell, true);
  assert.strictEqual(panel.candidates[0].conditions.sellSize, true);
  assert.strictEqual(panel.candidates[0].conditions.impactRange, true);
  assert.strictEqual(panel.candidates[0].conditions.poolLiquidity, true);
  assert.strictEqual(panel.candidates[0].conditions.signalFresh, true);
  tracker.noteDumpAccepted(panelMint, now + 100);
  panel = tracker.getStrategyCandidates(10, now + 100);
  assert.strictEqual(panel.candidates[0].stage, 'signaled');

  console.log('Strategy V9 dump backrun tests: PASS');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
