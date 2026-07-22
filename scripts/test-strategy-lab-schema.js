'use strict';

const assert = require('assert');
const TradeLogger = require('../src/data/TradeLogger');
const { inspectStrategyLabQuality } = require('../src/data/StrategyLabQuality');

function createDatabase() {
  try {
    const Database = require('better-sqlite3');
    return new Database(':memory:');
  } catch (_) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.pragma = (query) => db.prepare(`PRAGMA ${query}`).all();
    return db;
  }
}

function run() {
  const db = createDatabase();
  db.exec(`
    CREATE TABLE swap_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      signer TEXT,
      side TEXT NOT NULL,
      sol_volume REAL,
      price REAL,
      price_before REAL,
      price_change_pct REAL,
      slot INTEGER,
      signature TEXT,
      pool_address TEXT,
      pool_quote_after REAL
    );
  `);

  const logger = new TradeLogger(db);
  logger.logTrade({
    ts: 1_800_000_000_000,
    mint: 'TradeMint',
    side: 'BUY',
    success: false,
    error: 'ExceededSlippage',
    configuredSlippagePct: 50,
    effectiveSlippagePct: 7.5,
    signalPrice: 1,
    expectedPrice: 1.07,
    maxPrice: 1.15,
    maxQuoteSol: 0.215,
    cacheAgeBeforeMs: 1200,
    cacheAgeAtBuildMs: 3,
    stateSource: 'rpc-forced',
    buyMode: 'buy_exact_quote_in',
    minBaseAmountOutRaw: '173914',
    virtualQuoteReservesRaw: '5000000000',
  });
  const tradeDiagnostic = db.prepare("SELECT * FROM trades WHERE mint = 'TradeMint'").get();
  assert.strictEqual(tradeDiagnostic.configured_slippage_pct, 50);
  assert.strictEqual(tradeDiagnostic.effective_slippage_pct, 7.5);
  assert.strictEqual(tradeDiagnostic.signal_price, 1);
  assert.strictEqual(tradeDiagnostic.expected_price, 1.07);
  assert.strictEqual(tradeDiagnostic.max_price, 1.15);
  assert.strictEqual(tradeDiagnostic.max_quote_sol, 0.215);
  assert.strictEqual(tradeDiagnostic.cache_age_before_ms, 1200);
  assert.strictEqual(tradeDiagnostic.cache_age_at_build_ms, 3);
  assert.strictEqual(tradeDiagnostic.state_source, 'rpc-forced');
  assert.strictEqual(tradeDiagnostic.buy_mode, 'buy_exact_quote_in');
  assert.strictEqual(tradeDiagnostic.min_base_amount_out_raw, '173914');
  assert.strictEqual(tradeDiagnostic.virtual_quote_reserves_raw, '5000000000');
  const snapshotColumns = db.pragma('table_info(token_snapshots)').map((row) => row.name);
  const swapColumns = new Set(db.pragma('table_info(swap_events)').map((row) => row.name));
  assert.strictEqual(snapshotColumns.length, logger._snapshotColumnNames().length + 1);
  for (const name of [
    'source',
    'price_reliable',
    'price_sanitized',
    'raw_price',
    'raw_price_before',
    'sanitizer_reason',
    'feature_eligible',
    'data_quality_version',
  ]) {
    assert(swapColumns.has(name), `missing migrated swap_events.${name}`);
  }

  const ts = 1_800_000_000_000;
  logger.saveTokenSnapshot({
    ts,
    bucket_ts: ts,
    mint: 'CleanMint',
    price: 1,
    trusted_price_ts: ts,
    trusted_price_age_ms: 0,
    feature_quality_status: 'trusted',
    data_quality_version: 4,
  });
  logger.saveTokenSnapshot({
    ts: ts + 10,
    bucket_ts: ts,
    mint: 'CleanMint',
    price: 1,
    trusted_price_ts: ts,
    trusted_price_age_ms: 10,
    feature_quality_status: 'quiet',
    data_quality_version: 4,
  });
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM token_snapshots WHERE mint = 'CleanMint'").get().count,
    1,
  );

  logger.saveTokenSnapshot({
    ts,
    bucket_ts: ts,
    mint: 'LegacyMint',
    price: 1,
    data_quality_version: 1,
  });
  logger.saveTokenSnapshot({
    ts,
    bucket_ts: ts,
    mint: 'UntrustedMint',
    price: 3,
    trusted_price_ts: null,
    feature_quality_status: 'no_trusted_price',
    data_quality_version: 4,
  });

  const events = [
    { ts: ts + 10_000, price: 1.1, quality: 4, signature: 'clean-10', eligible: true },
    { ts: ts + 60_000, price: 1.2, quality: 4, signature: 'clean-60', eligible: true },
    { ts: ts + 90_000, price: 100, quality: 1, signature: 'legacy-outlier' },
    { ts: ts + 120_000, price: 1000, quality: 4, signature: 'filtered-outlier' },
    { ts: ts + 180_000, price: 0.9, quality: 4, signature: 'clean-180', eligible: true },
  ];
  for (const event of events) {
    logger.logSwapEvent({
      mint: 'CleanMint',
      side: 'BUY',
      solVolume: 1,
      price: event.price,
      priceBefore: event.price,
      ts: event.ts,
      signature: event.signature,
      priceReliable: event.eligible === true,
      featureEligible: event.eligible === true,
      dataQualityVersion: event.quality,
    });
  }
  logger.logSwapEvent({
    mint: 'NullPriceMint',
    side: 'SELL',
    solVolume: 1,
    price: null,
    ts: ts + 1,
    signature: 'null-price',
    featureEligible: false,
    dataQualityVersion: 4,
  });
  const nullPrice = db.prepare("SELECT price FROM swap_events WHERE mint = 'NullPriceMint'").get();
  assert.strictEqual(nullPrice.price, null);

  const updated = logger.backfillSnapshotLabels({ now: ts + 181_000, batchSize: 10 });
  assert.strictEqual(updated, 1);
  const clean = db.prepare("SELECT * FROM token_snapshots WHERE mint = 'CleanMint'").get();
  const legacy = db.prepare("SELECT * FROM token_snapshots WHERE mint = 'LegacyMint'").get();
  const untrusted = db.prepare("SELECT * FROM token_snapshots WHERE mint = 'UntrustedMint'").get();
  assert(Math.abs(clean.future_max_180s_pct - 20) < 1e-9);
  assert(Math.abs(clean.future_drawdown_180s_pct - (-10)) < 1e-9);
  assert.strictEqual(clean.label_status, 'complete');
  assert.strictEqual(clean.label_quality_version, 4);
  assert.strictEqual(clean.label_sample_count_30s, 1);
  assert.strictEqual(clean.label_sample_count_60s, 2);
  assert.strictEqual(clean.label_sample_count_180s, 3);
  assert.strictEqual(legacy.label_updated_at, null);
  assert.strictEqual(untrusted.label_updated_at, null);

  logger.saveTokenSnapshot({
    ts: ts + 1_000,
    bucket_ts: ts + 1_000,
    mint: 'QuietMint',
    price: 2,
    trusted_price_ts: ts,
    trusted_price_age_ms: 1_000,
    feature_quality_status: 'quiet',
    data_quality_version: 4,
  });
  const beforeQuietBackfill = logger.getSnapshotLabelBacklog({ now: ts + 182_000 });
  assert.strictEqual(beforeQuietBackfill.count, 1);
  assert.strictEqual(logger.backfillSnapshotLabels({ now: ts + 182_000, batchSize: 10 }), 1);
  const quiet = db.prepare("SELECT * FROM token_snapshots WHERE mint = 'QuietMint'").get();
  assert.strictEqual(quiet.future_max_180s_pct, 0);
  assert.strictEqual(quiet.future_close_180s_pct, 0);
  assert.strictEqual(quiet.future_drawdown_180s_pct, 0);
  assert.strictEqual(quiet.label_sample_count_180s, 0);
  assert.strictEqual(logger.getSnapshotLabelBacklog({ now: ts + 182_000 }).count, 0);

  const quality = inspectStrategyLabQuality(db, {
    now: ts + 182_000,
    minQualityVersion: 4,
  });
  assert.strictEqual(quality.passed, true);
  assert.strictEqual(quality.snapshots.completeCount, 2);
  assert.strictEqual(quality.events.eligibleCount, 3);
  assert.strictEqual(quality.events.filteredCount, 2);
  assert.strictEqual(quality.contaminatedLabelCount, 0);

  db.prepare("UPDATE token_snapshots SET future_max_60s_pct = NULL WHERE mint = 'QuietMint'").run();
  const incompleteQuality = inspectStrategyLabQuality(db, {
    now: ts + 182_000,
    minQualityVersion: 4,
  });
  assert.strictEqual(incompleteQuality.passed, false);
  assert.strictEqual(incompleteQuality.snapshots.processedIncompleteCount, 1);
  db.prepare("UPDATE token_snapshots SET future_max_60s_pct = 0 WHERE mint = 'QuietMint'").run();

  logger.logSwapEvent({
    mint: 'CleanMint',
    side: 'BUY',
    solVolume: 1,
    price: 10,
    priceBefore: 10,
    ts: ts + 181_000,
    signature: 'market-anchor-jump',
    sanitizerReason: 'market_anchor_refresh',
    priceReliable: true,
    featureEligible: true,
    dataQualityVersion: 4,
  });
  const anchoredQuality = inspectStrategyLabQuality(db, {
    now: ts + 182_000,
    minQualityVersion: 4,
  });
  assert.strictEqual(anchoredQuality.passed, true);

  for (const event of [
    { mint: 'LongGapMint', ts: ts + 1_000, price: 1, poolAddress: 'PoolA' },
    { mint: 'LongGapMint', ts: ts + 130_000, price: 3, poolAddress: 'PoolA' },
    { mint: 'ConfirmedMint', ts: ts + 150_000, price: 1, poolAddress: 'PoolA' },
    { mint: 'ConfirmedMint', ts: ts + 151_000, price: 3, poolAddress: 'PoolA' },
    { mint: 'ConfirmedMint', ts: ts + 151_100, price: 3.1, poolAddress: 'PoolA' },
    { mint: 'ConfirmedMint', ts: ts + 151_200, price: 3.05, poolAddress: 'PoolA' },
    { mint: 'ConfirmedMint', ts: ts + 151_300, price: 3, poolAddress: 'PoolA' },
    { mint: 'PoolBoundaryMint', ts: ts + 160_000, price: 1, poolAddress: 'PoolA' },
    { mint: 'PoolBoundaryMint', ts: ts + 161_000, price: 3, poolAddress: 'PoolB' },
  ]) {
    logger.logSwapEvent({
      mint: event.mint,
      side: 'BUY',
      solVolume: 1,
      price: event.price,
      priceBefore: event.price,
      ts: event.ts,
      poolAddress: event.poolAddress,
      signature: `${event.mint}-${event.ts}`,
      sanitizerReason: 'continuous_price',
      priceReliable: true,
      featureEligible: true,
      dataQualityVersion: 4,
    });
  }
  const boundaryQuality = inspectStrategyLabQuality(db, {
    now: ts + 220_000,
    minQualityVersion: 4,
  });
  assert.strictEqual(boundaryQuality.passed, true);
  assert.strictEqual(boundaryQuality.prices.jumpCount, 4);
  assert.strictEqual(boundaryQuality.prices.reasonConfirmedCount, 1);
  assert.strictEqual(boundaryQuality.prices.subsequentConfirmedCount, 1);
  assert.strictEqual(boundaryQuality.prices.gapBoundaryCount, 1);
  assert.strictEqual(boundaryQuality.prices.poolBoundaryCount, 1);

  logger.logSwapEvent({
    mint: 'CleanMint',
    side: 'BUY',
    solVolume: 1,
    price: 100,
    priceBefore: 100,
    ts: ts + 181_500,
    signature: 'unverified-jump',
    sanitizerReason: 'continuous_price',
    priceReliable: true,
    featureEligible: true,
    dataQualityVersion: 4,
  });
  const recentJumpQuality = inspectStrategyLabQuality(db, {
    now: ts + 182_000,
    minQualityVersion: 4,
  });
  assert.strictEqual(recentJumpQuality.passed, true);

  const failedQuality = inspectStrategyLabQuality(db, {
    now: ts + 220_000,
    minQualityVersion: 4,
  });
  assert.strictEqual(failedQuality.passed, false);
  assert.strictEqual(failedQuality.prices.badJumpCount, 1);

  new TradeLogger(db);
  if (typeof db.close === 'function') db.close();
  console.log(`Strategy Lab schema tests passed (${snapshotColumns.length - 1} exportable DB columns)`);
}

run();
