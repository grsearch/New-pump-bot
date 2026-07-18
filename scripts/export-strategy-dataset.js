'use strict';

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('../src/config');
const {
  REQUIRED_LABEL_COLUMNS,
  inspectStrategyLabQuality,
  qualitySummary,
} = require('../src/data/StrategyLabQuality');

const DEFAULT_COLUMNS = [
  'ts',
  'mint',
  'symbol',
  'price',
  'market_cap',
  'fdv',
  'liquidity',
  'age_min',
  'holders',
  'data_quality_version',
  'trusted_price_ts',
  'trusted_price_age_ms',
  'trusted_event_count_60s',
  'filtered_event_count_60s',
  'trusted_volume_sol_60s',
  'filtered_volume_sol_60s',
  'trusted_event_share_60s',
  'trusted_volume_share_60s',
  'feature_quality_status',
  'buy_volume_5s',
  'sell_volume_5s',
  'buy_sell_ratio_5s',
  'unique_buy_wallets_5s',
  'largest_buy_5s',
  'buy_volume_30s',
  'sell_volume_30s',
  'buy_sell_ratio_30s',
  'unique_buy_wallets_30s',
  'unique_sell_wallets_30s',
  'new_buy_wallets_30s',
  'repeat_buy_wallets_30s',
  'avg_buy_size_30s',
  'median_buy_size_30s',
  'largest_buy_30s',
  'buy_volume_60s',
  'sell_volume_60s',
  'buy_sell_ratio_60s',
  'unique_buy_wallets_60s',
  'unique_sell_wallets_60s',
  'buy_streak',
  'sell_streak',
  'tx_per_second_10s',
  'tx_count_10s',
  'price_change_5s',
  'price_change_30s',
  'price_change_60s',
  'high_60s',
  'low_60s',
  'volatility_60s',
  'atr_60s',
  'lp_change_60s_pct',
  'fdv_change_60s_pct',
  'latency_detect_ms',
  'latency_decision_ms',
  'latency_send_ms',
  'latency_confirm_ms',
  'future_max_30s_pct',
  'future_close_30s_pct',
  'future_drawdown_30s_pct',
  'future_max_60s_pct',
  'future_close_60s_pct',
  'future_drawdown_60s_pct',
  'future_max_180s_pct',
  'future_close_180s_pct',
  'future_drawdown_180s_pct',
];

function parseArgs(argv) {
  const args = {
    hours: 0,
    out: null,
    limit: 0,
    allColumns: false,
    includeUnlabeled: false,
    minQualityVersion: 4,
    allowQualityFailures: false,
    maxJumpRatio: 2,
    maxBacklogAgeMs: 300_000,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hours') args.hours = Number(argv[++i] || 0);
    else if (arg === '--out') args.out = argv[++i] || null;
    else if (arg === '--limit') args.limit = Number(argv[++i] || 0);
    else if (arg === '--all') args.allColumns = true;
    else if (arg === '--include-unlabeled') args.includeUnlabeled = true;
    else if (arg === '--allow-quality-failures') args.allowQualityFailures = true;
    else if (arg === '--max-jump-ratio') args.maxJumpRatio = Number(argv[++i]);
    else if (arg === '--max-backlog-age-ms') args.maxBacklogAgeMs = Number(argv[++i]);
    else if (arg === '--min-quality-version') {
      args.minQualityVersion = Number(argv[++i]);
      if (!Number.isFinite(args.minQualityVersion) || args.minQualityVersion < 0) {
        throw new Error('--min-quality-version must be a number greater than or equal to 0');
      }
    }
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: npm run export:strategy -- [options]

Options:
  --hours N              Export only the last N hours. 0 means all history.
  --out PATH             CSV output path. Defaults to reports/strategy-dataset-*.csv.
  --limit N              Maximum rows to export. 0 means no limit.
  --all                  Export every token_snapshots column.
  --include-unlabeled    Include rows whose future labels are still null.
  --min-quality-version  Minimum data quality version. Defaults to 4; use 0 for legacy rows.
  --max-jump-ratio N     Reject unverified adjacent price jumps above this ratio. Default 2.
  --max-backlog-age-ms N Reject label backlogs older than this age. Default 300000.
  --allow-quality-failures
                         Export even when quality checks fail; writes failures to the sidecar report.
`);
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function getColumns(db, allColumns) {
  if (!allColumns) return DEFAULT_COLUMNS;
  return db.pragma('table_info(token_snapshots)')
    .map((row) => row.name)
    .filter((name) => name !== 'id');
}

function main() {
  const args = parseArgs(process.argv);
  const db = new Database(config.storage.dbPath, { readonly: true, fileMustExist: true });
  const exists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'token_snapshots'
  `).get();
  if (!exists) {
    console.error('token_snapshots table does not exist yet. Start the bot with Strategy Lab enabled first.');
    process.exit(1);
  }

  const columns = getColumns(db, args.allColumns);
  const available = new Set(db.pragma('table_info(token_snapshots)').map((row) => row.name));
  if (args.minQualityVersion >= 4) {
    for (const name of [
      'label_status',
      'label_quality_version',
      'trusted_price_ts',
      'feature_quality_status',
      'trusted_event_count_60s',
      'filtered_event_count_60s',
      'trusted_volume_sol_60s',
      'filtered_volume_sol_60s',
      ...REQUIRED_LABEL_COLUMNS,
    ]) {
      if (!available.has(name)) {
        throw new Error(`token_snapshots.${name} is missing. Restart the V4 bot before exporting.`);
      }
    }
  }
  const selected = columns.filter((name) => available.has(name));
  if (!selected.includes('ts')) selected.unshift('ts');
  if (args.allColumns) {
    const expected = [...available].filter((name) => name !== 'id').length;
    if (selected.length !== expected) {
      throw new Error(`--all requested ${expected} database columns but selected ${selected.length}`);
    }
  }

  const where = [];
  const params = {};
  if (!args.includeUnlabeled) {
    params.minQualityVersion = Math.max(1, Math.floor(args.minQualityVersion || 1));
    where.push("label_status = 'complete'");
    where.push('COALESCE(label_quality_version, 0) >= @minQualityVersion');
    for (const name of REQUIRED_LABEL_COLUMNS) where.push(`${name} IS NOT NULL`);
  }
  if (
    Number.isFinite(args.minQualityVersion) &&
    args.minQualityVersion > 0
  ) {
    if (!available.has('data_quality_version')) {
      throw new Error(
        'data_quality_version is missing. Restart the updated bot first, or explicitly use --min-quality-version 0 for legacy data.',
      );
    }
    params.minQualityVersion = Math.floor(args.minQualityVersion);
    where.push('COALESCE(data_quality_version, 0) >= @minQualityVersion');
    if (args.minQualityVersion >= 4) {
      where.push('trusted_price_ts IS NOT NULL');
      where.push("feature_quality_status IN ('trusted', 'mixed_filtered', 'quiet')");
    }
  }
  if (Number.isFinite(args.hours) && args.hours > 0) {
    params.since = Date.now() - args.hours * 60 * 60 * 1000;
    where.push('ts >= @since');
  }

  const quality = inspectStrategyLabQuality(db, {
    sinceTs: params.since || 0,
    minQualityVersion: args.minQualityVersion > 0
      ? Math.max(1, Math.floor(args.minQualityVersion))
      : 1,
    maxJumpRatio: args.maxJumpRatio,
    maxBacklogAgeMs: args.maxBacklogAgeMs,
  });
  console.log(qualitySummary(quality));
  if (!quality.passed && !args.allowQualityFailures) {
    throw new Error(
      `Strategy Lab quality checks failed. Fix the data or use --allow-quality-failures: ` +
        quality.failures.join('; '),
    );
  }
  const limitSql = Number.isFinite(args.limit) && args.limit > 0 ? ` LIMIT ${Math.floor(args.limit)}` : '';
  const sql = `
    SELECT ${selected.join(', ')}
    FROM token_snapshots
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ts ASC
    ${limitSql}
  `;

  const outPath = args.out || path.join(
    config.storage.reportsDir,
    `strategy-dataset-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
  stream.write(['time_iso', ...selected].join(',') + '\n');

  let rows = 0;
  for (const row of db.prepare(sql).iterate(params)) {
    const timeIso = row.ts ? new Date(row.ts).toISOString() : '';
    stream.write([timeIso, ...selected.map((name) => csvEscape(row[name]))].join(',') + '\n');
    rows++;
  }
  stream.end();
  fs.writeFileSync(`${outPath}.quality.json`, JSON.stringify(quality, null, 2));
  console.log(`Exported ${rows} rows / ${selected.length + 1} CSV columns to ${outPath}`);
  console.log(`Quality report: ${outPath}.quality.json`);
}

main();
