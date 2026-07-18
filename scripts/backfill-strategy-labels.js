'use strict';

require('dotenv').config({ override: true });

const Database = require('better-sqlite3');
const { config } = require('../src/config');
const TradeLogger = require('../src/data/TradeLogger');

function numberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

function main() {
  const batchSize = Math.max(1, Math.floor(numberArg('--batch-size', 2000)));
  const maxBatches = Math.max(0, Math.floor(numberArg('--max-batches', 0)));
  const minQualityVersion = Math.max(1, Math.floor(numberArg('--min-quality-version', 4)));
  const db = new Database(config.storage.dbPath);
  const logger = new TradeLogger(db);
  const startedAt = Date.now();
  let batches = 0;
  let updated = 0;
  try {
    while (maxBatches === 0 || batches < maxBatches) {
      const count = logger.backfillSnapshotLabels({ batchSize, minQualityVersion });
      batches++;
      updated += count;
      if (count < batchSize) break;
      if (batches % 10 === 0) {
        const backlog = logger.getSnapshotLabelBacklog({ minQualityVersion });
        console.log(`batches=${batches} updated=${updated} pending=${backlog.count}`);
      }
    }
    const backlog = logger.getSnapshotLabelBacklog({ minQualityVersion });
    console.log(JSON.stringify({
      batches,
      updated,
      elapsedMs: Date.now() - startedAt,
      backlog,
    }, null, 2));
  } finally {
    db.close();
  }
}

main();
