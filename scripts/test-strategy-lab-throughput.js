'use strict';

const assert = require('assert');
const TradeLogger = require('../src/data/TradeLogger');

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
  const logger = new TradeLogger(db);
  const baseTs = 1_900_000_000_000;
  const tokenCount = 100;
  const seconds = 100;
  const insertAll = () => {
    for (let second = 0; second < seconds; second++) {
      for (let token = 0; token < tokenCount; token++) {
        const ts = baseTs + second * 1000 + token;
        logger.saveTokenSnapshot({
          ts,
          bucket_ts: ts,
          mint: `Mint-${token}`,
          price: 1,
          trusted_price_ts: ts,
          trusted_price_age_ms: 0,
          feature_quality_status: 'trusted',
          data_quality_version: 4,
        });
        logger.logSwapEvent({
          ts: ts + 500,
          mint: `Mint-${token}`,
          side: second % 2 === 0 ? 'BUY' : 'SELL',
          solVolume: 1,
          price: 1 + second / 100_000,
          priceBefore: 1,
          signature: `swap-${second}-${token}`,
          sanitizerReason: 'continuous_price',
          priceReliable: true,
          featureEligible: true,
          dataQualityVersion: 4,
        });
      }
    }
  };
  if (typeof db.transaction === 'function') db.transaction(insertAll)();
  else insertAll();

  const now = baseTs + seconds * 1000 + 181_000;
  assert.strictEqual(logger.getSnapshotLabelBacklog({ now }).count, tokenCount * seconds);
  const startedAt = Date.now();
  let batches = 0;
  let updated = 0;
  while (true) {
    const count = logger.backfillSnapshotLabels({ now, batchSize: 1000 });
    batches++;
    updated += count;
    if (count < 1000) break;
  }
  const elapsedMs = Date.now() - startedAt;
  assert.strictEqual(updated, tokenCount * seconds);
  assert.strictEqual(logger.getSnapshotLabelBacklog({ now }).count, 0);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM token_snapshots WHERE label_status = 'complete'").get().count,
    tokenCount * seconds,
  );
  console.log(
    `Strategy Lab throughput test passed: ${updated} labels in ${batches} batches / ${elapsedMs}ms`,
  );
  if (typeof db.close === 'function') db.close();
}

run();
