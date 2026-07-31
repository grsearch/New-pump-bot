'use strict';

const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('CompetitorForensics', {
  staleMs: 3600_000,
  label: 'Competitor Forensics',
});

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);
const PUMP_AMM_V2_PROGRAM_ID = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const JUPITER_PROGRAM_IDS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74cnZidQ6Ep5qJtREpsGS',
  'JUP4Fb2cqiRUcKKFCJYa6tVmKgFqA5bXfzFYsFCLvh7',
]);
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const JITO_TIP_ACCOUNTS = new Set([
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
]);
const HORIZONS_SEC = [1, 3, 5, 10, 20, 30, 60, 180];
const FEATURE_WINDOWS_SEC = [1, 3, 5, 10, 20, 30, 60];

function encodeBase58(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return bs58.encode(value);
  if (value instanceof Uint8Array) return bs58.encode(Buffer.from(value));
  try {
    const buffer = Buffer.from(value);
    return buffer.length > 0 ? bs58.encode(buffer) : null;
  } catch (_) {
    return null;
  }
}

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = null) {
  const parsed = finite(value, null);
  return parsed != null && parsed > 0 ? parsed : fallback;
}

function tokenAmount(ui) {
  if (!ui) return 0;
  try {
    if (ui.amount != null && ui.decimals != null) {
      const raw = BigInt(ui.amount);
      const decimals = Math.max(0, Number(ui.decimals) || 0);
      const divisor = 10n ** BigInt(decimals);
      return Number(raw / divisor) + Number(raw % divisor) / Number(divisor);
    }
  } catch (_) {}
  return finite(ui.uiAmountString ?? ui.uiAmount, 0);
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (_, item) => (
      typeof item === 'bigint' ? item.toString() : item
    ));
  } catch (_) {
    return null;
  }
}

function instructionDataBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') {
    try {
      return Buffer.from(bs58.decode(data));
    } catch (_) {
      return null;
    }
  }
  return null;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
  ).get(tableName));
}

function ensureColumns(db, tableName, columns) {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function labelColumnSql() {
  return HORIZONS_SEC.flatMap((horizon) => ([
    `future_max_${horizon}s_pct REAL`,
    `future_close_${horizon}s_pct REAL`,
    `future_drawdown_${horizon}s_pct REAL`,
    `label_samples_${horizon}s INTEGER`,
  ])).join(',\n        ');
}

function extractSignature(txMessage) {
  const outer = txMessage?.transaction;
  let signature = outer?.signature;
  if (!signature) signature = outer?.transaction?.signatures?.[0];
  if (!signature) signature = txMessage?.signature;
  return encodeBase58(signature);
}

function extractAllKeys(txMessage) {
  const outer = txMessage?.transaction;
  const meta = outer?.meta || {};
  const staticKeys = outer?.transaction?.message?.accountKeys || [];
  return [
    ...staticKeys,
    ...(meta.loadedWritableAddresses || []),
    ...(meta.loadedReadonlyAddresses || []),
  ].map(encodeBase58).filter(Boolean);
}

function extractProgramIds(txMessage, allKeys) {
  const outer = txMessage?.transaction;
  const meta = outer?.meta || {};
  const message = outer?.transaction?.message || {};
  const indexes = new Set();
  for (const instruction of message.instructions || message.compiledInstructions || []) {
    const index = finite(instruction?.programIdIndex, null);
    if (index != null) indexes.add(index);
  }
  for (const group of meta.innerInstructions || []) {
    for (const instruction of group?.instructions || []) {
      const index = finite(instruction?.programIdIndex, null);
      if (index != null) indexes.add(index);
    }
  }
  return [...indexes].map((index) => allKeys[index]).filter(Boolean);
}

function classifyVenue(programIds) {
  const programs = new Set(programIds);
  const route = [];
  if ([...JUPITER_PROGRAM_IDS].some((program) => programs.has(program))) route.push('JUPITER');
  if (programs.has(config.programs.pumpAmm)) route.push('PUMP_AMM');
  if (programs.has(PUMP_AMM_V2_PROGRAM_ID)) route.push('PUMP_AMM_V2');
  return route.length > 0 ? route.join('>') : 'UNKNOWN';
}

class CompetitorForensics {
  constructor({
    db,
    wallets = [],
    onMintDiscovered = null,
    fetchTokenContext = null,
    slotToWallClockMs = null,
    labelIntervalMs = 10_000,
  }) {
    if (!db) throw new Error('CompetitorForensics requires a shared DB instance');
    this.db = db;
    this.wallets = new Set((wallets || []).filter(Boolean));
    this.onMintDiscovered = onMintDiscovered;
    this.fetchTokenContext = typeof fetchTokenContext === 'function'
      ? fetchTokenContext
      : null;
    this.slotToWallClockMs = slotToWallClockMs;
    this.labelIntervalMs = Math.max(1000, Number(labelIntervalMs) || 10_000);
    this.shadowMints = new Map();
    this.walletMints = new Map();
    this.marketBuffers = new Map();
    this.positionState = new Map();
    this._labelTimer = null;
    this._captureSessionId = null;
    this._contextEnrichInFlight = new Map();
    this._insertSqlCache = new Map();
    this._hasSnapshots = false;
    this._hasSwapEvents = false;

    this._initSchema();
    this._prepareStatements();
    this._restoreState();
  }

  _initSchema() {
    const labels = labelColumnSql();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS competitor_wallet_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        wallet TEXT NOT NULL,
        signature TEXT,
        ts INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        slot INTEGER,
        transaction_index INTEGER,
        stream_region TEXT,
        capture_source TEXT,
        dedup_status TEXT,
        capture_latency_ms INTEGER,
        fee_sol REAL,
        priority_fee_sol REAL,
        jito_tip_sol REAL,
        compute_units INTEGER,
        venue TEXT,
        program_ids_json TEXT,
        trade_count INTEGER DEFAULT 0,
        parse_status TEXT,
        parse_error TEXT,
        chain_error_json TEXT,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_comp_wallet_tx_wallet_ts
        ON competitor_wallet_transactions(wallet, ts);
      CREATE INDEX IF NOT EXISTS idx_comp_wallet_tx_signature
        ON competitor_wallet_transactions(signature);

      CREATE TABLE IF NOT EXISTS competitor_forensic_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        side TEXT NOT NULL,
        token_amount REAL,
        token_balance_before REAL,
        token_balance_after REAL,
        native_sol_before REAL,
        native_sol_after REAL,
        native_sol_delta REAL,
        wsol_before REAL,
        wsol_after REAL,
        quote_delta_sol REAL,
        sol_amount REAL,
        execution_price_sol REAL,
        reference_price_sol REAL,
        execution_vs_asof_pct REAL,
        quote_estimation_method TEXT,
        quote_quality TEXT,
        ts INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        slot INTEGER,
        transaction_index INTEGER,
        signature TEXT,
        stream_region TEXT,
        capture_source TEXT,
        capture_latency_ms INTEGER,
        fee_sol REAL,
        priority_fee_sol REAL,
        jito_tip_sol REAL,
        compute_units INTEGER,
        venue TEXT,
        program_ids_json TEXT,
        position_tokens_before REAL,
        position_tokens_after REAL,
        position_cost_sol_before REAL,
        position_cost_sol_after REAL,
        position_cost_known_before INTEGER,
        position_cost_known_after INTEGER,
        entry_sequence INTEGER,
        sell_fraction_pct REAL,
        realized_pnl_sol REAL,
        realized_pnl_pct REAL,
        hold_ms INTEGER,
        context_snapshot_id INTEGER,
        context_snapshot_ts INTEGER,
        context_lag_ms INTEGER,
        context_quality TEXT,
        context_json TEXT,
        external_context_id INTEGER,
        external_context_lag_ms INTEGER,
        external_context_quality TEXT,
        coverage_scope TEXT,
        price_reliable INTEGER DEFAULT 0,
        details_json TEXT,
        ${labels},
        label_status TEXT DEFAULT 'pending',
        label_updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_comp_forensic_wallet_ts
        ON competitor_forensic_trades(wallet, ts);
      CREATE INDEX IF NOT EXISTS idx_comp_forensic_mint_ts
        ON competitor_forensic_trades(mint, ts);
      CREATE INDEX IF NOT EXISTS idx_comp_forensic_labels
        ON competitor_forensic_trades(label_status, ts);

      CREATE TABLE IF NOT EXISTS competitor_wallet_positions (
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        token_balance REAL,
        cost_basis_sol REAL,
        avg_entry_price_sol REAL,
        first_buy_ts INTEGER,
        last_trade_ts INTEGER,
        buy_count INTEGER DEFAULT 0,
        sell_count INTEGER DEFAULT 0,
        realized_pnl_sol REAL DEFAULT 0,
        cost_basis_known INTEGER DEFAULT 0,
        updated_at INTEGER,
        PRIMARY KEY(wallet, mint)
      );

      CREATE TABLE IF NOT EXISTS competitor_token_contexts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        event_ts INTEGER NOT NULL,
        requested_at INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        fetch_latency_ms INTEGER,
        symbol TEXT,
        name TEXT,
        decimals INTEGER,
        supply REAL,
        fdv REAL,
        market_cap REAL,
        liquidity REAL,
        price_usd REAL,
        holders INTEGER,
        volume_24h_usd REAL,
        price_change_24h_pct REAL,
        creation_time INTEGER,
        age_ms_at_event INTEGER,
        market_source TEXT,
        fetch_status TEXT,
        fetch_error TEXT,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_comp_token_context_mint_ts
        ON competitor_token_contexts(mint, event_ts);

      CREATE TABLE IF NOT EXISTS competitor_market_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        mint TEXT NOT NULL,
        actor_wallet TEXT,
        side TEXT,
        token_amount REAL,
        sol_amount REAL,
        price REAL,
        ts INTEGER NOT NULL,
        slot INTEGER,
        transaction_index INTEGER,
        signature TEXT,
        stream_region TEXT,
        venue TEXT,
        source TEXT,
        price_reliable INTEGER DEFAULT 0,
        capture_latency_ms INTEGER,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_comp_market_mint_ts
        ON competitor_market_events(mint, ts);

      CREATE TABLE IF NOT EXISTS competitor_opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet TEXT NOT NULL,
        mint TEXT NOT NULL,
        bucket_ts INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        price REAL,
        did_buy INTEGER DEFAULT 0,
        competitor_trade_id INTEGER,
        coverage_start_ts INTEGER,
        observation_scope TEXT,
        feature_json TEXT,
        context_snapshot_id INTEGER,
        context_snapshot_ts INTEGER,
        context_lag_ms INTEGER,
        context_quality TEXT,
        ${labels},
        label_status TEXT DEFAULT 'pending',
        label_updated_at INTEGER,
        UNIQUE(wallet, mint, bucket_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_comp_opp_wallet_ts
        ON competitor_opportunities(wallet, ts);
      CREATE INDEX IF NOT EXISTS idx_comp_opp_mint_ts
        ON competitor_opportunities(mint, ts);
      CREATE INDEX IF NOT EXISTS idx_comp_opp_labels
        ON competitor_opportunities(label_status, ts);

      CREATE TABLE IF NOT EXISTS competitor_capture_coverage (
        wallet TEXT PRIMARY KEY,
        subscription_started_at INTEGER,
        last_event_at INTEGER,
        last_slot INTEGER,
        last_region TEXT,
        last_capture_latency_ms INTEGER,
        max_capture_latency_ms INTEGER DEFAULT 0,
        transactions_seen INTEGER DEFAULT 0,
        wallet_stream_transactions INTEGER DEFAULT 0,
        overlap_stream_transactions INTEGER DEFAULT 0,
        chain_failed_transactions INTEGER DEFAULT 0,
        trades_parsed INTEGER DEFAULT 0,
        non_trade_transactions INTEGER DEFAULT 0,
        parse_failures INTEGER DEFAULT 0,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS competitor_capture_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER,
        wallets_json TEXT,
        status TEXT NOT NULL,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_comp_capture_sessions_started
        ON competitor_capture_sessions(started_at);
    `);
    ensureColumns(this.db, 'competitor_wallet_transactions', {
      capture_source: 'TEXT',
      dedup_status: 'TEXT',
      chain_error_json: 'TEXT',
    });
    ensureColumns(this.db, 'competitor_forensic_trades', {
      reference_price_sol: 'REAL',
      execution_vs_asof_pct: 'REAL',
      external_context_id: 'INTEGER',
      external_context_lag_ms: 'INTEGER',
      external_context_quality: 'TEXT',
      position_cost_known_before: 'INTEGER',
      position_cost_known_after: 'INTEGER',
    });
    ensureColumns(this.db, 'competitor_wallet_positions', {
      cost_basis_known: 'INTEGER DEFAULT 0',
    });
    ensureColumns(this.db, 'competitor_capture_coverage', {
      last_capture_latency_ms: 'INTEGER',
      max_capture_latency_ms: 'INTEGER DEFAULT 0',
      wallet_stream_transactions: 'INTEGER DEFAULT 0',
      overlap_stream_transactions: 'INTEGER DEFAULT 0',
      chain_failed_transactions: 'INTEGER DEFAULT 0',
    });
  }

  _prepareStatements() {
    this._hasSnapshots = tableExists(this.db, 'token_snapshots');
    this._hasSwapEvents = tableExists(this.db, 'swap_events');
    this.stmts = {
      getTradeByKey: this.db.prepare(
        `SELECT id FROM competitor_forensic_trades WHERE event_key = ?`,
      ),
      upsertPosition: this.db.prepare(`
        INSERT INTO competitor_wallet_positions
          (wallet, mint, token_balance, cost_basis_sol, avg_entry_price_sol,
           first_buy_ts, last_trade_ts, buy_count, sell_count, realized_pnl_sol,
           cost_basis_known, updated_at)
        VALUES
          (@wallet, @mint, @token_balance, @cost_basis_sol, @avg_entry_price_sol,
           @first_buy_ts, @last_trade_ts, @buy_count, @sell_count, @realized_pnl_sol,
           @cost_basis_known, @updated_at)
        ON CONFLICT(wallet, mint) DO UPDATE SET
          token_balance = excluded.token_balance,
          cost_basis_sol = excluded.cost_basis_sol,
          avg_entry_price_sol = excluded.avg_entry_price_sol,
          first_buy_ts = excluded.first_buy_ts,
          last_trade_ts = excluded.last_trade_ts,
          buy_count = excluded.buy_count,
          sell_count = excluded.sell_count,
          realized_pnl_sol = excluded.realized_pnl_sol,
          cost_basis_known = excluded.cost_basis_known,
          updated_at = excluded.updated_at
      `),
      loadPositions: this.db.prepare(`SELECT * FROM competitor_wallet_positions`),
      loadRecentTrades: this.db.prepare(`
        SELECT wallet, mint, ts FROM competitor_forensic_trades
        WHERE ts >= ? ORDER BY ts ASC
      `),
      loadRecentMarketEvents: this.db.prepare(`
        SELECT mint, actor_wallet, side, sol_amount, price, ts
        FROM competitor_market_events
        WHERE ts >= ? ORDER BY ts ASC, id ASC
      `),
      latestTokenContext: this.db.prepare(`
        SELECT * FROM competitor_token_contexts
        WHERE mint = ? AND fetch_status = 'ok'
        ORDER BY fetched_at DESC LIMIT 1
      `),
      linkExternalContext: this.db.prepare(`
        UPDATE competitor_forensic_trades
        SET external_context_id = ?,
            external_context_lag_ms = ?,
            external_context_quality = ?
        WHERE id = ?
      `),
      upsertOpportunity: this.db.prepare(`
        INSERT INTO competitor_opportunities
          (wallet, mint, bucket_ts, ts, price, did_buy, competitor_trade_id,
           coverage_start_ts, observation_scope, feature_json,
           context_snapshot_id, context_snapshot_ts, context_lag_ms, context_quality,
           label_status)
        VALUES
          (@wallet, @mint, @bucket_ts, @ts, @price, @did_buy, @competitor_trade_id,
           @coverage_start_ts, @observation_scope, @feature_json,
           @context_snapshot_id, @context_snapshot_ts, @context_lag_ms, @context_quality,
           'pending')
        ON CONFLICT(wallet, mint, bucket_ts) DO UPDATE SET
          did_buy = MAX(competitor_opportunities.did_buy, excluded.did_buy),
          competitor_trade_id = COALESCE(excluded.competitor_trade_id, competitor_opportunities.competitor_trade_id),
          price = CASE WHEN excluded.did_buy = 1 THEN excluded.price ELSE competitor_opportunities.price END,
          feature_json = CASE WHEN excluded.did_buy = 1 THEN excluded.feature_json ELSE competitor_opportunities.feature_json END
      `),
      upsertCoverage: this.db.prepare(`
        INSERT INTO competitor_capture_coverage
          (wallet, subscription_started_at, last_event_at, last_slot, last_region,
           last_capture_latency_ms, max_capture_latency_ms,
           transactions_seen, wallet_stream_transactions, overlap_stream_transactions,
           chain_failed_transactions,
           trades_parsed, non_trade_transactions, parse_failures, updated_at)
        VALUES
          (@wallet, @subscription_started_at, @last_event_at, @last_slot, @last_region,
           @last_capture_latency_ms, @max_capture_latency_ms,
           @transactions_seen, @wallet_stream_transactions, @overlap_stream_transactions,
           @chain_failed_transactions,
           @trades_parsed, @non_trade_transactions, @parse_failures, @updated_at)
        ON CONFLICT(wallet) DO UPDATE SET
          last_event_at = CASE
            WHEN excluded.last_event_at IS NULL THEN competitor_capture_coverage.last_event_at
            WHEN competitor_capture_coverage.last_event_at IS NULL THEN excluded.last_event_at
            ELSE MAX(competitor_capture_coverage.last_event_at, excluded.last_event_at)
          END,
          last_slot = COALESCE(excluded.last_slot, competitor_capture_coverage.last_slot),
          last_region = COALESCE(excluded.last_region, competitor_capture_coverage.last_region),
          last_capture_latency_ms = COALESCE(
            excluded.last_capture_latency_ms,
            competitor_capture_coverage.last_capture_latency_ms
          ),
          max_capture_latency_ms = MAX(
            competitor_capture_coverage.max_capture_latency_ms,
            excluded.max_capture_latency_ms
          ),
          transactions_seen = competitor_capture_coverage.transactions_seen + excluded.transactions_seen,
          wallet_stream_transactions =
            competitor_capture_coverage.wallet_stream_transactions + excluded.wallet_stream_transactions,
          overlap_stream_transactions =
            competitor_capture_coverage.overlap_stream_transactions + excluded.overlap_stream_transactions,
          chain_failed_transactions =
            competitor_capture_coverage.chain_failed_transactions + excluded.chain_failed_transactions,
          trades_parsed = competitor_capture_coverage.trades_parsed + excluded.trades_parsed,
          non_trade_transactions = competitor_capture_coverage.non_trade_transactions + excluded.non_trade_transactions,
          parse_failures = competitor_capture_coverage.parse_failures + excluded.parse_failures,
          updated_at = excluded.updated_at
      `),
      pendingTrades: this.db.prepare(`
        SELECT * FROM competitor_forensic_trades
        WHERE label_status = 'pending' AND ts <= ?
        ORDER BY ts ASC LIMIT 500
      `),
      pendingOpportunities: this.db.prepare(`
        SELECT * FROM competitor_opportunities
        WHERE label_status = 'pending' AND ts <= ?
        ORDER BY ts ASC LIMIT 1000
      `),
      marketPrices: this.db.prepare(`
        SELECT ts, price FROM competitor_market_events
        WHERE mint = ? AND ts > ? AND ts <= ? AND price_reliable = 1 AND price > 0
        ORDER BY ts ASC
      `),
    };
    if (this._hasSnapshots) {
      this.stmts.latestSnapshot = this.db.prepare(`
        SELECT * FROM token_snapshots
        WHERE mint = ? AND ts <= ?
        ORDER BY ts DESC LIMIT 1
      `);
    }
    if (this._hasSwapEvents) {
      this.stmts.swapPrices = this.db.prepare(`
        SELECT ts, price FROM swap_events
        WHERE mint = ? AND ts > ? AND ts <= ?
          AND feature_eligible = 1 AND price_reliable = 1 AND price > 0
        ORDER BY ts ASC
      `);
    }
  }

  _restoreState() {
    for (const row of this.stmts.loadPositions.all()) {
      this.positionState.set(`${row.wallet}:${row.mint}`, { ...row });
    }
    const cutoff = Date.now() - 24 * 3600_000;
    for (const row of this.stmts.loadRecentTrades.all(cutoff)) {
      this._rememberWalletMint(row.wallet, row.mint, row.ts, true);
    }
    for (const row of this.stmts.loadRecentMarketEvents.all(Date.now() - 190_000)) {
      this._appendMarketBuffer({
        mint: row.mint,
        actorWallet: row.actor_wallet,
        side: row.side,
        solAmount: finite(row.sol_amount, 0),
        price: finite(row.price, null),
        ts: row.ts,
        competitorTradeId: null,
      });
    }
  }

  start() {
    if (this._labelTimer) return;
    const now = Date.now();
    this.db.prepare(`
      UPDATE competitor_capture_sessions
      SET stopped_at = COALESCE(stopped_at, ?), status = 'interrupted'
      WHERE status = 'active'
    `).run(now);
    const session = this.db.prepare(`
      INSERT INTO competitor_capture_sessions
        (started_at, stopped_at, wallets_json, status, details_json)
      VALUES (?, NULL, ?, 'active', ?)
    `).run(
      now,
      safeJson([...this.wallets]),
      safeJson({ captureMode: 'dedicated_wallet_account_subscription' }),
    );
    this._captureSessionId = Number(session.lastInsertRowid);
    for (const wallet of this.wallets) this._ensureCoverage(wallet, now);
    this._labelTimer = setInterval(() => {
      try {
        this.processLabels();
      } catch (err) {
        monitor.recordError('CompetitorForensics', err, { phase: 'labels' });
      }
    }, this.labelIntervalMs);
    this._labelTimer.unref?.();
  }

  stop() {
    if (this._labelTimer) clearInterval(this._labelTimer);
    this._labelTimer = null;
    if (this._captureSessionId) {
      this.db.prepare(`
        UPDATE competitor_capture_sessions
        SET stopped_at = ?, status = 'stopped'
        WHERE id = ?
      `).run(Date.now(), this._captureSessionId);
      this._captureSessionId = null;
    }
  }

  addWallet(wallet) {
    if (!wallet) return;
    this.wallets.add(wallet);
    this._ensureCoverage(wallet, Date.now());
  }

  removeWallet(wallet) {
    this.wallets.delete(wallet);
  }

  _ensureCoverage(wallet, now) {
    this.stmts.upsertCoverage.run({
      wallet,
      subscription_started_at: now,
      last_event_at: null,
      last_slot: null,
      last_region: null,
      last_capture_latency_ms: null,
      max_capture_latency_ms: 0,
      transactions_seen: 0,
      wallet_stream_transactions: 0,
      overlap_stream_transactions: 0,
      trades_parsed: 0,
      non_trade_transactions: 0,
      parse_failures: 0,
      chain_failed_transactions: 0,
      updated_at: now,
    });
  }

  listWallets() {
    return [...this.wallets];
  }

  _insert(table, row, orIgnore = false) {
    const columns = Object.keys(row);
    const cacheKey = `${table}:${orIgnore ? 'ignore' : 'normal'}:${columns.join(',')}`;
    let statement = this._insertSqlCache.get(cacheKey);
    if (!statement) {
      statement = this.db.prepare(
        `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} ` +
        `(${columns.join(',')}) VALUES (${columns.map((column) => `@${column}`).join(',')})`,
      );
      this._insertSqlCache.set(cacheKey, statement);
    }
    const normalized = {};
    for (const column of columns) normalized[column] = row[column] === undefined ? null : row[column];
    return statement.run(normalized);
  }

  _transactionParts(txMessage, streamMeta) {
    const outer = txMessage?.transaction;
    const meta = outer?.meta;
    if (!outer || !meta) return null;
    const message = outer?.transaction?.message || {};
    const allKeys = extractAllKeys(txMessage);
    const slot = finite(txMessage?.slot, null);
    const observedAt = Date.now();
    const estimatedTs = slot != null && this.slotToWallClockMs
      ? finite(this.slotToWallClockMs(slot), null)
      : null;
    const ts = estimatedTs || observedAt;
    const programIds = extractProgramIds(txMessage, allKeys);
    const signature = extractSignature(txMessage);
    const transactionIndex = finite(outer?.index ?? txMessage?.index, null);
    const feeLamports = finite(meta.fee, 0);
    const requiredSignatures = finite(
      message?.header?.numRequiredSignatures,
      outer?.transaction?.signatures?.length || 1,
    );
    const baseFeeLamports = Math.max(0, requiredSignatures || 1) * 5000;
    return {
      outer,
      meta,
      message,
      allKeys,
      slot,
      observedAt,
      ts,
      signature,
      transactionIndex,
      streamRegion: streamMeta?.firstRegion || null,
      captureLatencyMs: Math.max(0, observedAt - ts),
      feeSol: feeLamports / 1e9,
      priorityFeeSol: Math.max(0, feeLamports - baseFeeLamports) / 1e9,
      jitoTipSol: null,
      computeUnits: finite(meta.computeUnitsConsumed, null),
      programIds,
      venue: classifyVenue(programIds),
      transactionError: meta.err || null,
      tokenTotals: this._ownerTokenTotals(meta),
    };
  }

  _ownerTokenTotals(meta) {
    const totals = new Map();
    const add = (balance, field) => {
      const owner = encodeBase58(balance?.owner);
      const mint = encodeBase58(balance?.mint) || balance?.mint || null;
      if (!owner || !mint) return;
      const key = `${owner}:${mint}`;
      const current = totals.get(key) || { owner, mint, before: 0, after: 0 };
      current[field] += tokenAmount(balance.uiTokenAmount);
      totals.set(key, current);
    };
    for (const balance of meta.preTokenBalances || []) add(balance, 'before');
    for (const balance of meta.postTokenBalances || []) add(balance, 'after');
    return totals;
  }

  _nativeBalance(parts, wallet) {
    const index = parts.allKeys.indexOf(wallet);
    if (index < 0) return { before: null, after: null, delta: null, feePayer: false };
    const beforeLamports = finite(parts.meta.preBalances?.[index], null);
    const afterLamports = finite(parts.meta.postBalances?.[index], null);
    if (beforeLamports == null || afterLamports == null) {
      return { before: null, after: null, delta: null, feePayer: index === 0 };
    }
    const before = beforeLamports / 1e9;
    const after = afterLamports / 1e9;
    return { before, after, delta: after - before, feePayer: index === 0 };
  }

  _walletTokenBalance(parts, wallet, mint) {
    return parts.tokenTotals.get(`${wallet}:${mint}`) || {
      owner: wallet,
      mint,
      before: 0,
      after: 0,
    };
  }

  _quoteDetails(parts, wallet) {
    const native = this._nativeBalance(parts, wallet);
    const wsol = this._walletTokenBalance(parts, wallet, WSOL_MINT);
    const wsolDelta = wsol.after - wsol.before;
    const combinedDelta = native.delta == null ? wsolDelta : native.delta + wsolDelta;
    const ancillaryOutflow = (native.feePayer ? parts.feeSol : 0) +
      (parts.jitoTipSol || 0);
    const exFeeDelta = combinedDelta == null
      ? null
      : combinedDelta + ancillaryOutflow;
    return {
      native,
      wsolBefore: wsol.before,
      wsolAfter: wsol.after,
      quoteDeltaSol: exFeeDelta,
      method: native.delta == null
        ? 'wsol_owner_delta'
        : native.feePayer
          ? 'wallet_native_plus_wsol_net_ex_fee'
          : 'wallet_native_plus_wsol_net',
      quality: native.delta == null
        ? 'estimated'
        : 'wallet_balance_fee_tip_adjusted_rent_unresolved',
    };
  }

  _baseTokenDeltas(parts, wallet) {
    const rows = [];
    for (const balance of parts.tokenTotals.values()) {
      if (balance.owner !== wallet || QUOTE_MINTS.has(balance.mint)) continue;
      const delta = balance.after - balance.before;
      if (Math.abs(delta) <= 1e-9) continue;
      rows.push({ ...balance, delta });
    }
    return rows;
  }

  _captureSource(parts) {
    return String(parts.streamRegion || '').startsWith('COMP-')
      ? 'wallet_account_subscription'
      : 'monitored_overlap_subscription';
  }

  _jitoTipSol(parts, wallet) {
    const instructions = [
      ...(parts.message.instructions || parts.message.compiledInstructions || []),
      ...(parts.meta.innerInstructions || []).flatMap((group) => group?.instructions || []),
    ];
    let lamports = 0n;
    for (const instruction of instructions) {
      const programId = parts.allKeys[finite(instruction?.programIdIndex, -1)];
      if (programId !== SYSTEM_PROGRAM_ID) continue;
      const accounts = instruction?.accounts || [];
      const from = parts.allKeys[finite(accounts[0], -1)];
      const to = parts.allKeys[finite(accounts[1], -1)];
      if (from !== wallet || !JITO_TIP_ACCOUNTS.has(to)) continue;
      const data = instructionDataBuffer(instruction?.data);
      if (!data || data.length < 12 || data.readUInt32LE(0) !== 2) continue;
      lamports += data.readBigUInt64LE(4);
    }
    return Number(lamports) / 1e9;
  }

  handleTransaction(txMessage, streamMeta = {}) {
    let parts;
    try {
      parts = this._transactionParts(txMessage, streamMeta);
      if (!parts || !parts.signature) return;
    } catch (err) {
      monitor.recordError('CompetitorForensics', err, { phase: 'parseEnvelope' });
      return;
    }

    const walletsInTransaction = [...this.wallets].filter((wallet) => (
      parts.allKeys.includes(wallet) ||
      [...parts.tokenTotals.values()].some((balance) => balance.owner === wallet)
    ));

    for (const wallet of walletsInTransaction) {
      this._recordWalletTransaction(parts, wallet);
    }

    // Once a competitor has touched a mint, every later transaction for that mint
    // is used to build price labels and negative opportunity samples.
    const shadowMintsInTx = new Set(
      [...parts.tokenTotals.values()]
        .map((balance) => balance.mint)
        .filter((mint) => this.shadowMints.has(mint)),
    );
    for (const mint of shadowMintsInTx) {
      if (walletsInTransaction.some((wallet) => (
        this._baseTokenDeltas(parts, wallet).some((row) => row.mint === mint)
      ))) {
        continue;
      }
      const actor = this._selectMarketActor(parts, mint);
      if (actor) this._recordMarketEvent(parts, actor.wallet, mint, actor.balance, null);
    }
  }

  _recordWalletTransaction(parts, wallet) {
    parts = { ...parts, jitoTipSol: this._jitoTipSol(parts, wallet) };
    const captureSource = this._captureSource(parts);
    const rawEventKey = `${parts.signature}:${wallet}`;
    const deltas = this._baseTokenDeltas(parts, wallet);
    let parsedTrades = 0;
    let parseError = null;
    try {
      if (parts.transactionError) {
        // Failed transactions are evidence of intent, but never mutate positions.
      } else if (deltas.length > 1) {
        throw new Error('ambiguous_multi_asset_quote_allocation');
      } else {
        for (const balance of deltas) {
          const quote = this._quoteDetails(parts, wallet);
          const side = balance.delta > 0 ? 'BUY' : 'SELL';
          const solAmount = quote.quoteDeltaSol == null ? null : Math.abs(quote.quoteDeltaSol);
          // Token-only transfers are retained in the raw transaction table but are
          // not misclassified as strategy trades.
          if (!(solAmount > 0)) continue;
          const tradeId = this._recordForensicTrade(parts, wallet, balance, quote, side);
          if (tradeId) {
            parsedTrades += 1;
            this._recordMarketEvent(parts, wallet, balance.mint, balance, tradeId);
          }
        }
      }
    } catch (err) {
      parseError = err.message || String(err);
      monitor.recordError('CompetitorForensics', err, {
        phase: 'walletTransaction',
        wallet,
        signature: parts.signature,
      });
    }

    const rawInsert = this._insert('competitor_wallet_transactions', {
      event_key: rawEventKey,
      wallet,
      signature: parts.signature,
      ts: parts.ts,
      observed_at: parts.observedAt,
      slot: parts.slot,
      transaction_index: parts.transactionIndex,
      stream_region: parts.streamRegion,
      capture_source: captureSource,
      dedup_status: 'first_seen',
      capture_latency_ms: parts.captureLatencyMs,
      fee_sol: parts.feeSol,
      priority_fee_sol: parts.priorityFeeSol,
      jito_tip_sol: parts.jitoTipSol,
      compute_units: parts.computeUnits,
      venue: parts.venue,
      program_ids_json: safeJson(parts.programIds),
      trade_count: parsedTrades,
      parse_status: parts.transactionError
        ? 'chain_failed'
        : parseError
          ? 'error'
          : parsedTrades > 0
            ? 'trade'
            : 'non_trade',
      parse_error: parseError,
      chain_error_json: safeJson(parts.transactionError),
      details_json: safeJson({
        quoteMintCoverage: 'SOL/WSOL',
        exactTokenBalances: true,
        jitoTipDetection: 'system_transfer_to_known_jito_tip_account',
        rentAdjustment: 'unresolved_and_flagged_in_quote_quality',
      }),
    }, true);

    if (rawInsert.changes === 0) return;
    this.stmts.upsertCoverage.run({
      wallet,
      subscription_started_at: parts.observedAt,
      last_event_at: parts.observedAt,
      last_slot: parts.slot,
      last_region: parts.streamRegion,
      last_capture_latency_ms: parts.captureLatencyMs,
      max_capture_latency_ms: parts.captureLatencyMs,
      transactions_seen: 1,
      wallet_stream_transactions: captureSource === 'wallet_account_subscription' ? 1 : 0,
      overlap_stream_transactions: captureSource === 'monitored_overlap_subscription' ? 1 : 0,
      chain_failed_transactions: parts.transactionError ? 1 : 0,
      trades_parsed: parsedTrades,
      non_trade_transactions: parsedTrades === 0 && !parseError && !parts.transactionError ? 1 : 0,
      parse_failures: parseError ? 1 : 0,
      updated_at: parts.observedAt,
    });
    monitor.beat('CompetitorForensics', parsedTrades > 0 ? 'trade' : 'transaction');
  }

  _recordForensicTrade(parts, wallet, balance, quote, side) {
    const eventKey = `${parts.signature}:${wallet}:${balance.mint}:${side}`;
    const existing = this.stmts.getTradeByKey.get(eventKey);
    if (existing) return existing.id;

    const tokenQty = Math.abs(balance.delta);
    const solAmount = Math.abs(quote.quoteDeltaSol);
    const executionPrice = tokenQty > 0 && solAmount > 0 ? solAmount / tokenQty : null;
    const context = this._contextBefore(balance.mint, parts.ts);
    const referencePrice = positive(context.snapshot?.price, null);
    const executionVsAsofPct = executionPrice > 0 && referencePrice > 0
      ? ((executionPrice - referencePrice) / referencePrice) * 100
      : null;
    const position = this._applyPosition({
      wallet,
      mint: balance.mint,
      side,
      tokenQty,
      tokenBefore: balance.before,
      tokenAfter: balance.after,
      solAmount,
      ts: parts.ts,
    });
    const result = this._insert('competitor_forensic_trades', {
      event_key: eventKey,
      wallet,
      mint: balance.mint,
      side,
      token_amount: tokenQty,
      token_balance_before: balance.before,
      token_balance_after: balance.after,
      native_sol_before: quote.native.before,
      native_sol_after: quote.native.after,
      native_sol_delta: quote.native.delta,
      wsol_before: quote.wsolBefore,
      wsol_after: quote.wsolAfter,
      quote_delta_sol: quote.quoteDeltaSol,
      sol_amount: solAmount,
      execution_price_sol: executionPrice,
      reference_price_sol: referencePrice,
      execution_vs_asof_pct: executionVsAsofPct,
      quote_estimation_method: quote.method,
      quote_quality: quote.quality,
      ts: parts.ts,
      observed_at: parts.observedAt,
      slot: parts.slot,
      transaction_index: parts.transactionIndex,
      signature: parts.signature,
      stream_region: parts.streamRegion,
      capture_source: this._captureSource(parts),
      capture_latency_ms: parts.captureLatencyMs,
      fee_sol: parts.feeSol,
      priority_fee_sol: parts.priorityFeeSol,
      jito_tip_sol: parts.jitoTipSol,
      compute_units: parts.computeUnits,
      venue: parts.venue,
      program_ids_json: safeJson(parts.programIds),
      position_tokens_before: position.tokensBefore,
      position_tokens_after: position.tokensAfter,
      position_cost_sol_before: position.costBefore,
      position_cost_sol_after: position.costAfter,
      position_cost_known_before: position.costKnownBefore ? 1 : 0,
      position_cost_known_after: position.costKnownAfter ? 1 : 0,
      entry_sequence: position.entrySequence,
      sell_fraction_pct: position.sellFractionPct,
      realized_pnl_sol: position.realizedPnlSol,
      realized_pnl_pct: position.realizedPnlPct,
      hold_ms: position.holdMs,
      context_snapshot_id: context.id,
      context_snapshot_ts: context.ts,
      context_lag_ms: context.lagMs,
      context_quality: context.quality,
      context_json: context.json,
      external_context_id: null,
      external_context_lag_ms: null,
      external_context_quality: this.fetchTokenContext ? 'pending' : 'disabled',
      coverage_scope: context.id
        ? 'wallet_full_transactions_plus_monitored_market'
        : 'wallet_full_transactions_pump_jupiter_shadow_market_from_first_observation',
      price_reliable: executionPrice > 0 ? 1 : 0,
      details_json: safeJson({
        feePayer: quote.native.feePayer,
        exactTokenAmount: true,
        exactWalletBalances: true,
        referencePriceDefinition: 'latest_strategy_lab_snapshot_at_or_before_trade',
      }),
      label_status: 'pending',
      label_updated_at: null,
    }, true);
    const tradeId = Number(result.lastInsertRowid);
    this._rememberWalletMint(wallet, balance.mint, parts.ts, true);
    this._requestTokenContext(balance.mint, parts.ts, tradeId);
    monitor.inc(`CompetitorForensics.${side.toLowerCase()}Trades`, 1, 'CompetitorForensics');
    return tradeId;
  }

  _applyPosition({ wallet, mint, side, tokenQty, tokenBefore, tokenAfter, solAmount, ts }) {
    const key = `${wallet}:${mint}`;
    const old = this.positionState.get(key) || {
      wallet,
      mint,
      token_balance: Math.max(0, tokenBefore),
      cost_basis_sol: 0,
      avg_entry_price_sol: null,
      first_buy_ts: null,
      last_trade_ts: null,
      buy_count: 0,
      sell_count: 0,
      realized_pnl_sol: 0,
      cost_basis_known: tokenBefore <= 1e-9 ? 1 : 0,
    };
    const tokensBefore = Math.max(0, finite(old.token_balance, tokenBefore) || 0);
    const costBefore = Math.max(0, finite(old.cost_basis_sol, 0));
    const costKnownBefore = Boolean(old.cost_basis_known) || tokensBefore <= 1e-9;
    let costKnownAfter = costKnownBefore;
    let costAfter = costBefore;
    let entrySequence = null;
    let sellFractionPct = null;
    let realizedPnlSol = null;
    let realizedPnlPct = null;
    let holdMs = null;
    let firstBuyTs = old.first_buy_ts;
    let buyCount = finite(old.buy_count, 0);
    let sellCount = finite(old.sell_count, 0);
    let realizedTotal = finite(old.realized_pnl_sol, 0);

    if (side === 'BUY') {
      buyCount += 1;
      entrySequence = buyCount;
      if (tokenBefore <= 1e-9) {
        costKnownAfter = true;
        costAfter = solAmount;
        firstBuyTs = ts;
      } else if (costKnownBefore) {
        costAfter += solAmount;
      } else {
        costAfter = 0;
      }
    } else {
      sellCount += 1;
      const denominator = Math.max(tokensBefore, tokenBefore, tokenQty);
      const fraction = denominator > 0 ? Math.min(1, tokenQty / denominator) : 1;
      sellFractionPct = fraction * 100;
      if (costKnownBefore) {
        const allocatedCost = costBefore * fraction;
        realizedPnlSol = solAmount - allocatedCost;
        realizedPnlPct = allocatedCost > 0 ? (realizedPnlSol / allocatedCost) * 100 : null;
        realizedTotal += realizedPnlSol;
        costAfter = Math.max(0, costBefore - allocatedCost);
      } else {
        costAfter = 0;
      }
      holdMs = firstBuyTs ? Math.max(0, ts - firstBuyTs) : null;
      if (tokenAfter <= 1e-9) {
        costAfter = 0;
        costKnownAfter = true;
        firstBuyTs = null;
      }
    }

    const tokensAfter = Math.max(0, tokenAfter);
    const next = {
      wallet,
      mint,
      token_balance: tokensAfter,
      cost_basis_sol: costAfter,
      avg_entry_price_sol: tokensAfter > 0 && costAfter > 0 ? costAfter / tokensAfter : null,
      first_buy_ts: firstBuyTs,
      last_trade_ts: ts,
      buy_count: buyCount,
      sell_count: sellCount,
      realized_pnl_sol: realizedTotal,
      cost_basis_known: costKnownAfter ? 1 : 0,
      updated_at: Date.now(),
    };
    this.positionState.set(key, next);
    this.stmts.upsertPosition.run(next);
    return {
      tokensBefore,
      tokensAfter,
      costBefore,
      costAfter,
      costKnownBefore,
      costKnownAfter,
      entrySequence,
      sellFractionPct,
      realizedPnlSol,
      realizedPnlPct,
      holdMs,
    };
  }

  _rememberWalletMint(wallet, mint, ts, notify) {
    if (!this.walletMints.has(mint)) this.walletMints.set(mint, new Map());
    const wallets = this.walletMints.get(mint);
    const firstSeen = wallets.get(wallet);
    wallets.set(wallet, firstSeen || ts);
    const isNew = !this.shadowMints.has(mint);
    this.shadowMints.set(mint, Date.now());
    if (notify && isNew && this.onMintDiscovered) {
      try {
        this.onMintDiscovered(mint);
      } catch (err) {
        monitor.recordError('CompetitorForensics', err, { phase: 'onMintDiscovered', mint });
      }
    }
  }

  _requestTokenContext(mint, eventTs, tradeId) {
    if (!this.fetchTokenContext || !tradeId) return;
    const recent = this.stmts.latestTokenContext.get(mint);
    if (recent && Math.abs(eventTs - recent.event_ts) <= 60_000) {
      this.stmts.linkExternalContext.run(
        recent.id,
        Math.max(0, recent.fetched_at - eventTs),
        'recent_post_trade_api_context',
        tradeId,
      );
      return;
    }

    const pending = this._contextEnrichInFlight.get(mint);
    if (pending) {
      pending.trades.push({ tradeId, eventTs });
      return;
    }
    const request = {
      requestedAt: Date.now(),
      trades: [{ tradeId, eventTs }],
    };
    this._contextEnrichInFlight.set(mint, request);
    const complete = (context, error) => {
      try {
        this._completeTokenContext(mint, request, context, error);
      } catch (err) {
        this._contextEnrichInFlight.delete(mint);
        monitor.recordError('CompetitorForensics', err, {
          phase: 'saveTokenContext',
          mint,
        });
      }
    };
    Promise.resolve()
      .then(() => this.fetchTokenContext(mint))
      .then(
        (context) => complete(context, null),
        (err) => complete(null, err),
      );
  }

  _completeTokenContext(mint, request, context, error) {
    if (this._contextEnrichInFlight.get(mint) !== request) return;
    this._contextEnrichInFlight.delete(mint);
    const fetchedAt = Date.now();
    const eventTs = Math.min(...request.trades.map((trade) => trade.eventTs));
    const creationRaw = finite(
      context?.creationTime ?? context?.creation_time,
      null,
    );
    const creationTime = creationRaw == null
      ? null
      : creationRaw < 10_000_000_000
        ? creationRaw * 1000
        : creationRaw;
    const result = this._insert('competitor_token_contexts', {
      mint,
      event_ts: eventTs,
      requested_at: request.requestedAt,
      fetched_at: fetchedAt,
      fetch_latency_ms: fetchedAt - request.requestedAt,
      symbol: context?.symbol ?? null,
      name: context?.name ?? null,
      decimals: finite(context?.decimals, null),
      supply: finite(context?.supply, null),
      fdv: finite(context?.fdv, null),
      market_cap: finite(context?.marketCap ?? context?.market_cap, null),
      liquidity: finite(context?.liquidity, null),
      price_usd: finite(context?.price ?? context?.priceUsd, null),
      holders: finite(context?.holders, null),
      volume_24h_usd: finite(context?.volume24h, null),
      price_change_24h_pct: finite(context?.priceChange24h, null),
      creation_time: creationTime,
      age_ms_at_event: creationTime == null ? null : Math.max(0, eventTs - creationTime),
      market_source: context?.marketSource ?? null,
      fetch_status: error ? 'error' : 'ok',
      fetch_error: error ? (error.message || String(error)) : null,
      raw_json: safeJson(context),
    }, false);
    const contextId = Number(result.lastInsertRowid);
    const quality = error ? 'api_enrichment_failed' : 'post_trade_api_enrichment';
    for (const trade of request.trades) {
      this.stmts.linkExternalContext.run(
        contextId,
        Math.max(0, fetchedAt - trade.eventTs),
        quality,
        trade.tradeId,
      );
    }
    if (error) {
      monitor.recordError('CompetitorForensics', error, {
        phase: 'tokenContext',
        mint,
      });
    }
  }

  _selectMarketActor(parts, mint) {
    const firstSigner = parts.allKeys[0] || null;
    const candidates = [...parts.tokenTotals.values()]
      .filter((balance) => balance.mint === mint)
      .map((balance) => ({ balance, delta: balance.after - balance.before }))
      .filter((row) => Math.abs(row.delta) > 1e-9);
    const signerMatch = candidates.find((row) => row.balance.owner === firstSigner);
    const selected = signerMatch || candidates
      .filter((row) => parts.allKeys.includes(row.balance.owner))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    return selected ? { wallet: selected.balance.owner, balance: { ...selected.balance, delta: selected.delta } } : null;
  }

  _recordMarketEvent(parts, actorWallet, mint, balance, competitorTradeId) {
    const side = balance.delta > 0 ? 'BUY' : 'SELL';
    const quote = this._quoteDetails(parts, actorWallet);
    const tokenQty = Math.abs(balance.delta);
    const solAmount = quote.quoteDeltaSol == null ? null : Math.abs(quote.quoteDeltaSol);
    const context = this._contextBefore(mint, parts.ts);
    const price = tokenQty > 0 && solAmount > 0
      ? solAmount / tokenQty
      : positive(context.snapshot?.price, null);
    if (!(price > 0)) return null;
    const eventKey = `${parts.signature}:${mint}:${side}:${actorWallet}`;
    const result = this._insert('competitor_market_events', {
      event_key: eventKey,
      mint,
      actor_wallet: actorWallet,
      side,
      token_amount: tokenQty,
      sol_amount: solAmount,
      price,
      ts: parts.ts,
      slot: parts.slot,
      transaction_index: parts.transactionIndex,
      signature: parts.signature,
      stream_region: parts.streamRegion,
      venue: parts.venue,
      source: competitorTradeId ? 'competitor_wallet_trade' : 'competitor_shadow_stream',
      price_reliable: solAmount > 0 ? 1 : context.id ? 1 : 0,
      capture_latency_ms: parts.captureLatencyMs,
      details_json: safeJson({
        quoteQuality: quote.quality,
        contextSnapshotId: context.id,
      }),
    }, true);
    if (result.changes === 0) return null;

    const event = {
      mint,
      actorWallet,
      side,
      solAmount: solAmount || 0,
      price,
      ts: parts.ts,
      competitorTradeId,
    };
    this._recordOpportunitiesBeforeEvent(event, context);
    this._appendMarketBuffer(event);
    return Number(result.lastInsertRowid);
  }

  _appendMarketBuffer(event) {
    if (!this.marketBuffers.has(event.mint)) this.marketBuffers.set(event.mint, []);
    const buffer = this.marketBuffers.get(event.mint);
    buffer.push(event);
    const cutoff = event.ts - 190_000;
    while (buffer.length > 0 && buffer[0].ts < cutoff) buffer.shift();
  }

  _rollingFeatures(mint, ts) {
    const events = this.marketBuffers.get(mint) || [];
    const features = {};
    for (const seconds of FEATURE_WINDOWS_SEC) {
      const window = events.filter((event) => event.ts >= ts - seconds * 1000 && event.ts < ts);
      const buys = window.filter((event) => event.side === 'BUY');
      const sells = window.filter((event) => event.side === 'SELL');
      const buyVolume = buys.reduce((sum, event) => sum + event.solAmount, 0);
      const sellVolume = sells.reduce((sum, event) => sum + event.solAmount, 0);
      const prices = window.map((event) => event.price).filter((price) => price > 0);
      features[`buy_volume_${seconds}s`] = buyVolume;
      features[`sell_volume_${seconds}s`] = sellVolume;
      features[`net_volume_${seconds}s`] = buyVolume - sellVolume;
      features[`buy_count_${seconds}s`] = buys.length;
      features[`sell_count_${seconds}s`] = sells.length;
      features[`unique_buy_wallets_${seconds}s`] = new Set(buys.map((event) => event.actorWallet)).size;
      features[`unique_sell_wallets_${seconds}s`] = new Set(sells.map((event) => event.actorWallet)).size;
      features[`price_change_${seconds}s`] = prices.length >= 2
        ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100
        : null;
    }
    return features;
  }

  _recordOpportunitiesBeforeEvent(event, context) {
    const wallets = this.walletMints.get(event.mint);
    if (!wallets) return;
    const features = this._rollingFeatures(event.mint, event.ts);
    for (const [wallet, coverageStartTs] of wallets) {
      const didBuy = event.competitorTradeId && event.actorWallet === wallet && event.side === 'BUY' ? 1 : 0;
      this.stmts.upsertOpportunity.run({
        wallet,
        mint: event.mint,
        bucket_ts: Math.floor(event.ts / 1000) * 1000,
        ts: event.ts,
        price: event.price,
        did_buy: didBuy,
        competitor_trade_id: didBuy ? event.competitorTradeId : null,
        coverage_start_ts: coverageStartTs,
        observation_scope: context.id
          ? 'monitored_universe_asof_snapshot'
          : 'post_first_competitor_observation_pump_jupiter_only',
        feature_json: safeJson(features),
        context_snapshot_id: context.id,
        context_snapshot_ts: context.ts,
        context_lag_ms: context.lagMs,
        context_quality: context.quality,
      });
    }
  }

  _contextBefore(mint, ts) {
    if (!this.stmts.latestSnapshot) {
      return { id: null, ts: null, lagMs: null, quality: 'no_snapshot_table', json: null, snapshot: null };
    }
    const snapshot = this.stmts.latestSnapshot.get(mint, ts);
    if (!snapshot) {
      return { id: null, ts: null, lagMs: null, quality: 'outside_monitored_universe', json: null, snapshot: null };
    }
    const lagMs = Math.max(0, ts - snapshot.ts);
    const quality = lagMs <= 2000 && snapshot.feature_quality_status === 'trusted'
      ? 'trusted_asof'
      : lagMs <= 10_000
        ? 'stale_or_filtered_asof'
        : 'stale_asof';
    return {
      id: snapshot.id,
      ts: snapshot.ts,
      lagMs,
      quality,
      json: safeJson(snapshot),
      snapshot,
    };
  }

  _labelPrices(mint, startTs, endTs) {
    const market = this.stmts.marketPrices.all(mint, startTs, endTs);
    if (market.length > 0) return market;
    return this.stmts.swapPrices ? this.stmts.swapPrices.all(mint, startTs, endTs) : [];
  }

  _updateLabels(table, row, now) {
    const basePrice = positive(
      table === 'competitor_forensic_trades' ? row.execution_price_sol : row.price,
      null,
    );
    if (!basePrice) {
      this.db.prepare(
        `UPDATE ${table} SET label_status = 'invalid_base_price', label_updated_at = ? WHERE id = ?`,
      ).run(now, row.id);
      return;
    }

    const updates = {};
    let allMatured = true;
    for (const horizon of HORIZONS_SEC) {
      const endTs = row.ts + horizon * 1000;
      const maxColumn = `future_max_${horizon}s_pct`;
      if (row[maxColumn] != null) continue;
      if (now < endTs) {
        allMatured = false;
        continue;
      }
      const prices = this._labelPrices(row.mint, row.ts, endTs)
        .map((item) => positive(item.price, null))
        .filter(Boolean);
      updates[`label_samples_${horizon}s`] = prices.length;
      if (prices.length > 0) {
        const close = prices[prices.length - 1];
        updates[maxColumn] = ((Math.max(...prices) - basePrice) / basePrice) * 100;
        updates[`future_close_${horizon}s_pct`] = ((close - basePrice) / basePrice) * 100;
        updates[`future_drawdown_${horizon}s_pct`] = ((Math.min(...prices) - basePrice) / basePrice) * 100;
      }
    }
    if (Object.keys(updates).length === 0 && !allMatured) return;
    updates.label_status = allMatured ? 'complete' : 'pending';
    updates.label_updated_at = now;
    const assignments = Object.keys(updates).map((column) => `${column} = @${column}`).join(', ');
    this.db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = @id`).run({
      id: row.id,
      ...updates,
    });
  }

  processLabels(now = Date.now()) {
    const matureCutoff = now - 1000;
    const transaction = this.db.transaction(() => {
      for (const row of this.stmts.pendingTrades.all(matureCutoff)) {
        this._updateLabels('competitor_forensic_trades', row, now);
      }
      for (const row of this.stmts.pendingOpportunities.all(matureCutoff)) {
        this._updateLabels('competitor_opportunities', row, now);
      }
    });
    transaction();
    monitor.set(
      'CompetitorForensics.shadowMints',
      this.shadowMints.size,
      'CompetitorForensics',
    );
  }

  getCoverage() {
    return this.db.prepare(`
      SELECT * FROM competitor_capture_coverage ORDER BY wallet
    `).all();
  }

  getRecentForensicTrades(wallet, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM competitor_forensic_trades
      WHERE wallet = ? ORDER BY ts DESC LIMIT ?
    `).all(wallet, Math.max(1, Math.min(1000, Number(limit) || 100)));
  }
}

module.exports = CompetitorForensics;
