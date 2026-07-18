'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const SwapEventSanitizer = require('../src/core/SwapEventSanitizer');
const FeatureRecorder = require('../src/core/FeatureRecorder');
Module._load = originalLoad;

const MINT = 'TestMint111111111111111111111111111111111';
const BASE_TS = 1_800_000_001_000;

function swap(overrides = {}) {
  return {
    mint: MINT,
    symbol: 'TEST',
    signer: 'Wallet1111111111111111111111111111111111',
    side: 'BUY',
    solVolume: 1,
    price: 0.000001,
    priceBefore: 0.000001,
    priceChangePct: 0,
    ts: BASE_TS,
    slot: 10,
    signature: `sig-${overrides.ts || BASE_TS}`,
    poolAddress: 'Pool11111111111111111111111111111111111',
    poolQuoteAfter: 100,
    source: 'direct',
    priceReliable: true,
    ...overrides,
  };
}

function sanitizer(overrides = {}) {
  return new SwapEventSanitizer({
    enabled: true,
    maxJumpRatio: 2,
    marketMaxRatio: 5,
    confirmWindowMs: 5_000,
    confirmMinSamples: 3,
    confirmMinIndependentSources: 2,
    confirmMinSpanMs: 100,
    confirmClusterRatio: 1.25,
    minPoolQuoteSol: 30,
    ...overrides,
  });
}

function run() {
  const basic = sanitizer();
  assert.strictEqual(basic.sanitize(swap({ solVolume: 0 })).reason, 'nonpositive_volume');
  assert.strictEqual(basic.sanitize(swap({ side: 'HOLD' })).reason, 'invalid_side');

  const volumeOnly = basic.sanitize(swap({ source: 'cpi', price: 1, priceReliable: false }));
  assert.strictEqual(volumeOnly.status, 'volume_only');
  assert.strictEqual(volumeOnly.event.price, null);
  assert.strictEqual(volumeOnly.event.solVolume, 1);
  assert.strictEqual(volumeOnly.event.dataQualityVersion, 4);
  assert.strictEqual(volumeOnly.event.featureEligible, false);

  const market = sanitizer({
    solPriceUsd: 72,
    tokenRegistry: {
      getToken: () => ({ price: 0.000072, market_updated_at: BASE_TS }),
    },
  });
  const anchored = market.sanitize(swap({ source: 'cpi', price: 1, priceBefore: 1, priceReliable: false }));
  assert.strictEqual(anchored.status, 'sanitized');
  assert.strictEqual(anchored.event.price, 0.000001);
  assert.strictEqual(anchored.event.rawPrice, 1);
  assert.strictEqual(anchored.event.priceSanitized, true);

  const nativeAnchored = sanitizer({
    solPriceUsd: 999,
    tokenRegistry: {
      getToken: () => ({
        price: 1,
        market_updated_at: BASE_TS,
        meta_json: JSON.stringify({ priceSol: 0.000001 }),
      }),
    },
  }).sanitize(swap({ source: 'cpi', price: 1, priceBefore: 1, priceReliable: false }));
  assert.strictEqual(nativeAnchored.event.price, 0.000001);

  const continuity = sanitizer();
  const seed = continuity.sanitize(swap());
  assert.strictEqual(seed.status, 'accepted');
  assert.strictEqual(seed.reason, 'direct_seed');
  assert.strictEqual(seed.event.featureEligible, true);

  const discontinuity = continuity.sanitize(swap({
    source: 'cpi',
    price: 0.0001,
    priceBefore: 0.0001,
    priceReliable: true,
    ts: BASE_TS + 10,
  }));
  assert.strictEqual(discontinuity.status, 'sanitized');
  assert.strictEqual(discontinuity.event.price, 0.000001);
  assert.strictEqual(discontinuity.event.rawPrice, 0.0001);
  assert.strictEqual(discontinuity.event.featureEligible, false);

  const cleanBefore = continuity.sanitize(swap({
    source: 'cpi',
    price: 0.0000011,
    priceBefore: 1,
    priceReliable: true,
    ts: BASE_TS + 20,
  }));
  assert.strictEqual(cleanBefore.status, 'accepted');
  assert.strictEqual(cleanBefore.event.priceBefore, 0.000001);
  assert.strictEqual(cleanBefore.event.priceSanitized, true);
  assert(Math.abs(cleanBefore.event.priceChangePct - 10) < 1e-9);

  const samePool = sanitizer();
  samePool.sanitize(swap());
  const samePoolJump1 = samePool.sanitize(swap({ price: 0.000003, priceBefore: 0.000003, ts: BASE_TS + 100 }));
  const samePoolJump2 = samePool.sanitize(swap({ price: 0.0000031, priceBefore: 0.000003, ts: BASE_TS + 200 }));
  const samePoolJump3 = samePool.sanitize(swap({ price: 0.00000305, priceBefore: 0.000003, ts: BASE_TS + 300 }));
  assert.strictEqual(samePoolJump1.status, 'sanitized');
  assert.strictEqual(samePoolJump2.status, 'sanitized');
  assert.strictEqual(samePoolJump3.status, 'sanitized');
  assert.strictEqual(samePool.getPrice(MINT), 0.000001);

  const confirmed = sanitizer();
  confirmed.sanitize(swap());
  const jump1 = confirmed.sanitize(swap({
    poolAddress: 'PoolA', price: 0.000003, priceBefore: 0.000003, ts: BASE_TS + 100,
  }));
  const jump2 = confirmed.sanitize(swap({
    poolAddress: 'PoolB', price: 0.0000031, priceBefore: 0.000003, ts: BASE_TS + 200,
  }));
  const jump3 = confirmed.sanitize(swap({
    poolAddress: 'PoolA', price: 0.00000305, priceBefore: 0.000003, ts: BASE_TS + 300,
  }));
  assert.strictEqual(jump1.status, 'sanitized');
  assert.strictEqual(jump2.status, 'sanitized');
  assert.strictEqual(jump3.status, 'accepted');
  assert.strictEqual(jump3.reason, 'direct_jump_independently_confirmed');

  const staleMarketRegistry = {
    getToken: () => ({ price: 0.000072, market_updated_at: BASE_TS }),
  };
  const marketJump = sanitizer({ solPriceUsd: 72, tokenRegistry: staleMarketRegistry });
  const marketJump1 = marketJump.sanitize(swap({ price: 0.000006, priceBefore: 0.000006, ts: BASE_TS + 100 }));
  const marketJump2 = marketJump.sanitize(swap({ price: 0.0000061, priceBefore: 0.000006, ts: BASE_TS + 200 }));
  const marketJump3 = marketJump.sanitize(swap({ price: 0.00000605, priceBefore: 0.000006, ts: BASE_TS + 300 }));
  assert.strictEqual(marketJump1.status, 'sanitized');
  assert.strictEqual(marketJump2.status, 'sanitized');
  assert.strictEqual(marketJump3.status, 'sanitized');
  assert.strictEqual(marketJump3.reason, 'market_anchor_mismatch');

  const shallowSeed = sanitizer().sanitize(swap({ poolQuoteAfter: 0.05 }));
  assert.strictEqual(shallowSeed.status, 'volume_only');
  assert.strictEqual(shallowSeed.reason, 'direct_insufficient_pool');
  assert.strictEqual(shallowSeed.event.featureEligible, false);

  const shallowAfterSeed = continuity.sanitize(swap({
    poolQuoteAfter: 0.05,
    price: 0.0000011,
    priceBefore: 0.000001,
    ts: BASE_TS + 30,
  }));
  assert.strictEqual(shallowAfterSeed.status, 'volume_only');
  assert.strictEqual(shallowAfterSeed.reason, 'direct_insufficient_pool');

  const balanceOnly = continuity.sanitize(swap({
    source: 'balance_only',
    price: 0.0000011,
    priceBefore: 0.000001,
    ts: BASE_TS + 40,
  }));
  assert.strictEqual(balanceOnly.event.featureEligible, false);
  assert.strictEqual(balanceOnly.reason, 'untrusted_feature_source');

  let marketToken = { price: 0.000072, market_updated_at: BASE_TS };
  const refreshedMarket = sanitizer({
    solPriceUsd: 72,
    tokenRegistry: { getToken: () => marketToken },
  });
  assert.strictEqual(
    refreshedMarket.sanitize(swap({ source: 'cpi', price: 1, priceReliable: false })).event.price,
    0.000001,
  );
  marketToken = { price: 0.000144, market_updated_at: BASE_TS + 1_000 };
  assert.strictEqual(
    refreshedMarket.sanitize(swap({
      source: 'cpi',
      price: 1,
      priceReliable: false,
      ts: BASE_TS + 1_100,
    })).event.price,
    0.000002,
  );

  const saved = { snapshots: [], candles: [] };
  const recorder = new FeatureRecorder({
    enabled: true,
    labelEnabled: false,
    snapshotIntervalMs: 1_000,
    retentionMs: 60_000,
    tradeLogger: {
      saveTokenSnapshot: (row) => saved.snapshots.push(row),
      saveTokenCandle: (row) => saved.candles.push(row),
      saveTokenEvent() {},
    },
    tokenRegistry: {
      getToken: () => ({ mint: MINT, symbol: 'TEST', fdv: 100_000, liquidity: 50_000 }),
    },
  });
  recorder.handleSwap(seed.event);
  recorder.handleSwap({ ...volumeOnly.event, solVolume: 100 });
  recorder.flush(BASE_TS + 1_000);
  assert.strictEqual(saved.snapshots.length, 1);
  assert.strictEqual(saved.snapshots[0].data_quality_version, 4);
  assert.strictEqual(saved.snapshots[0].tx_count_60s, 1);
  assert.strictEqual(saved.snapshots[0].buy_volume_60s, 1);
  assert.strictEqual(saved.snapshots[0].filtered_event_count_60s, 1);
  assert.strictEqual(saved.snapshots[0].filtered_volume_sol_60s, 100);
  assert(Math.abs(saved.snapshots[0].trusted_volume_share_60s - (1 / 101)) < 1e-12);
  assert.strictEqual(saved.snapshots[0].feature_quality_status, 'mixed_filtered');
  assert(saved.candles.length >= 1);
  assert(saved.candles.every((row) => row.data_quality_version === 4));
  assert(saved.candles.every((row) => row.tx_count === 1));
  assert(saved.candles.every((row) => row.volume_sol === 1));
  assert(saved.candles.every((row) => row.filtered_event_count === 1));
  assert(saved.candles.every((row) => row.filtered_volume_sol === 100));

  console.log('Swap sanitizer and Strategy Lab quality tests passed');
}

run();
