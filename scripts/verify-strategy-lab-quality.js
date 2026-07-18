'use strict';

require('dotenv').config({ override: true });

const Database = require('better-sqlite3');
const { config } = require('../src/config');
const { inspectStrategyLabQuality, qualitySummary } = require('../src/data/StrategyLabQuality');

function numberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

function main() {
  const hours = numberArg('--hours', 0);
  const now = Date.now();
  const db = new Database(config.storage.dbPath, { readonly: true, fileMustExist: true });
  try {
    const result = inspectStrategyLabQuality(db, {
      now,
      sinceTs: hours > 0 ? now - hours * 60 * 60 * 1000 : 0,
      minQualityVersion: numberArg('--min-quality-version', 4),
      maxJumpRatio: numberArg('--max-jump-ratio', 2),
      maxJumpGapMs: numberArg('--max-jump-gap-ms', 120_000),
      jumpConfirmWindowMs: numberArg('--jump-confirm-window-ms', 30_000),
      jumpConfirmClusterRatio: numberArg('--jump-confirm-cluster-ratio', 1.25),
      maxBacklogAgeMs: numberArg('--max-backlog-age-ms', 300_000),
    });
    console.log(qualitySummary(result));
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
