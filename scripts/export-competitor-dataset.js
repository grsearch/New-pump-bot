'use strict';

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('../src/config');
const { resolveCompetitorWallets } = require('../src/utils/competitorWallets');

const REQUIRED_TABLES = [
  'competitor_wallet_transactions',
  'competitor_forensic_trades',
  'competitor_wallet_positions',
  'competitor_token_contexts',
  'competitor_market_events',
  'competitor_opportunities',
  'competitor_capture_coverage',
  'competitor_capture_sessions',
];

function parseTimestamp(value, fallback) {
  if (value == null) return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Invalid timestamp: ${value}`);
}

function parseArgs(argv) {
  const args = {
    wallet: null,
    hours: 48,
    since: null,
    until: Date.now(),
    out: null,
    controlBucketSec: 60,
    includeControls: true,
  };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--wallet') args.wallet = argv[++index] || null;
    else if (arg === '--hours') args.hours = Number(argv[++index]);
    else if (arg === '--since') args.since = argv[++index];
    else if (arg === '--until') args.until = parseTimestamp(argv[++index], Date.now());
    else if (arg === '--out') args.out = argv[++index] || null;
    else if (arg === '--control-bucket-sec') args.controlBucketSec = Number(argv[++index]);
    else if (arg === '--no-controls') args.includeControls = false;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  args.until = parseTimestamp(args.until, Date.now());
  args.since = parseTimestamp(
    args.since,
    args.until - Math.max(1, Number(args.hours) || 48) * 3600_000,
  );
  args.controlBucketSec = Math.max(1, Math.floor(Number(args.controlBucketSec) || 60));
  return args;
}

function printHelp() {
  console.log(`Usage: npm run export:competitor -- [options]

Options:
  --wallet ADDRESS          Export one competitor wallet. Defaults to all configured wallets.
  --hours N                 Lookback window when --since is omitted. Default 48.
  --since TIME              Epoch milliseconds or ISO timestamp.
  --until TIME              Epoch milliseconds or ISO timestamp. Default now.
  --out DIRECTORY           Output directory.
  --control-bucket-sec N    One monitored-universe control per mint per N seconds. Default 60.
  --no-controls             Skip monitored-universe control snapshots.
`);
}

function csvEscape(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(tableName));
}

function tableColumns(db, tableName) {
  return db.pragma(`table_info(${tableName})`).map((row) => row.name);
}

function writeCsv(filePath, columns, rows, transform = (row) => row) {
  const fd = fs.openSync(filePath, 'w');
  let count = 0;
  try {
    fs.writeSync(fd, `${columns.map(csvEscape).join(',')}\n`);
    for (const sourceRow of rows) {
      const row = transform(sourceRow);
      fs.writeSync(fd, `${columns.map((column) => csvEscape(row[column])).join(',')}\n`);
      count += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

function writeQueryCsv(db, filePath, sql, params = {}) {
  const statement = db.prepare(sql);
  const columns = statement.columns().map((column) => column.name);
  return writeCsv(filePath, columns, statement.iterate(params));
}

function selectedWallets(args) {
  if (args.wallet) return [args.wallet];
  return resolveCompetitorWallets(process.env.COMPETITOR_WALLETS || '');
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function flattenOpportunity(row, snapshotColumns) {
  let features = {};
  try { features = JSON.parse(row.feature_json || '{}') || {}; } catch (_) {}
  const flattened = { ...row };
  delete flattened.feature_json;
  for (const [name, value] of Object.entries(features)) {
    flattened[`rolling_${name}`] = value;
  }
  for (const name of snapshotColumns) {
    flattened[`snapshot_${name}`] = row[`__snapshot_${name}`] ?? null;
    delete flattened[`__snapshot_${name}`];
  }
  return flattened;
}

function exportAnalysisEvents(db, outDir, wallets, since, until) {
  const snapshotColumns = tableExists(db, 'token_snapshots')
    ? tableColumns(db, 'token_snapshots')
    : [];
  const featureColumns = [
    1, 3, 5, 10, 20, 30, 60,
  ].flatMap((seconds) => [
    `rolling_buy_volume_${seconds}s`,
    `rolling_sell_volume_${seconds}s`,
    `rolling_net_volume_${seconds}s`,
    `rolling_buy_count_${seconds}s`,
    `rolling_sell_count_${seconds}s`,
    `rolling_unique_buy_wallets_${seconds}s`,
    `rolling_unique_sell_wallets_${seconds}s`,
    `rolling_price_change_${seconds}s`,
  ]);
  const opportunityColumns = tableColumns(db, 'competitor_opportunities')
    .filter((name) => name !== 'feature_json');
  const columns = [
    ...opportunityColumns,
    ...featureColumns,
    ...snapshotColumns.map((name) => `snapshot_${name}`),
  ];
  const snapshotSelect = snapshotColumns.length > 0
    ? `, ${snapshotColumns.map((name) => (
      `s."${name}" AS "__snapshot_${name}"`
    )).join(', ')}`
    : '';
  const snapshotJoin = snapshotColumns.length > 0
    ? 'LEFT JOIN token_snapshots s ON s.id = o.context_snapshot_id'
    : '';
  const sql = `
    SELECT o.*${snapshotSelect}
    FROM competitor_opportunities o
    ${snapshotJoin}
    WHERE o.wallet IN (${placeholders(wallets)})
      AND o.ts BETWEEN ? AND ?
    ORDER BY o.ts ASC, o.id ASC
  `;
  const rows = db.prepare(sql).iterate(...wallets, since, until);
  return writeCsv(
    path.join(outDir, 'competitor-analysis-events.csv'),
    columns,
    rows,
    (row) => flattenOpportunity(row, snapshotColumns),
  );
}

function exportUniverseControls(db, outDir, wallets, since, until, bucketSec) {
  if (!tableExists(db, 'token_snapshots')) return 0;
  const snapshotColumns = tableColumns(db, 'token_snapshots');
  const columns = [
    'wallet',
    'did_buy',
    'observation_scope',
    'control_bucket_sec',
    ...snapshotColumns,
  ];
  const sql = `
    WITH sampled AS (
      SELECT s.*,
             ROW_NUMBER() OVER (
               PARTITION BY s.mint, CAST(s.ts / ? AS INTEGER)
               ORDER BY s.ts ASC, s.id ASC
             ) AS sample_rank
      FROM token_snapshots s
      WHERE s.ts BETWEEN ? AND ?
        AND NOT EXISTS (
          SELECT 1
          FROM competitor_forensic_trades t
          WHERE t.wallet IN (${placeholders(wallets)})
            AND t.side = 'BUY'
            AND t.mint = s.mint
            AND ABS(t.ts - s.ts) <= 3000
        )
    )
    SELECT * FROM sampled WHERE sample_rank = 1
    ORDER BY ts ASC, mint ASC
  `;
  const bucketMs = bucketSec * 1000;
  const rows = db.prepare(sql).iterate(bucketMs, since, until, ...wallets);
  return writeCsv(
    path.join(outDir, 'competitor-monitored-universe-controls.csv'),
    columns,
    rows,
    (row) => {
      const normalized = {
        wallet: wallets.length === 1 ? wallets[0] : 'ALL_CONFIGURED_WALLETS',
        did_buy: 0,
        observation_scope: 'bot_monitored_universe_only',
        control_bucket_sec: bucketSec,
        ...row,
      };
      delete normalized.sample_rank;
      return normalized;
    },
  );
}

function main() {
  const args = parseArgs(process.argv);
  const db = new Database(config.storage.dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const missing = REQUIRED_TABLES.filter((table) => !tableExists(db, table));
    if (missing.length > 0) {
      throw new Error(
        `Competitor forensic tables are missing: ${missing.join(', ')}. ` +
        'Deploy and restart the updated bot before exporting.',
      );
    }

    const wallets = selectedWallets(args);
    if (wallets.length === 0) throw new Error('No competitor wallets are configured');
    const stamp = new Date(args.until).toISOString().replace(/[:.]/g, '-');
    const outDir = path.resolve(args.out || path.join(
      config.storage.reportsDir,
      `competitor-forensics-${stamp}`,
    ));
    fs.mkdirSync(outDir, { recursive: true });

    const walletParams = [...wallets, args.since, args.until];
    const walletFilter = `wallet IN (${placeholders(wallets)})`;
    const files = {};
    const exports = [
      ['competitor-wallet-transactions.csv', 'competitor_wallet_transactions', 'ts'],
      ['competitor-forensic-trades.csv', 'competitor_forensic_trades', 'ts'],
      ['competitor-opportunities.csv', 'competitor_opportunities', 'ts'],
    ];
    for (const [fileName, tableName, timeColumn] of exports) {
      files[fileName] = writeQueryCsv(
        db,
        path.join(outDir, fileName),
        `SELECT * FROM ${tableName}
         WHERE ${walletFilter} AND ${timeColumn} BETWEEN ? AND ?
         ORDER BY ${timeColumn} ASC, id ASC`,
        walletParams,
      );
    }

    const mintSql = `
      SELECT DISTINCT mint FROM competitor_forensic_trades
      WHERE ${walletFilter} AND ts BETWEEN ? AND ?
    `;
    const mints = db.prepare(mintSql).all(...walletParams).map((row) => row.mint);
    if (mints.length > 0) {
      files['competitor-token-contexts.csv'] = writeQueryCsv(
        db,
        path.join(outDir, 'competitor-token-contexts.csv'),
        `SELECT * FROM competitor_token_contexts
         WHERE mint IN (${placeholders(mints)}) AND event_ts BETWEEN ? AND ?
         ORDER BY event_ts ASC, id ASC`,
        [...mints, args.since, args.until],
      );
      files['competitor-market-events.csv'] = writeQueryCsv(
        db,
        path.join(outDir, 'competitor-market-events.csv'),
        `SELECT * FROM competitor_market_events
         WHERE mint IN (${placeholders(mints)}) AND ts BETWEEN ? AND ?
         ORDER BY ts ASC, id ASC`,
        [...mints, args.since, args.until],
      );
      files['competitor-wallet-positions.csv'] = writeQueryCsv(
        db,
        path.join(outDir, 'competitor-wallet-positions.csv'),
        `SELECT * FROM competitor_wallet_positions
         WHERE ${walletFilter} AND mint IN (${placeholders(mints)})
         ORDER BY wallet ASC, mint ASC`,
        [...wallets, ...mints],
      );
    } else {
      files['competitor-token-contexts.csv'] = writeQueryCsv(
        db,
        path.join(outDir, 'competitor-token-contexts.csv'),
        'SELECT * FROM competitor_token_contexts WHERE 0',
      );
      files['competitor-market-events.csv'] = writeQueryCsv(
        db,
        path.join(outDir, 'competitor-market-events.csv'),
        'SELECT * FROM competitor_market_events WHERE 0',
      );
      files['competitor-wallet-positions.csv'] = writeQueryCsv(
        db,
        path.join(outDir, 'competitor-wallet-positions.csv'),
        'SELECT * FROM competitor_wallet_positions WHERE 0',
      );
    }

    files['competitor-capture-coverage.csv'] = writeQueryCsv(
      db,
      path.join(outDir, 'competitor-capture-coverage.csv'),
      `SELECT * FROM competitor_capture_coverage
       WHERE ${walletFilter} ORDER BY wallet ASC`,
      wallets,
    );
    files['competitor-capture-sessions.csv'] = writeQueryCsv(
      db,
      path.join(outDir, 'competitor-capture-sessions.csv'),
      `SELECT * FROM competitor_capture_sessions
       WHERE started_at <= ? AND COALESCE(stopped_at, ?) >= ?
       ORDER BY started_at ASC`,
      [args.until, args.until, args.since],
    );
    files['competitor-analysis-events.csv'] = exportAnalysisEvents(
      db,
      outDir,
      wallets,
      args.since,
      args.until,
    );
    if (args.includeControls) {
      files['competitor-monitored-universe-controls.csv'] = exportUniverseControls(
        db,
        outDir,
        wallets,
        args.since,
        args.until,
        args.controlBucketSec,
      );
    }

    const quality = {
      generatedAt: Date.now(),
      since: args.since,
      until: args.until,
      wallets,
      files,
      caveats: [
        'Independent wallet coverage begins only after the updated service starts.',
        'Negative controls cover only the bot monitored universe or post-first-observation shadow mints.',
        'Shadow-mint market labels cover Pump AMM v1/v2 and matching Jupiter routes, not every Solana venue.',
        'execution_vs_asof_pct compares execution with the latest prior Strategy Lab snapshot; it is not pure AMM price impact.',
      ],
      metrics: {},
    };

    const metric = (sql) => db.prepare(sql).get(...wallets, args.since, args.until)?.value || 0;
    quality.metrics = {
      transactions: metric(
        `SELECT COUNT(*) AS value FROM competitor_wallet_transactions
         WHERE ${walletFilter} AND ts BETWEEN ? AND ?`,
      ),
      trades: metric(
        `SELECT COUNT(*) AS value FROM competitor_forensic_trades
         WHERE ${walletFilter} AND ts BETWEEN ? AND ?`,
      ),
      buys: metric(
        `SELECT COUNT(*) AS value FROM competitor_forensic_trades
         WHERE ${walletFilter} AND side = 'BUY' AND ts BETWEEN ? AND ?`,
      ),
      sells: metric(
        `SELECT COUNT(*) AS value FROM competitor_forensic_trades
         WHERE ${walletFilter} AND side = 'SELL' AND ts BETWEEN ? AND ?`,
      ),
      unknownVenueTrades: metric(
        `SELECT COUNT(*) AS value FROM competitor_forensic_trades
         WHERE ${walletFilter} AND venue = 'UNKNOWN' AND ts BETWEEN ? AND ?`,
      ),
      missingContextTrades: metric(
        `SELECT COUNT(*) AS value FROM competitor_forensic_trades
         WHERE ${walletFilter} AND context_snapshot_id IS NULL AND ts BETWEEN ? AND ?`,
      ),
      pendingBuyLabels: metric(
        `SELECT COUNT(*) AS value FROM competitor_forensic_trades
         WHERE ${walletFilter} AND side = 'BUY' AND label_status = 'pending'
           AND ts BETWEEN ? AND ?`,
      ),
      pendingTradeLabels: metric(
        `SELECT COUNT(*) AS value FROM competitor_forensic_trades
         WHERE ${walletFilter} AND label_status = 'pending'
           AND ts BETWEEN ? AND ?`,
      ),
    };
    fs.writeFileSync(
      path.join(outDir, 'quality-report.json'),
      `${JSON.stringify(quality, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(outDir, 'manifest.json'),
      `${JSON.stringify({
        formatVersion: 1,
        generatedAt: Date.now(),
        dbPath: config.storage.dbPath,
        since: args.since,
        until: args.until,
        wallets,
        files,
      }, null, 2)}\n`,
    );
    console.log(`Competitor dataset exported: ${outDir}`);
    console.log(JSON.stringify({ wallets, since: args.since, until: args.until, files }, null, 2));
  } finally {
    db.close();
  }
}

main();
