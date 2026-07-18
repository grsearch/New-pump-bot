'use strict';

const STRATEGY_LAB_QUALITY_VERSION = 4;

function upperBoundByTs(rows, target) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].ts <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * TradeLogger
 * ===========
 * SQLite-backed persistence for:
 *   - signals  : every detected dump (accepted=1 + rejected ones)
 *   - trades   : every BUY/SELL submission (success or fail)
 *   - positions: open/close lifecycle of each entry
 *
 * Reconstructed from call sites since the module was missing in the v3.17.13
 * handoff zip. Schema choices preserve the column names that PositionManager
 * (row.entry_price, row.opened_at, row.pending_sell_signature, etc.) and the
 * Dashboard SQL ("SELECT DISTINCT mint FROM positions") expect.
 */

class TradeLogger {
  /**
   * @param {Database} db - shared better-sqlite3 instance from TokenRegistry
   */
  constructor(db) {
    if (!db) throw new Error('TradeLogger requires a shared DB instance');
    this.db = db;
    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        kind TEXT,
        sell_sol REAL,
        price_impact_pct REAL,
        seller TEXT,
        seller_tx TEXT,
        notes TEXT,
        accepted INTEGER NOT NULL DEFAULT 0,
        reject_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
      CREATE INDEX IF NOT EXISTS idx_signals_seller_tx_accepted ON signals(seller_tx, accepted);
      CREATE INDEX IF NOT EXISTS idx_signals_mint ON signals(mint);

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id TEXT,
        ts INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        side TEXT,
        sol_amount REAL,
        token_amount REAL,
        price REAL,
        signature TEXT,
        success INTEGER NOT NULL DEFAULT 0,
        dry_run INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        latency_ms INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
      CREATE INDEX IF NOT EXISTS idx_trades_pos ON trades(position_id);

      CREATE TABLE IF NOT EXISTS positions (
        position_id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        symbol TEXT,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        entry_sol REAL,
        entry_price REAL,
        exit_price REAL,
        exit_sol REAL,
        pnl_sol REAL,
        pnl_pct REAL,
        peak_pnl_pct REAL,
        peak_price REAL,
        peak_ts INTEGER,
        time_to_peak_ms INTEGER,
        price_tick_count INTEGER,
        pre_vol_5m_pct REAL,
        token_amount REAL,
        dry_run INTEGER NOT NULL DEFAULT 0,
        buy_signature TEXT,
        sell_signature TEXT,
        buy_fee_lamports INTEGER DEFAULT 0,
        buy_slot INTEGER DEFAULT 0,
        dump_slot INTEGER DEFAULT 0,
        exit_reason TEXT,
        exit_intent TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        sell_attempts INTEGER DEFAULT 0,
        next_retry_at INTEGER,
        last_retry_at INTEGER,
        last_error TEXT,
        pending_sell_signature TEXT,
        stuck_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_positions_opened ON positions(opened_at);
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);

      -- v3.17.31: post-exit price tracking table (backtest)
      CREATE TABLE IF NOT EXISTS price_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        ts INTEGER NOT NULL,
        price REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_price_samples_mint_ts ON price_samples(mint, ts);

      CREATE TABLE IF NOT EXISTS post_exit_stats (
        position_id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        exit_price REAL NOT NULL,
        exit_ts INTEGER NOT NULL,
        max_price REAL NOT NULL,
        max_price_ts INTEGER NOT NULL,
        max_pump_pct REAL NOT NULL,
        min_price REAL NOT NULL,
        min_price_ts INTEGER NOT NULL,
        max_dump_pct REAL NOT NULL,
        sample_count INTEGER NOT NULL,
        snapshots TEXT,
        finalized_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_post_exit_stats_mint ON post_exit_stats(mint);
      CREATE INDEX IF NOT EXISTS idx_post_exit_stats_exit_ts ON post_exit_stats(exit_ts);

      CREATE TABLE IF NOT EXISTS swap_events (
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
        pool_quote_after REAL,
        source TEXT,
        price_reliable INTEGER,
        price_sanitized INTEGER,
        raw_price REAL,
        raw_price_before REAL,
        sanitizer_reason TEXT,
        feature_eligible INTEGER DEFAULT 0,
        data_quality_version INTEGER DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_swap_events_ts ON swap_events(ts);
      CREATE INDEX IF NOT EXISTS idx_swap_events_mint_ts ON swap_events(mint, ts);
      CREATE INDEX IF NOT EXISTS idx_swap_events_signature ON swap_events(signature);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_swap_events_sig_mint_side
        ON swap_events(signature, mint, side)
        WHERE signature IS NOT NULL AND signature != '';
    `);

    // v3.17.19: migrate dump_slot column for upgrading from earlier schemas
    //   SQLite 不支持 ADD COLUMN IF NOT EXISTS,直接尝试,失败就忽略
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN dump_slot INTEGER DEFAULT 0');
    } catch (_) { /* column already exists */ }

    // v3.17.21: entry quality fields for post-hoc analysis
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN entry_fdv REAL');
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN entry_pool_sol REAL');
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN entry_liquidity REAL');
    } catch (_) { /* column already exists */ }

    // v3.17.36: 连环拔回测字段
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN sell_count_10s INTEGER');
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN total_sell_sol_10s REAL');
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN mint_age_at_buy_sec INTEGER');
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN rsi_pre_dump REAL');       // v3.17.38: 砸单前 RSI5s
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN rsi_1s_pre_dump REAL');    // v3.17.38: 砸单前 RSI1s
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN rsi_30s_pre_dump REAL');   // v3.17.42: 砸单前 RSI30s
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN is_ema_strategy INTEGER DEFAULT 0');
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN is_addon INTEGER DEFAULT 0');
    } catch (_) { /* column already exists */ }

    this._ensureColumns('positions', [
      ['peak_pnl_pct', 'REAL'],
      ['peak_price', 'REAL'],
      ['peak_ts', 'INTEGER'],
      ['time_to_peak_ms', 'INTEGER'],
      ['price_tick_count', 'INTEGER'],
      ['pre_vol_5m_pct', 'REAL'],
    ]);
    this._ensureColumns('swap_events', [
      ['source', 'TEXT'],
      ['price_reliable', 'INTEGER'],
      ['price_sanitized', 'INTEGER'],
      ['raw_price', 'REAL'],
      ['raw_price_before', 'REAL'],
      ['sanitizer_reason', 'TEXT'],
      ['feature_eligible', 'INTEGER DEFAULT 0'],
      ['data_quality_version', 'INTEGER DEFAULT 1'],
    ]);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_swap_events_feature_labels
        ON swap_events(mint, ts) WHERE feature_eligible = 1;
    `);

    this._initStrategyLabSchema();
  }

  _strategyLabWindows() {
    return [1, 5, 10, 20, 30, 60];
  }

  _strategyLabHorizons() {
    return [30, 60, 180];
  }

  _snapshotFeatureColumns() {
    const cols = [
      ['ts', 'INTEGER NOT NULL'],
      ['bucket_ts', 'INTEGER NOT NULL'],
      ['mint', 'TEXT NOT NULL'],
      ['symbol', 'TEXT'],
      ['price', 'REAL'],
      ['market_cap', 'REAL'],
      ['fdv', 'REAL'],
      ['liquidity', 'REAL'],
      ['age_ms', 'INTEGER'],
      ['age_min', 'REAL'],
      ['holders', 'INTEGER'],
      ['pool_address', 'TEXT'],
      ['pool_quote_after', 'REAL'],
      ['data_quality_version', 'INTEGER'],
      ['trusted_price_ts', 'INTEGER'],
      ['trusted_price_age_ms', 'INTEGER'],
      ['trusted_event_count_60s', 'INTEGER'],
      ['filtered_event_count_60s', 'INTEGER'],
      ['trusted_volume_sol_60s', 'REAL'],
      ['filtered_volume_sol_60s', 'REAL'],
      ['trusted_event_share_60s', 'REAL'],
      ['trusted_volume_share_60s', 'REAL'],
      ['feature_quality_status', 'TEXT'],
    ];

    const windowMetrics = [
      ['buy_volume', 'REAL'],
      ['sell_volume', 'REAL'],
      ['net_volume', 'REAL'],
      ['buy_sell_ratio', 'REAL'],
      ['buy_count', 'INTEGER'],
      ['sell_count', 'INTEGER'],
      ['tx_count', 'INTEGER'],
      ['unique_buy_wallets', 'INTEGER'],
      ['unique_sell_wallets', 'INTEGER'],
      ['unique_wallets', 'INTEGER'],
      ['new_buy_wallets', 'INTEGER'],
      ['repeat_buy_wallets', 'INTEGER'],
      ['new_sell_wallets', 'INTEGER'],
      ['repeat_sell_wallets', 'INTEGER'],
      ['largest_buy', 'REAL'],
      ['largest_sell', 'REAL'],
      ['avg_buy_size', 'REAL'],
      ['avg_sell_size', 'REAL'],
      ['median_buy_size', 'REAL'],
      ['median_sell_size', 'REAL'],
      ['tx_per_second', 'REAL'],
      ['price_change', 'REAL'],
      ['high', 'REAL'],
      ['low', 'REAL'],
      ['volatility', 'REAL'],
      ['atr', 'REAL'],
    ];

    for (const w of this._strategyLabWindows()) {
      for (const [name, type] of windowMetrics) {
        cols.push([`${name}_${w}s`, type]);
      }
    }

    cols.push(
      ['buy_streak', 'INTEGER'],
      ['sell_streak', 'INTEGER'],
      ['lp_change_60s_pct', 'REAL'],
      ['fdv_change_60s_pct', 'REAL'],
      ['latency_detect_ms', 'INTEGER'],
      ['latency_decision_ms', 'INTEGER'],
      ['latency_send_ms', 'INTEGER'],
      ['latency_confirm_ms', 'INTEGER'],
    );

    for (const horizon of this._strategyLabHorizons()) {
      cols.push(
        [`future_max_${horizon}s_pct`, 'REAL'],
        [`future_close_${horizon}s_pct`, 'REAL'],
        [`future_drawdown_${horizon}s_pct`, 'REAL'],
        [`label_sample_count_${horizon}s`, 'INTEGER'],
      );
    }
    cols.push(
      ['label_status', 'TEXT'],
      ['label_quality_version', 'INTEGER'],
      ['label_updated_at', 'INTEGER'],
    );

    return cols;
  }

  _ensureColumns(tableName, columns) {
    const existing = new Set(this.db.pragma(`table_info(${tableName})`).map((row) => row.name));
    for (const [name, type] of columns) {
      if (!existing.has(name)) {
        const alterType = String(type).replace(/\s+NOT NULL\b/gi, '');
        this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${alterType}`);
      }
    }
  }

  _initStrategyLabSchema() {
    const snapshotColumnsSql = this._snapshotFeatureColumns()
      .map(([name, type]) => `        ${name} ${type}`)
      .join(',\n');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
${snapshotColumnsSql},
        UNIQUE(mint, bucket_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_token_snapshots_ts ON token_snapshots(ts);
      CREATE INDEX IF NOT EXISTS idx_token_snapshots_mint_ts ON token_snapshots(mint, ts);
      CREATE INDEX IF NOT EXISTS idx_token_snapshots_labels ON token_snapshots(label_updated_at, ts);

      CREATE TABLE IF NOT EXISTS token_candles (
        timeframe TEXT NOT NULL,
        bucket_ts INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume_sol REAL,
        buy_volume_sol REAL,
        sell_volume_sol REAL,
        buy_count INTEGER,
        sell_count INTEGER,
        tx_count INTEGER,
        unique_buy_wallets INTEGER,
        unique_sell_wallets INTEGER,
        fdv REAL,
        liquidity REAL,
        data_quality_version INTEGER,
        filtered_event_count INTEGER,
        filtered_volume_sol REAL,
        feature_quality_status TEXT,
        updated_at INTEGER,
        PRIMARY KEY(timeframe, mint, bucket_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_token_candles_mint_timeframe_ts
        ON token_candles(mint, timeframe, bucket_ts);

      CREATE TABLE IF NOT EXISTS token_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT,
        event_type TEXT NOT NULL,
        event_key TEXT NOT NULL,
        price REAL,
        fdv REAL,
        liquidity REAL,
        age_ms INTEGER,
        value REAL,
        details_json TEXT,
        created_at INTEGER,
        UNIQUE(mint, event_type, event_key)
      );
      CREATE INDEX IF NOT EXISTS idx_token_events_ts ON token_events(ts);
      CREATE INDEX IF NOT EXISTS idx_token_events_type_ts ON token_events(event_type, ts);
      CREATE INDEX IF NOT EXISTS idx_token_events_mint_ts ON token_events(mint, ts);

      CREATE TABLE IF NOT EXISTS bot_latency_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        mint TEXT,
        symbol TEXT,
        signature TEXT,
        phase TEXT,
        latency_detect_ms INTEGER,
        latency_decision_ms INTEGER,
        latency_send_ms INTEGER,
        latency_confirm_ms INTEGER,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bot_latency_events_ts ON bot_latency_events(ts);
      CREATE INDEX IF NOT EXISTS idx_bot_latency_events_mint_ts ON bot_latency_events(mint, ts);
    `);

    this._ensureColumns('token_snapshots', this._snapshotFeatureColumns());
    this._ensureColumns('token_candles', [
      ['timeframe', 'TEXT'],
      ['bucket_ts', 'INTEGER'],
      ['mint', 'TEXT'],
      ['symbol', 'TEXT'],
      ['open', 'REAL'],
      ['high', 'REAL'],
      ['low', 'REAL'],
      ['close', 'REAL'],
      ['volume_sol', 'REAL'],
      ['buy_volume_sol', 'REAL'],
      ['sell_volume_sol', 'REAL'],
      ['buy_count', 'INTEGER'],
      ['sell_count', 'INTEGER'],
      ['tx_count', 'INTEGER'],
      ['unique_buy_wallets', 'INTEGER'],
      ['unique_sell_wallets', 'INTEGER'],
      ['fdv', 'REAL'],
      ['liquidity', 'REAL'],
      ['data_quality_version', 'INTEGER'],
      ['filtered_event_count', 'INTEGER'],
      ['filtered_volume_sol', 'REAL'],
      ['feature_quality_status', 'TEXT'],
      ['updated_at', 'INTEGER'],
    ]);
    this._ensureColumns('token_events', [
      ['ts', 'INTEGER'],
      ['mint', 'TEXT'],
      ['symbol', 'TEXT'],
      ['event_type', 'TEXT'],
      ['event_key', 'TEXT'],
      ['price', 'REAL'],
      ['fdv', 'REAL'],
      ['liquidity', 'REAL'],
      ['age_ms', 'INTEGER'],
      ['value', 'REAL'],
      ['details_json', 'TEXT'],
      ['created_at', 'INTEGER'],
    ]);
    this._ensureColumns('bot_latency_events', [
      ['ts', 'INTEGER'],
      ['mint', 'TEXT'],
      ['symbol', 'TEXT'],
      ['signature', 'TEXT'],
      ['phase', 'TEXT'],
      ['latency_detect_ms', 'INTEGER'],
      ['latency_decision_ms', 'INTEGER'],
      ['latency_send_ms', 'INTEGER'],
      ['latency_confirm_ms', 'INTEGER'],
      ['details_json', 'TEXT'],
    ]);
  }

  _prepareStatements() {
    this.stmts = {
      // ============ signals ============
      insertSignal: this.db.prepare(`
        INSERT INTO signals
          (ts, mint, symbol, kind, sell_sol, price_impact_pct, seller, seller_tx, notes, accepted, reject_reason)
        VALUES (@ts, @mint, @symbol, @kind, @sellSol, @priceImpactPct, @seller, @sellerTx, @notes, @accepted, @rejectReason)
      `),

      recentAcceptedSellerTxs: this.db.prepare(`
        SELECT seller_tx, ts FROM signals
        WHERE accepted = 1 AND seller_tx IS NOT NULL AND seller_tx != ''
          AND ts >= ?
        ORDER BY ts DESC
        LIMIT 5000
      `),

      signalsInRange: this.db.prepare(`
        SELECT * FROM signals WHERE ts >= ? AND ts < ? ORDER BY ts ASC
      `),

      recentSignals: this.db.prepare(`
        SELECT * FROM signals ORDER BY ts DESC LIMIT ?
      `),

      // ============ trades ============
      insertTrade: this.db.prepare(`
        INSERT INTO trades
          (position_id, ts, mint, symbol, side, sol_amount, token_amount, price, signature,
           success, dry_run, reason, latency_ms, error)
        VALUES (@positionId, @ts, @mint, @symbol, @side, @solAmount, @tokenAmount, @price, @signature,
                @success, @dryRun, @reason, @latencyMs, @error)
      `),

      tradesInRange: this.db.prepare(`
        SELECT * FROM trades WHERE ts >= ? AND ts < ? ORDER BY ts ASC
      `),

      recentTrades: this.db.prepare(`
        SELECT * FROM trades ORDER BY ts DESC LIMIT ?
      `),

      // ============ swap_events ============
      insertSwapEvent: this.db.prepare(`
        INSERT OR IGNORE INTO swap_events
          (ts, mint, symbol, signer, side, sol_volume, price, price_before, price_change_pct,
           slot, signature, pool_address, pool_quote_after, source, price_reliable,
           price_sanitized, raw_price, raw_price_before, sanitizer_reason, feature_eligible,
           data_quality_version)
        VALUES
          (@ts, @mint, @symbol, @signer, @side, @solVolume, @price, @priceBefore, @priceChangePct,
           @slot, @signature, @poolAddress, @poolQuoteAfter, @source, @priceReliable,
            @priceSanitized, @rawPrice, @rawPriceBefore, @sanitizerReason, @featureEligible,
            @dataQualityVersion)
      `),

      swapEventsInRange: this.db.prepare(`
        SELECT * FROM swap_events WHERE ts >= ? AND ts < ? ORDER BY mint, ts ASC
      `),

      // ============ positions ============
      openPosition: this.db.prepare(`
        INSERT INTO positions
          (position_id, mint, symbol, opened_at, entry_sol, entry_price, token_amount,
           dry_run, buy_signature, buy_fee_lamports, buy_slot, dump_slot,
           entry_fdv, entry_pool_sol, entry_liquidity,
           sell_count_10s, total_sell_sol_10s,
           mint_age_at_buy_sec, rsi_pre_dump, rsi_1s_pre_dump, rsi_30s_pre_dump,
           is_ema_strategy, is_addon, status)
        VALUES (@positionId, @mint, @symbol, @openedAt, @entrySol, @entryPrice, @tokenAmount,
                @dryRun, @buySignature, @buyFeeLamports, @buySlot, @dumpSlot,
                @entryFdv, @entryPoolSol, @entryLiquidity,
                @sellCount10s, @totalSellSol10s,
                @mintAgeAtBuySec, @rsiPreDump, @rsi1sPreDump, @rsi30sPreDump,
                @isEmaStrategy, @isAddOn, 'open')
        ON CONFLICT(position_id) DO UPDATE SET
          opened_at = excluded.opened_at,
          entry_sol = excluded.entry_sol,
          entry_price = excluded.entry_price,
          token_amount = excluded.token_amount,
          buy_signature = excluded.buy_signature,
          buy_fee_lamports = excluded.buy_fee_lamports,
          buy_slot = excluded.buy_slot,
          dump_slot = excluded.dump_slot,
          entry_fdv = excluded.entry_fdv,
          entry_pool_sol = excluded.entry_pool_sol,
          entry_liquidity = excluded.entry_liquidity,
          sell_count_10s = excluded.sell_count_10s,
          total_sell_sol_10s = excluded.total_sell_sol_10s,
          mint_age_at_buy_sec = excluded.mint_age_at_buy_sec,
          rsi_pre_dump = excluded.rsi_pre_dump,
          rsi_1s_pre_dump = excluded.rsi_1s_pre_dump,
          rsi_30s_pre_dump = excluded.rsi_30s_pre_dump,
          is_ema_strategy = excluded.is_ema_strategy,
          is_addon = excluded.is_addon,
          status = 'open'
      `),

      updateEntry: this.db.prepare(`
        UPDATE positions SET
          entry_sol = @entrySol,
          entry_price = @entryPrice,
          token_amount = @tokenAmount,
          buy_fee_lamports = @buyFeeLamports
        WHERE position_id = @positionId
      `),

      closePosition: this.db.prepare(`
        UPDATE positions SET
          closed_at = @closedAt,
          exit_price = @exitPrice,
          exit_sol = @exitSol,
          pnl_sol = @pnlSol,
          pnl_pct = @pnlPct,
          exit_reason = @exitReason,
          sell_signature = @sellSignature,
          peak_pnl_pct = @peakPnlPct,
          peak_price = @peakPrice,
          peak_ts = @peakTs,
          time_to_peak_ms = @timeToPeakMs,
          price_tick_count = @priceTickCount,
          status = 'closed'
        WHERE position_id = @positionId
      `),

      updatePeak: this.db.prepare(`
        UPDATE positions SET
          peak_price = @peakPrice,
          peak_ts = @peakTs,
          peak_pnl_pct = @peakPnlPct
        WHERE position_id = @positionId
      `),

      markSellPending: this.db.prepare(`
        UPDATE positions SET
          status = 'sell_confirming',
          pending_sell_signature = ?,
          exit_intent = ?,
          last_retry_at = ?
        WHERE position_id = ?
      `),

      markSellFailedPendingRetry: this.db.prepare(`
        UPDATE positions SET
          status = 'sell_pending',
          next_retry_at = ?,
          last_error = ?,
          exit_intent = ?,
          last_retry_at = ?
        WHERE position_id = ?
      `),

      markStuck: this.db.prepare(`
        UPDATE positions SET
          status = 'stuck',
          stuck_reason = ?,
          last_retry_at = ?
        WHERE position_id = ?
      `),

      recordSellAttempt: this.db.prepare(`
        UPDATE positions SET
          sell_attempts = COALESCE(sell_attempts, 0) + 1,
          last_error = ?,
          last_retry_at = ?
        WHERE position_id = ?
      `),

      // PositionManager.restoreFromDb expects open + sell_pending + sell_confirming + stuck
      getOpenPositions: this.db.prepare(`
        SELECT * FROM positions
        WHERE status IN ('open', 'sell_pending', 'sell_confirming', 'stuck')
        ORDER BY opened_at ASC
      `),

      getDuePendingRetries: this.db.prepare(`
        SELECT * FROM positions
        WHERE status IN ('sell_pending', 'sell_confirming')
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
      `),

      positionsInRange: this.db.prepare(`
        SELECT * FROM positions
        WHERE closed_at IS NOT NULL AND closed_at >= ? AND closed_at < ?
        ORDER BY opened_at ASC
      `),

      recentPositions: this.db.prepare(`
        SELECT *, pre_vol_5m_pct as pre_vol_5m FROM positions ORDER BY opened_at DESC LIMIT ?
      `),

      // ============ price_samples ============
      insertPriceSample: this.db.prepare(`
        INSERT INTO price_samples (mint, ts, price) VALUES (@mint, @ts, @price)
      `),

      loadRecentPriceSamples: this.db.prepare(`
        SELECT mint, ts, price FROM price_samples
        WHERE ts >= ?
        ORDER BY mint, ts ASC
      `),

      cleanOldPriceSamples: this.db.prepare(`
        DELETE FROM price_samples WHERE ts < ?
      `),

      stuckPositions: this.db.prepare(`
        SELECT * FROM positions WHERE status = 'stuck' ORDER BY opened_at DESC
      `),
    };

    this._prepareStrategyLabStatements();
  }

  _snapshotColumnNames() {
    return this._snapshotFeatureColumns().map(([name]) => name);
  }

  _prepareStrategyLabStatements() {
    const snapshotColumns = this._snapshotColumnNames();
    const snapshotInsertColumns = snapshotColumns.join(', ');
    const snapshotInsertParams = snapshotColumns.map((name) => `@${name}`).join(', ');
    const snapshotUpdateColumns = snapshotColumns
      .filter((name) => name !== 'mint' && name !== 'bucket_ts')
      .filter((name) => !name.startsWith('future_') && !name.startsWith('label_'))
      .map((name) => `${name} = excluded.${name}`)
      .join(',\n          ');

    this.stmts.upsertTokenSnapshot = this.db.prepare(`
      INSERT INTO token_snapshots (${snapshotInsertColumns})
      VALUES (${snapshotInsertParams})
      ON CONFLICT(mint, bucket_ts) DO UPDATE SET
          ${snapshotUpdateColumns}
    `);

    this.stmts.upsertTokenCandle = this.db.prepare(`
      INSERT INTO token_candles
        (timeframe, bucket_ts, mint, symbol, open, high, low, close,
         volume_sol, buy_volume_sol, sell_volume_sol, buy_count, sell_count, tx_count,
         unique_buy_wallets, unique_sell_wallets, fdv, liquidity, data_quality_version,
         filtered_event_count, filtered_volume_sol, feature_quality_status, updated_at)
      VALUES
        (@timeframe, @bucket_ts, @mint, @symbol, @open, @high, @low, @close,
         @volume_sol, @buy_volume_sol, @sell_volume_sol, @buy_count, @sell_count, @tx_count,
          @unique_buy_wallets, @unique_sell_wallets, @fdv, @liquidity, @data_quality_version,
          @filtered_event_count, @filtered_volume_sol, @feature_quality_status, @updated_at)
      ON CONFLICT(timeframe, mint, bucket_ts) DO UPDATE SET
        symbol = excluded.symbol,
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume_sol = excluded.volume_sol,
        buy_volume_sol = excluded.buy_volume_sol,
        sell_volume_sol = excluded.sell_volume_sol,
        buy_count = excluded.buy_count,
        sell_count = excluded.sell_count,
        tx_count = excluded.tx_count,
        unique_buy_wallets = excluded.unique_buy_wallets,
        unique_sell_wallets = excluded.unique_sell_wallets,
        fdv = excluded.fdv,
        liquidity = excluded.liquidity,
        data_quality_version = excluded.data_quality_version,
        filtered_event_count = excluded.filtered_event_count,
        filtered_volume_sol = excluded.filtered_volume_sol,
        feature_quality_status = excluded.feature_quality_status,
        updated_at = excluded.updated_at
    `);

    this.stmts.insertTokenEvent = this.db.prepare(`
      INSERT OR IGNORE INTO token_events
        (ts, mint, symbol, event_type, event_key, price, fdv, liquidity, age_ms, value, details_json, created_at)
      VALUES
        (@ts, @mint, @symbol, @event_type, @event_key, @price, @fdv, @liquidity, @age_ms, @value, @details_json, @created_at)
    `);

    this.stmts.insertBotLatencyEvent = this.db.prepare(`
      INSERT INTO bot_latency_events
        (ts, mint, symbol, signature, phase,
         latency_detect_ms, latency_decision_ms, latency_send_ms, latency_confirm_ms, details_json)
      VALUES
        (@ts, @mint, @symbol, @signature, @phase,
         @latency_detect_ms, @latency_decision_ms, @latency_send_ms, @latency_confirm_ms, @details_json)
    `);

    this.stmts.pendingSnapshotLabels = this.db.prepare(`
      SELECT id, mint, ts, price
      FROM token_snapshots
      WHERE price > 0
        AND COALESCE(data_quality_version, 1) >= @min_quality_version
        AND trusted_price_ts IS NOT NULL
        AND COALESCE(feature_quality_status, '') IN ('trusted', 'mixed_filtered', 'quiet')
        AND ts <= @mature_before
        AND label_updated_at IS NULL
      ORDER BY ts ASC
      LIMIT @limit
    `);

    this.stmts.futurePricesForLabel = this.db.prepare(`
      SELECT ts, price
      FROM swap_events
      WHERE mint = @mint
        AND ts > @from_ts
        AND ts <= @until_ts
        AND price > 0
        AND COALESCE(data_quality_version, 1) >= @min_quality_version
        AND COALESCE(feature_eligible, 0) = 1
        AND COALESCE(price_reliable, 0) = 1
        ORDER BY ts ASC, id ASC
    `);

    this.stmts.snapshotLabelBacklog = this.db.prepare(`
      SELECT COUNT(*) AS count, MIN(ts) AS oldest_ts, MAX(ts) AS newest_ts
      FROM token_snapshots
      WHERE price > 0
        AND COALESCE(data_quality_version, 1) >= @min_quality_version
        AND trusted_price_ts IS NOT NULL
        AND COALESCE(feature_quality_status, '') IN ('trusted', 'mixed_filtered', 'quiet')
        AND ts <= @mature_before
        AND label_updated_at IS NULL
    `);

    this.stmts.updateSnapshotLabels = this.db.prepare(`
      UPDATE token_snapshots SET
        future_max_30s_pct = @future_max_30s_pct,
        future_close_30s_pct = @future_close_30s_pct,
        future_drawdown_30s_pct = @future_drawdown_30s_pct,
        label_sample_count_30s = @label_sample_count_30s,
        future_max_60s_pct = @future_max_60s_pct,
        future_close_60s_pct = @future_close_60s_pct,
        future_drawdown_60s_pct = @future_drawdown_60s_pct,
        label_sample_count_60s = @label_sample_count_60s,
        future_max_180s_pct = @future_max_180s_pct,
        future_close_180s_pct = @future_close_180s_pct,
        future_drawdown_180s_pct = @future_drawdown_180s_pct,
        label_sample_count_180s = @label_sample_count_180s,
        label_status = @label_status,
        label_quality_version = @label_quality_version,
        label_updated_at = @label_updated_at
      WHERE id = @id
    `);
  }

  // ============================================================
  // Signal API
  // ============================================================

  logSignal({ ts, mint, symbol, kind, sellSol, priceImpactPct, seller, sellerTx,
             notes, accepted, rejectReason }) {
    this.stmts.insertSignal.run({
      ts: ts || Date.now(),
      mint: mint || null,
      symbol: symbol || null,
      kind: kind || null,
      sellSol: sellSol ?? null,
      priceImpactPct: priceImpactPct ?? null,
      seller: seller || null,
      sellerTx: sellerTx || null,
      notes: notes || null,
      accepted: accepted ? 1 : 0,
      rejectReason: rejectReason || null,
    });
  }

  /** SignalEngine._restoreSellerTxsFromDb expects rows with seller_tx/ts. */
  getRecentAcceptedSellerTxs(dedupMs) {
    const cutoff = Date.now() - dedupMs;
    return this.stmts.recentAcceptedSellerTxs.all(cutoff);
  }

  // ============================================================
  // Trade API
  // ============================================================

  logTrade({ positionId, ts, mint, symbol, side, solAmount, tokenAmount, price, signature,
             success, dryRun, reason, latencyMs, error }) {
    this.stmts.insertTrade.run({
      positionId: positionId || null,
      ts: ts || Date.now(),
      mint: mint || null,
      symbol: symbol || null,
      side: side || null,
      solAmount: solAmount ?? null,
      tokenAmount: tokenAmount ?? null,
      price: price ?? null,
      signature: signature || null,
      success: success ? 1 : 0,
      dryRun: dryRun ? 1 : 0,
      reason: reason || null,
      latencyMs: latencyMs ?? null,
      error: error || null,
    });
  }

  logSwapEvent(swap) {
    if (!swap || !swap.mint) return;
    const side = String(swap.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return;

    const num = (value) => {
      if (value == null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    try {
      this.stmts.insertSwapEvent.run({
        ts: num(swap.ts) || Date.now(),
        mint: swap.mint,
        symbol: swap.symbol || null,
        signer: swap.signer || null,
        side,
        solVolume: num(swap.solVolume),
        price: num(swap.price),
        priceBefore: num(swap.priceBefore),
        priceChangePct: num(swap.priceChangePct),
        slot: num(swap.slot),
        signature: swap.signature || null,
        poolAddress: swap.poolAddress || null,
        poolQuoteAfter: num(swap.poolQuoteAfter),
        source: swap.source || null,
        priceReliable: swap.priceReliable ? 1 : 0,
        priceSanitized: swap.priceSanitized ? 1 : 0,
        rawPrice: num(swap.rawPrice),
        rawPriceBefore: num(swap.rawPriceBefore),
        sanitizerReason: swap.sanitizerReason || null,
        featureEligible: swap.featureEligible === true ? 1 : 0,
        dataQualityVersion: num(swap.dataQualityVersion) || 1,
      });
    } catch (_) { /* best effort; strategy must never block on analytics writes */ }
  }

  // ============================================================
  // Strategy Lab API
  // ============================================================

  _cleanDbValue(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value ?? null;
  }

  saveTokenSnapshot(snapshot) {
    if (!snapshot || !snapshot.mint) return;
    const row = {};
    for (const name of this._snapshotColumnNames()) {
      row[name] = this._cleanDbValue(snapshot[name]);
    }
    row.ts = row.ts || Date.now();
    row.bucket_ts = row.bucket_ts || row.ts;
    try {
      this.stmts.upsertTokenSnapshot.run(row);
    } catch (_) { /* analytics only */ }
  }

  saveTokenCandle(candle) {
    if (!candle || !candle.mint || !candle.timeframe || !candle.bucket_ts) return;
    const row = {
      timeframe: candle.timeframe,
      bucket_ts: candle.bucket_ts,
      mint: candle.mint,
      symbol: candle.symbol || null,
      open: this._cleanDbValue(candle.open),
      high: this._cleanDbValue(candle.high),
      low: this._cleanDbValue(candle.low),
      close: this._cleanDbValue(candle.close),
      volume_sol: this._cleanDbValue(candle.volume_sol),
      buy_volume_sol: this._cleanDbValue(candle.buy_volume_sol),
      sell_volume_sol: this._cleanDbValue(candle.sell_volume_sol),
      buy_count: this._cleanDbValue(candle.buy_count),
      sell_count: this._cleanDbValue(candle.sell_count),
      tx_count: this._cleanDbValue(candle.tx_count),
      unique_buy_wallets: this._cleanDbValue(candle.unique_buy_wallets),
      unique_sell_wallets: this._cleanDbValue(candle.unique_sell_wallets),
      fdv: this._cleanDbValue(candle.fdv),
      liquidity: this._cleanDbValue(candle.liquidity),
      data_quality_version: this._cleanDbValue(candle.data_quality_version),
      filtered_event_count: this._cleanDbValue(candle.filtered_event_count),
      filtered_volume_sol: this._cleanDbValue(candle.filtered_volume_sol),
      feature_quality_status: candle.feature_quality_status || null,
      updated_at: candle.updated_at || Date.now(),
    };
    try {
      this.stmts.upsertTokenCandle.run(row);
    } catch (_) { /* analytics only */ }
  }

  logTokenEvent(event) {
    if (!event || !event.mint || !event.eventType) return;
    const details = event.detailsJson != null
      ? event.detailsJson
      : (event.details == null ? null : JSON.stringify(event.details));
    try {
      this.stmts.insertTokenEvent.run({
        ts: event.ts || Date.now(),
        mint: event.mint,
        symbol: event.symbol || null,
        event_type: event.eventType,
        event_key: event.eventKey || 'first',
        price: this._cleanDbValue(event.price),
        fdv: this._cleanDbValue(event.fdv),
        liquidity: this._cleanDbValue(event.liquidity),
        age_ms: this._cleanDbValue(event.ageMs),
        value: this._cleanDbValue(event.value),
        details_json: details,
        created_at: Date.now(),
      });
    } catch (_) { /* analytics only */ }
  }

  logBotLatencyEvent(event) {
    if (!event) return;
    const details = event.detailsJson != null
      ? event.detailsJson
      : (event.details == null ? null : JSON.stringify(event.details));
    try {
      this.stmts.insertBotLatencyEvent.run({
        ts: event.ts || Date.now(),
        mint: event.mint || null,
        symbol: event.symbol || null,
        signature: event.signature || null,
        phase: event.phase || null,
        latency_detect_ms: this._cleanDbValue(event.latencyDetectMs),
        latency_decision_ms: this._cleanDbValue(event.latencyDecisionMs),
        latency_send_ms: this._cleanDbValue(event.latencySendMs),
        latency_confirm_ms: this._cleanDbValue(event.latencyConfirmMs),
        details_json: details,
      });
    } catch (_) { /* analytics only */ }
  }

  getSnapshotLabelBacklog({ now = Date.now(), minQualityVersion = STRATEGY_LAB_QUALITY_VERSION } = {}) {
    const maxHorizonMs = Math.max(...this._strategyLabHorizons()) * 1000;
    const row = this.stmts.snapshotLabelBacklog.get({
      min_quality_version: minQualityVersion,
      mature_before: now - maxHorizonMs,
    });
    const oldestTs = Number(row?.oldest_ts) || null;
    return {
      count: Number(row?.count) || 0,
      oldestTs,
      newestTs: Number(row?.newest_ts) || null,
      oldestAgeMs: oldestTs ? Math.max(0, now - maxHorizonMs - oldestTs) : 0,
      minQualityVersion,
    };
  }

  backfillSnapshotLabels({
    now = Date.now(),
    batchSize = 1000,
    minQualityVersion = STRATEGY_LAB_QUALITY_VERSION,
  } = {}) {
    const horizons = this._strategyLabHorizons();
    const maxHorizonMs = Math.max(...horizons) * 1000;
    try {
      const pending = this.stmts.pendingSnapshotLabels.all({
        min_quality_version: minQualityVersion,
        mature_before: now - maxHorizonMs,
        limit: Math.max(1, Math.floor(batchSize)),
      });
      if (pending.length === 0) return 0;

      const byMint = new Map();
      for (const snap of pending) {
        if (!byMint.has(snap.mint)) byMint.set(snap.mint, []);
        byMint.get(snap.mint).push(snap);
      }

      const updates = [];
      for (const [mint, snapshots] of byMint) {
        snapshots.sort((left, right) => left.ts - right.ts);
        const prices = this.stmts.futurePricesForLabel.all({
          mint,
          from_ts: snapshots[0].ts,
          until_ts: snapshots[snapshots.length - 1].ts + maxHorizonMs,
          min_quality_version: minQualityVersion,
        }).map((row) => ({ ts: Number(row.ts), price: Number(row.price) }));

        for (const snap of snapshots) {
          const basePrice = Number(snap.price);
          if (!Number.isFinite(basePrice) || basePrice <= 0) continue;
          const start = upperBoundByTs(prices, snap.ts);
          const params = {
            id: snap.id,
            label_updated_at: now,
            label_status: 'complete',
            label_quality_version: minQualityVersion,
          };

          for (const horizon of horizons) {
            const until = snap.ts + horizon * 1000;
            const end = upperBoundByTs(prices, until);
            let maxPrice = basePrice;
            let minPrice = basePrice;
            let closePrice = basePrice;
            let sampleCount = 0;
            for (let index = start; index < end; index++) {
              const price = prices[index].price;
              if (!Number.isFinite(price) || price <= 0) continue;
              maxPrice = Math.max(maxPrice, price);
              minPrice = Math.min(minPrice, price);
              closePrice = price;
              sampleCount++;
            }
            params[`future_max_${horizon}s_pct`] = ((maxPrice - basePrice) / basePrice) * 100;
            params[`future_close_${horizon}s_pct`] = ((closePrice - basePrice) / basePrice) * 100;
            params[`future_drawdown_${horizon}s_pct`] = ((minPrice - basePrice) / basePrice) * 100;
            params[`label_sample_count_${horizon}s`] = sampleCount;
          }
          updates.push(params);
        }
      }

      const applyUpdates = () => {
        for (const params of updates) this.stmts.updateSnapshotLabels.run(params);
      };
      if (typeof this.db.transaction === 'function') this.db.transaction(applyUpdates)();
      else applyUpdates();
      return updates.length;
    } catch (error) {
      throw new Error(`Strategy Lab label backfill failed: ${error.message}`);
    }
  }

  // ============================================================
  // Position lifecycle API
  // ============================================================

  openPosition({ positionId, mint, symbol, openedAt, entrySol, entryPrice, tokenAmount,
                 dryRun, buySignature, buyFeeLamports, buySlot, dumpSlot,
                 entryFdv, entryPoolSol, entryLiquidity,
                 sellCount10s, totalSellSol10s,
                 mintAgeAtBuySec, rsiPreDump, rsi1sPreDump, rsi30sPreDump,
                 isEmaStrategy = 0, isAddOn = 0 }) {
    this.stmts.openPosition.run({
      positionId,
      mint,
      symbol: symbol || null,
      openedAt: openedAt || Date.now(),
      entrySol: entrySol ?? null,
      entryPrice: entryPrice ?? null,
      tokenAmount: tokenAmount ?? null,
      dryRun: dryRun ? 1 : 0,
      buySignature: buySignature || null,
      buyFeeLamports: buyFeeLamports || 0,
      buySlot: buySlot || 0,
      dumpSlot: dumpSlot || 0,
      entryFdv: entryFdv ?? null,
      entryPoolSol: entryPoolSol ?? null,
      entryLiquidity: entryLiquidity ?? null,
      sellCount10s: sellCount10s ?? null,        // v3.17.36: 连环拔回测
      totalSellSol10s: totalSellSol10s ?? null,  // v3.17.36: 连环拔回测
      mintAgeAtBuySec: mintAgeAtBuySec ?? null,  // v3.17.39: 首信号到买入的秒数
      rsiPreDump: rsiPreDump ?? null,              // v3.17.38: 砸单前 RSI5s
      rsi1sPreDump: rsi1sPreDump ?? null,          // v3.17.38: 砸单前 RSI1s
      rsi30sPreDump: rsi30sPreDump ?? null,        // v3.17.42: 砸单前 RSI30s
      isEmaStrategy: isEmaStrategy ?? 0,            // EMA策略标记
      isAddOn: isAddOn ?? 0,                       // 加仓标记
    });
  }

  updatePositionEntry(positionId, { entrySol, entryPrice, tokenAmount, buyFeeLamports, buySlot, dumpSlot }) {
    // v3.17.20-fix: 支持 buySlot/dumpSlot 更新
    const hasSlotUpdate = buySlot != null || dumpSlot != null;
    if (hasSlotUpdate) {
      this.db.prepare(`
        UPDATE positions SET
          entry_sol = @entrySol,
          entry_price = @entryPrice,
          token_amount = @tokenAmount,
          buy_fee_lamports = @buyFeeLamports,
          buy_slot = COALESCE(@buySlot, buy_slot),
          dump_slot = COALESCE(@dumpSlot, dump_slot)
        WHERE position_id = @positionId
      `).run({
        positionId,
        entrySol: entrySol ?? null,
        entryPrice: entryPrice ?? null,
        tokenAmount: tokenAmount ?? null,
        buyFeeLamports: buyFeeLamports ?? 0,
        buySlot: buySlot ?? null,
        dumpSlot: dumpSlot ?? null,
      });
    } else {
      this.stmts.updateEntry.run({
        positionId,
        entrySol: entrySol ?? null,
        entryPrice: entryPrice ?? null,
        tokenAmount: tokenAmount ?? null,
        buyFeeLamports: buyFeeLamports ?? 0,
      });
    }
  }

  closePosition(positionId, { closedAt, exitPrice, exitSol, pnlSol, pnlPct, exitReason, sellSignature, peakPnlPct, peakPrice, peakTs, timeToPeakMs, priceTickCount }) {
    this.stmts.closePosition.run({
      positionId,
      closedAt: closedAt || Date.now(),
      exitPrice: exitPrice ?? null,
      exitSol: exitSol ?? null,
      pnlSol: pnlSol ?? null,
      pnlPct: pnlPct ?? null,
      exitReason: exitReason || null,
      sellSignature: sellSignature || null,
      peakPnlPct: peakPnlPct ?? null,
      peakPrice: peakPrice ?? null,
      peakTs: peakTs ?? null,
      timeToPeakMs: timeToPeakMs ?? null,
      priceTickCount: priceTickCount ?? 0,
    });
  }

  // v3.17.31: 平仓后价格追踪写入
  recordPostExitStats({ positionId, mint, exitPrice, exitTs, maxPrice, maxPriceTs,
    maxPumpPct, minPrice, minPriceTs, maxDumpPct, sampleCount,
    snapshots, finalizedAt }) {
    if (!this.stmts.recordPostExitStats) {
      this.stmts.recordPostExitStats = this.db.prepare(`
        INSERT OR REPLACE INTO post_exit_stats (
          position_id, mint, exit_price, exit_ts,
          max_price, max_price_ts, max_pump_pct,
          min_price, min_price_ts, max_dump_pct,
          sample_count, snapshots, finalized_at
        ) VALUES (
          @positionId, @mint, @exitPrice, @exitTs,
          @maxPrice, @maxPriceTs, @maxPumpPct,
          @minPrice, @minPriceTs, @maxDumpPct,
          @sampleCount, @snapshots, @finalizedAt
        )
      `);
    }
    this.stmts.recordPostExitStats.run({
      positionId, mint, exitPrice, exitTs,
      maxPrice, maxPriceTs, maxPumpPct,
      minPrice, minPriceTs, maxDumpPct,
      sampleCount, snapshots, finalizedAt,
    });
  }

  markSellPending(positionId, signature, exitReason) {
    this.stmts.markSellPending.run(signature || null, exitReason || null, Date.now(), positionId);
  }

  markSellFailedPendingRetry(positionId, nextRetryAt, errorMsg, exitReason) {
    this.stmts.markSellFailedPendingRetry.run(
      nextRetryAt,
      errorMsg || null,
      exitReason || null,
      Date.now(),
      positionId,
    );
  }

  markStuck(positionId, reason) {
    this.stmts.markStuck.run(reason || null, Date.now(), positionId);
  }

  recordSellAttempt(positionId, errorMsg) {
    this.stmts.recordSellAttempt.run(errorMsg || null, Date.now(), positionId);
  }

  getOpenPositions() {
    return this.stmts.getOpenPositions.all();
  }

  getDuePendingRetries(now) {
    return this.stmts.getDuePendingRetries.all(now);
  }

  // ============================================================
  // Reporting / dashboard queries
  // ============================================================

  getSignalsInRange(startMs, endMs) {
    return this.stmts.signalsInRange.all(startMs, endMs);
  }

  getTradesInRange(startMs, endMs) {
    return this.stmts.tradesInRange.all(startMs, endMs);
  }

  getSwapEventsInRange(startMs, endMs) {
    return this.stmts.swapEventsInRange.all(startMs, endMs);
  }

  getPositionsInRange(startMs, endMs) {
    return this.stmts.positionsInRange.all(startMs, endMs);
  }

  getRecentSignals(limit = 100) {
    return this.stmts.recentSignals.all(limit);
  }

  getRecentTrades(limit = 100) {
    return this.stmts.recentTrades.all(limit);
  }

  getRecentPositions(limit = 100) {
    return this.stmts.recentPositions.all(limit);
  }

  getStuckPositions() {
    return this.stmts.stuckPositions.all();
  }

  // ============ price_samples ============

  /**
   * Save a single price sample (called from SignalEngine._sampleLongPrice)
   */
  savePriceSample(mint, ts, price) {
    try {
      this.stmts.insertPriceSample.run({ mint, ts, price });
    } catch (_) { /* best effort */ }
  }

  /**
   * Load price samples from the last N milliseconds.
   * Returns Map<mint, [{ts, price}, ...]>
   */
  loadRecentPriceSamples(sinceMs) {
    const rows = this.stmts.loadRecentPriceSamples.all(sinceMs);
    const map = new Map();
    for (const row of rows) {
      let arr = map.get(row.mint);
      if (!arr) {
        arr = [];
        map.set(row.mint, arr);
      }
      arr.push({ ts: row.ts, price: row.price });
    }
    return map;
  }

  /**
   * v3.17.41: Count positions opened for a mint since a timestamp
   */
  countRecentBuysByMint(mint, sinceMs) {
    try {
      const row = this.db.prepare(
        'SELECT count(*) as cnt FROM positions WHERE mint = ? AND opened_at > ?'
      ).get(mint, sinceMs);
      return row ? row.cnt : 0;
    } catch (_) { return -1; }
  }

  /**
   * Delete price samples older than cutoffMs
   */
  cleanOldPriceSamples(cutoffMs) {
    try {
      this.stmts.cleanOldPriceSamples.run(cutoffMs);
    } catch (_) { /* best effort */ }
  }
}

module.exports = TradeLogger;
module.exports.STRATEGY_LAB_QUALITY_VERSION = STRATEGY_LAB_QUALITY_VERSION;
