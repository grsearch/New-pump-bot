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
    //   SQLite ä¸æ”¯æŒ ADD COLUMN IF NOT EXISTS,ç›´æŽ¥å°è¯•,å¤±è´¥å°±å¿½ç•¥
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

    // v3.17.36: è¿žçŽ¯æ‹”å›žæµ‹å­—æ®µ
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
      this.db.exec('ALTER TABLE positions ADD COLUMN rsi_pre_dump REAL');       // v3.17.38: ç ¸å•å‰ RSI5s
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN rsi_1s_pre_dump REAL');    // v3.17.38: ç ¸å•å‰ RSI1s
    } catch (_) { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE positions ADD COLUMN rsi_30s_pre_dump REAL');   // v3.17.42: ç ¸å•å‰ RSI30s
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
    this._ensureColumns('trades', [
      ['configured_slippage_pct', 'REAL'],
      ['effective_slippage_pct', 'REAL'],
      ['signal_price', 'REAL'],
      ['expected_price', 'REAL'],
      ['max_price', 'REAL'],
      ['max_quote_sol', 'REAL'],
      ['cache_age_before_ms', 'INTEGER'],
      ['cache_age_at_build_ms', 'INTEGER'],
      ['state_source', 'TEXT'],
      ['buy_mode', 'TEXT'],
      ['min_base_amount_out_raw', 'TEXT'],
      ['virtual_quote_reserves_raw', 'TEXT'],
      ['chain_error_class', 'TEXT'],
      ['chain_instruction_index', 'INTEGER'],
      ['chain_program_id', 'TEXT'],
      ['chain_failed_program_id', 'TEXT'],
      ['chain_compute_units', 'INTEGER'],
      ['chain_logs_json', 'TEXT'],
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
      CREATE INDEX IF ïŸw¶‰žËkºwµçAñð€……¹‘±”¹Ñ¥µ•™É…µ”ñð€……¹‘±”¹‰Õ­•Ñ}ÑÌ¤É•ÑÕÉ¸ì4(€€€½¹ÍÐÉ½Ü€ôì4(€€€€€Ñ¥µ•™É…µ”è…¹‘±”¹Ñ¥µ•™É…µ”°4(€€€€€‰Õ­•Ñ}ÑÌè…¹‘±”¹‰Õ­•Ñ}ÑÌ°4(€€€€€µ¥¹Ðè…¹‘±”¹µ¥¹Ð°4(€€€€€Íåµ‰½°è…¹‘±”¹Íåµ‰½°ñð¹Õ±°°4(€€€€€½Á•¸èÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹½Á•¸¤°4(€€€€€¡¥ èÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹¡¥ ¤°4(€€€€€±½ÜèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹±½Ü¤°4(€€€€€±½Í”èÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹±½Í”¤°4(€€€€€Ù½±Õµ•}Í½°èÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹Ù½±Õµ•}Í½°¤°4(€€€€€‰Õå}Ù½±Õµ•}Í½°èÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹‰Õå}Ù½±Õµ•}Í½°¤°4(€€€€€Í•±±}Ù½±Õµ•}Í½°èÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹Í•±±}Ù½±Õµ•}Í½°¤°4(€€€€€‰Õå}½Õ¹ÐèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹‰Õå}½Õ¹Ð¤°4(€€€€€Í•±±}½Õ¹ÐèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹Í•±±}½Õ¹Ð¤°4(€€€€€Ñá}½Õ¹ÐèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹Ñá}½Õ¹Ð¤°4(€€€€€Õ¹¥ÅÕ•}‰Õå}Ý…±±•ÑÌèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹Õ¹¥ÅÕ•}‰Õå}Ý…±±•ÑÌ¤°4(€€€€€Õ¹¥ÅÕ•}Í•±±}Ý…±±•ÑÌèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹Õ¹¥ÅÕ•}Í•±±}Ý…±±•ÑÌ¤°4(€€€€€™‘ØèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹™‘Ø¤°4(€€€€€±¥ÅÕ¥‘¥ÑäèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹±¥ÅÕ¥‘¥Ñä¤°4(€€€€€‘…Ñ…}ÅÕ…±¥Ñå}Ù•ÉÍ¥½¸èÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹‘…Ñ…}ÅÕ…±¥Ñå}Ù•ÉÍ¥½¸¤°4(€€€€€™¥±Ñ•É•‘}•Ù•¹Ñ}½Õ¹ÐèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹™¥±Ñ•É•‘}•Ù•¹Ñ}½Õ¹Ð¤°4(€€€€€™¥±Ñ•É•‘}Ù½±Õµ•}Í½°èÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡…¹‘±”¹™¥±Ñ•É•‘}Ù½±Õµ•}Í½°¤°4(€€€€€™•…ÑÕÉ•}ÅÕ…±¥Ñå}ÍÑ…ÑÕÌè…¹‘±”¹™•…ÑÕÉ•}ÅÕ…±¥Ñå}ÍÑ…ÑÕÌñð¹Õ±°°4(€€€€€ÕÁ‘…Ñ•‘}…Ðè…¹‘±”¹ÕÁ‘…Ñ•‘}…Ðñð…Ñ”¹¹½Ü ¤°4(€€€ôì4(€€€ÑÉäì4(€€€€€Ñ¡¥Ì¹ÍÑµÑÌ¹ÕÁÍ•ÉÑQ½­•¹…¹‘±”¹ÉÕ¸¡É½Ü¤ì4(€€€ô…Ñ €¡|¤ì€¼¨…¹…±åÑ¥Ì½¹±ä€¨¼ô4(€ô4(4(€±½Q½­•¹Ù•¹Ð¡•Ù•¹Ð¤ì4(€€€¥˜€ …•Ù•¹Ðñð€…•Ù•¹Ð¹µ¥¹Ðñð€…•Ù•¹Ð¹•Ù•¹ÑQåÁ”¤É•ÑÕÉ¸ì4(€€€½¹ÍÐ‘•Ñ…¥±Ì€ô•Ù•¹Ð¹‘•Ñ…¥±Í)Í½¸€„ô¹Õ±°4(€€€€€€ü•Ù•¹Ð¹‘•Ñ…¥±Í)Í½¸4(€€€€€€è€¡•Ù•¹Ð¹‘•Ñ…¥±Ì€ôô¹Õ±°€ü¹Õ±°€è)M=8¹ÍÑÉ¥¹¥™ä¡•Ù•¹Ð¹‘•Ñ…¥±Ì¤¤ì4(€€€ÑÉäì4(€€€€€Ñ¡¥Ì¹ÍÑµÑÌ¹¥¹Í•ÉÑQ½­•¹Ù•¹Ð¹ÉÕ¸¡ì4(€€€€€€€ÑÌè•Ù•¹Ð¹ÑÌñð…Ñ”¹¹½Ü ¤°4(€€€€€€€µ¥¹Ðè•Ù•¹Ð¹µ¥¹Ð°4(€€€€€€€Íåµ‰½°è•Ù•¹Ð¹Íåµ‰½°ñð¹Õ±°°4(€€€€€€€•Ù•¹Ñ}ÑåÁ”è•Ù•¹Ð¹•Ù•¹ÑQåÁ”°4(€€€€€€€•Ù•¹Ñ}­•äè•Ù•¹Ð¹•Ù•¹Ñ-•äñð€™¥ÉÍÐœ°4(€€€€€€€ÁÉ¥”èÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡•Ù•¹Ð¹ÁÉ¥”¤°4(€€€€€€€™‘ØèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡•Ù•¹Ð¹™‘Ø¤°4(€€€€€€€±¥ÅÕ¥‘¥ÑäèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡•Ù•¹Ð¹±¥ÅÕ¥‘¥Ñä¤°4(€€€€€€€…•}µÌèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡•Ù•¹Ð¹…•5Ì¤°4(€€€€€€€Ù…±Õ”èÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡•Ù•¹Ð¹Ù…±Õ”¤°4(€€€€€€€‘•Ñ…¥±Í}©Í½¸è‘•Ñ…¥±Ì°4(€€€€€€€É•…Ñ•‘}…Ðè…Ñ”¹¹½Ü ¤°4(€€€€€ô¤ì4(€€€ô…Ñ €¡|¤ì€¼¨…¹…±åÑ¥Ì½¹±ä€¨¼ô4(€ô4(4(€±½	½Ñ1…Ñ•¹åÙ•¹Ð¡•Ù•¹Ð¤ì4(€€€¥˜€ …•Ù•¹Ð¤É•ÑÕÉ¸ì4(€€€½¹ÍÐ‘•Ñ…¥±Ì€ô•Ù•¹Ð¹‘•Ñ…¥±Í)Í½¸€„ô¹Õ±°4(€€€€€€ü•Ù•¹Ð¹‘•Ñ…¥±Í)Í½¸4(€€€€€€è€¡•Ù•¹Ð¹‘•Ñ…¥±Ì€ôô¹Õ±°€ü¹Õ±°€è)M=8¹ÍÑÉ¥¹¥™ä¡•Ù•¹Ð¹‘•Ñ…¥±Ì¤¤ì4(€€€ÑÉäì4(€€€€€Ñ¡¥Ì¹ÍÑµÑÌ¹¥¹Í•ÉÑ	½Ñ1…Ñ•¹åÙ•¹Ð¹ÉÕ¸¡ì4(€€€€€€€ÑÌè•Ù•¹Ð¹ÑÌñð…Ñ”¹¹½Ü ¤°4(€€€€€€€µ¥¹Ðè•Ù•¹Ð¹µ¥¹Ðñð¹Õ±°°4(€€€€€€€Íåµ‰½°è•Ù•¹Ð¹Íåµ‰½°ñð¹Õ±°°4(€€€€€€€Í¥¹…ÑÕÉ”è•Ù•¹Ð¹Í¥¹…ÑÕÉ”ñð¹Õ±°°4(€€€€€€€Á¡…Í”è•Ù•¹Ð¹Á¡…Í”ñð¹Õ±°°4(€€€€€€€±…Ñ•¹å}‘•Ñ•Ñ}µÌèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡•Ù•¹Ð¹±…Ñ•¹å•Ñ•Ñ5Ì¤°4(€€€€€€€±…Ñ•¹å}‘•¥Í¥½¹}µÌèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡•Ù•¹Ð¹±…Ñ•¹å•¥Í¥½¹5Ì¤°4(€€€€€€€±…Ñ•¹å}Í•¹‘}µÌèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡•Ù•¹Ð¹±…Ñ•¹åM•¹‘5Ì¤°4(€€€€€€€±…Ñ•¹å}½¹™¥Éµ}µÌèÑ¡¥Ì¹}±•…¹‰Y…±Õ”¡•Ù•¹Ð¹±…Ñ•¹å½¹™¥Éµ5Ì¤°4(€€€€€€€‘•Ñ…¥±Í}©Í½¸è‘•Ñ…¥±Ì°4(€€€€€ô¤ì4(€€€ô…Ñ €¡|¤ì€¼¨…¹…±åÑ¥Ì½¹±ä€¨¼ô4(€ô4(4(€•ÑM¹…ÁÍ¡½Ñ1…‰•±	…­±½œ¡ì¹½Ü€ô…Ñ”¹¹½Ü ¤°µ¥¹EÕ…±¥ÑåY•ÉÍ¥½¸€ôMQIQe}1	}EU1%Qe}YIM%=8ô€ôíô¤ì4(€€€½¹ÍÐµ…á!½É¥é½¹5Ì€ô5…Ñ ¹µ…à ¸¸¹Ñ¡¥Ì¹}ÍÑÉ…Ñ•å1…‰!½É¥é½¹Ì ¤¤€¨€ÄÀÀÀì4(€€€½¹ÍÐÉ½Ü€ôÑ¡¥Ì¹ÍÑµÑÌ¹Í¹…ÁÍ¡½Ñ1…‰•±	…­±½œ¹•Ð¡ì4(€€€€€µ¥¹}ÅÕ…±¥Ñå}Ù•ÉÍ¥½¸èµ¥¹EÕ…±¥ÑåY•ÉÍ¥½¸°4(€€€€€µ…ÑÕÉ•}‰•™½É”è¹½Ü€´µ…á!½É¥é½¹5Ì°4(€€€ô¤ì4(€€€½¹ÍÐ½±‘•ÍÑQÌ€ô9Õµ‰•È¡É½Üü¹½±‘•ÍÑ}ÑÌ¤ñð¹Õ±°ì4(€€€É•ÑÕÉ¸ì4(€€€€€½Õ¹Ðè9Õµ‰•È¡É½Üü¹½Õ¹Ð¤ñð€À°4(€€€€€½±‘•ÍÑQÌ°4(€€€€€¹•Ý•ÍÑQÌè9Õµ‰•È¡É½Üü¹¹•Ý•ÍÑ}ÑÌ¤ñð¹Õ±°°4(€€€€€½±‘•ÍÑ•5Ìè½±‘•ÍÑQÌ€ü5…Ñ ¹µ…à À°¹½Ü€´µ…á!½É¥é½¹5Ì€´½±‘•ÍÑQÌ¤€è€À°4(€€€€€µ¥¹EÕ…±¥ÑåY•ÉÍ¥½¸°4(€€€ôì4(€ô4(4(€‰…­™¥±±M¹…ÁÍ¡½Ñ1…‰•±Ì¡ì4(€€€¹½Ü€ô…Ñ”¹¹½Ü ¤°4(€€€‰…Ñ¡M¥é”€ô€ÄÀÀÀ°4(€€€µ¥¹EÕ…±¥ÑåY•ÉÍ¥½¸€ôMQIQe}1	}EU1%Qe}YIM%=8°4(€ô€ôíô¤ì4(€€€½¹ÍÐ¡½É¥é½¹Ì€ôÑ¡¥Ì¹}ÍÑÉ…Ñ•å1…‰!½É¥é½¹Ì ¤ì4(€€€½¹ÍÐµ…á!½É¥é½¹5Ì€ô5…Ñ ¹µ…à ¸¸¹¡½É¥é½¹Ì¤€¨€ÄÀÀÀì4(€€€ÑÉäì4(€€€€€½¹ÍÐÁ•¹‘¥¹œ€ôÑ¡¥Ì¹ÍÑµÑÌ¹Á•¹‘¥¹M¹…ÁÍ¡½Ñ1…‰•±Ì¹…±°¡ì4(€€€€€€€µ¥¹}ÅÕ…±¥Ñå}Ù•ÉÍ¥½¸èµ¥¹EÕ…±¥ÑåY•ÉÍ¥½¸°4(€€€€€€€µ…ÑÕÉ•}‰•™½É”è¹½Ü€´µ…á!½É¥é½¹5Ì°4(€€€€€€€±¥µ¥Ðè5…Ñ ¹µ…à Ä°5…Ñ ¹™±½½È¡‰…Ñ¡M¥é”¤¤°4(€€€€€ô¤ì4(€€€€€¥˜€¡Á•¹‘¥¹œ¹±•¹Ñ €ôôô€À¤É•ÑÕÉ¸€Àì4(4(€€€€€½¹ÍÐ‰å5¥¹Ð€ô¹•Ü5…À ¤ì4(€€€€€™½È€¡½¹ÍÐÍ¹…À½˜Á•¹‘¥¹œ¤ì4(€€€€€€€¥˜€ …‰å5¥¹Ð¹¡…Ì¡Í¹…À¹µ¥¹Ð¤¤‰å5¥¹Ð¹Í•Ð¡Í¹…À¹µ¥¹Ð°mt¤ì4(€€€€€€€‰å5¥¹Ð¹•Ð¡Í¹…À¹µ¥¹Ð¤¹ÁÕÍ ¡Í¹…À¤ì4(€€€€€ô4(4(€€€€€½¹ÍÐÕÁ‘…Ñ•Ì€ômtì4(€€€€€™½È€¡½¹ÍÐmµ¥¹Ð°Í¹…ÁÍ¡½ÑÍt½˜‰å5¥¹Ð¤ì4(€€€€€€€Í¹…ÁÍ¡½ÑÌ¹Í½ÉÐ ¡±•™Ð°É¥¡Ð¤€ôø±•™Ð¹ÑÌ€´É¥¡Ð¹ÑÌ¤ì4(€€€€€€€½¹ÍÐÁÉ¥•Ì€ôÑ¡¥Ì¹ÍÑµÑÌ¹™ÕÑÕÉ•AÉ¥•Í½É1…‰•°¹…±°¡ì4(€€€€€€€€€µ¥¹Ð°4(€€€€€€€€€™É½µ}ÑÌèÍ¹…ÁÍ¡½ÑÍlÁt¹ÑÌ°4(€€€€€€€€€Õ¹Ñ¥±}ÑÌèÍ¹…ÁÍ¡½ÑÍmÍ¹…ÁÍ¡½ÑÌ¹±•¹Ñ €´€Åt¹ÑÌ€¬µ…á!½É¥é½¹5Ì°4(€€€€€€€€€µ¥¹}ÅÕ…±¥Ñå}Ù•ÉÍ¥½¸èµ¥¹EÕ…±¥ÑåY•ÉÍ¥½¸°4(€€€€€€€ô¤¹µ…À ¡É½Ü¤€ôø€¡ìÑÌè9Õµ‰•È¡É½Ü¹ÑÌ¤°ÁÉ¥”è9Õµ‰•È¡É½Ü¹ÁÉ¥”¤ô¤¤ì4(4(€€€€€€€™½È€¡½¹ÍÐÍ¹…À½˜Í¹…ÁÍ¡½ÑÌ¤ì4(€€€€€€€€€½¹ÍÐ‰…Í•AÉ¥”€ô9Õµ‰•È¡Í¹…À¹ÁÉ¥”¤ì4(€€€€€€€€€¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡‰…Í•AÉ¥”¤ñð‰…Í•AÉ¥”€ðô€À¤½¹Ñ¥¹Õ”ì4(€€€€€€€€€½¹ÍÐÍÑ…ÉÐ€ôÕÁÁ•É	½Õ¹‘	åQÌ¡ÁÉ¥•Ì°Í¹…À¹ÑÌ¤ì4(€€€€€€€€€½¹ÍÐÁ…É…µÌ€ôì4(€€€€€€€€€€€¥èÍ¹…À¹¥°4(€€€€€€€€€€€±…‰•±}ÕÁ‘…Ñ•‘}…Ðè¹½Ü°4(€€€€€€€€€€€±…‰•±}ÍÑ…ÑÕÌè€½µÁ±•Ñ”œ°4(€€€€€€€€€€€±…‰•±}ÅÕ…±¥Ñå}Ù•ÉÍ¥½¸èµ¥¹EÕ…±¥ÑåY•ÉÍ¥½¸°4(€€€€€€€€€ôì4(4(€€€€€€€€€™½È€¡½¹ÍÐ¡½É¥é½¸½˜¡½É¥é½¹Ì¤ì4(€€€€€€€€€€€½¹ÍÐÕ¹Ñ¥°€ôÍ¹…À¹ÑÌ€¬¡½É¥é½¸€¨€ÄÀÀÀì4(€€€€€€€€€€€½¹ÍÐ•¹€ôÕÁÁ•É	½Õ¹‘	åQÌ¡ÁÉ¥•Ì°Õ¹Ñ¥°¤ì4(€€€€€€€€€€€±•Ðµ…áAÉ¥”€ô‰…Í•AÉ¥”ì4(€€€€€€€€€€€±•Ðµ¥¹AÉ¥”€ô‰…Í•AÉ¥”ì4(€€€€€€€€€€€±•Ð±½Í•AÉ¥”€ô‰…Í•AÉ¥”ì4(€€€€€€€€€€€±•ÐÍ…µÁ±•½Õ¹Ð€ô€Àì4(€€€€€€€€€€€™½È€¡±•Ð¥¹‘•à€ôÍÑ…ÉÐì¥¹‘•à€ð•¹ì¥¹‘•à¬¬¤ì4(€€€€€€€€€€€€€½¹ÍÐÁÉ¥”€ôÁÉ¥•Ím¥¹‘•át¹ÁÉ¥”ì4(€€€€€€€€€€€€€¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡ÁÉ¥”¤ñðÁÉ¥”€ðô€À¤½¹Ñ¥¹Õ”ì4(€€€€€€€€€€€€€µ…áAÉ¥”€ô5…Ñ ¹µ…à¡µ…áAÉ¥”°ÁÉ¥”¤ì4(€€€€€€€€€€€€€µ¥¹AÉ¥”€ô5…Ñ ¹µ¥¸¡µ¥¹AÉ¥”°ÁÉ¥”¤ì4(€€€€€€€€€€€€€±½Í•AÉ¥”€ôÁÉ¥”ì4(€€€€€€€€€€€€€Í…µÁ±•½Õ¹Ð¬¬ì4(€€€€€€€€€€€ô4(€€€€€€€€€€€Á…É…µÍm™ÕÑÕÉ•}µ…á|‘í¡½É¥é½¹õÍ}ÁÑt€ô€ ¡µ…áAÉ¥”€´‰…Í•AÉ¥”¤€¼‰…Í•AÉ¥”¤€¨€ÄÀÀì4(€€€€€€€€€€€Á…É…µÍm™ÕÑÕÉ•}±½Í•|‘í¡½É¥é½¹õÍ}ÁÑt€ô€ ¡±½Í•AÉ¥”€´‰…Í•AÉ¥”¤€¼‰…Í•AÉ¥”¤€¨€ÄÀÀì4(€€€€€€€€€€€Á…É…µÍm™ÕÑÕÉ•}‘É…Ý‘½Ý¹|‘í¡½É¥é½¹õÍ}ÁÑt€ô€ ¡µ¥¹AÉ¥”€´‰…Í•AÉ¥”¤€¼‰…Í•AÉ¥”¤€¨€ÄÀÀì4(€€€€€€€€€€€Á…É…µÍm±…‰•±}Í…µÁ±•}½Õ¹Ñ|‘í¡½É¥é½¹õÍt€ôÍ…µÁ±•½Õ¹Ðì4(€€€€€€€€€ô4(€€€€€€€€€ÕÁ‘…Ñ•Ì¹ÁÕÍ ¡Á…É…µÌ¤ì4(€€€€€€€ô4(€€€€€ô4(4(€€€€€½¹ÍÐ…ÁÁ±åUÁ‘…Ñ•Ì€ô€ ¤€ôøì4(€€€€€€€™½È€¡½¹ÍÐÁ…É…µÌ½˜ÕÁ‘…Ñ•Ì¤Ñ¡¥Ì¹ÍÑµÑÌ¹ÕÁ‘…Ñ•M¹…ÁÍ¡½Ñ1…‰•±Ì¹ÉÕ¸¡Á…É…µÌ¤ì4(€€€€€ôì4(€€€€€¥˜€¡ÑåÁ•½˜Ñ¡¥Ì¹‘ˆ¹ÑÉ…¹Í…Ñ¥½¸€ôôô€™Õ¹Ñ¥½¸œ¤Ñ¡¥Ì¹‘ˆ¹ÑÉ…¹Í…Ñ¥½¸¡…ÁÁ±åUÁ‘…Ñ•Ì¤ ¤ì4(€€€€€•±Í”…ÁÁ±åUÁ‘…Ñ•Ì ¤ì4(€€€€€É•ÑÕÉ¸ÕÁ‘…Ñ•Ì¹±•¹Ñ ì4(€€€ô…Ñ €¡•ÉÉ½È¤ì4(€€€€€Ñ¡É½Ü¹•ÜÉÉ½È¡MÑÉ…Ñ•ä1…ˆ±…‰•°‰…­™¥±°™…¥±•è€‘í•ÉÉ½È¹µ•ÍÍ…•õ€¤ì4(€€€ô4(€ô4(4(€€¼¼€ôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôô4(€€¼¼A½Í¥Ñ¥½¸±¥™•å±”A$4(€€¼¼€ôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôô4(4(€½Á•¹A½Í¥Ñ¥½¸¡ìÁ½Í¥Ñ¥½¹%°µ¥¹Ð°Íåµ‰½°°½Á•¹•‘Ð°•¹ÑÉåM½°°•¹ÑÉåAÉ¥”°Ñ½­•¹µ½Õ¹Ð°4(€€€€€€€€€€€€€€€€‘ÉåIÕ¸°‰ÕåM¥¹…ÑÕÉ”°‰Õå••1…µÁ½ÉÑÌ°‰ÕåM±½Ð°‘ÕµÁM±½Ð°4(€€€€€€€€€€€€€€€€•¹ÑÉå‘Ø°•¹ÑÉåA½½±M½°°•¹ÑÉå1¥ÅÕ¥‘¥Ñä°4(€€€€€€€€€€€€€€€€Í•±±½Õ¹ÐÄÁÌ°Ñ½Ñ…±M•±±M½°ÄÁÌ°4(€€€€€€€€€€€€€€€€µ¥¹Ñ•Ñ	ÕåM•Œ°ÉÍ¥AÉ•ÕµÀ°ÉÍ¤ÅÍAÉ•ÕµÀ°ÉÍ¤ÌÁÍAÉ•ÕµÀ°4(€€€€€€€€€€€€€€€€¥Íµ…MÑÉ…Ñ•ä€ô€À°¥Í‘‘=¸€ô€Àô¤ì4(€€€Ñ¡¥Ì¹ÍÑµÑÌ¹½Á•¹A½Í¥Ñ¥½¸¹ÉÕ¸¡ì4(€€€€€Á½Í¥Ñ¥½¹%°4(€€€€€µ¥¹Ð°4(€€€€€Íåµ‰½°èÍåµ‰½°ñð¹Õ±°°4(€€€€€½Á•¹•‘Ðè½Á•¹•‘Ðñð…Ñ”¹¹½Ü ¤°4(€€€€€•¹ÑÉåM½°è•¹ÑÉåM½°€üü¹Õ±°°4(€€€€€•¹ÑÉåAÉ¥”è•¹ÑÉåAÉ¥”€üü¹Õ±°°4(€€€€€Ñ½­•¹µ½Õ¹ÐèÑ½­•¹µ½Õ¹Ð€üü¹Õ±°°4(€€€€€‘ÉåIÕ¸è‘ÉåIÕ¸€ü€Ä€è€À°4(€€€€€‰ÕåM¥¹…ÑÕÉ”è‰ÕåM¥¹…ÑÕÉ”ñð¹Õ±°°4(€€€€€‰Õå••1…µÁ½ÉÑÌè‰Õå••1…µÁ½ÉÑÌñð€À°4(€€€€€‰ÕåM±½Ðè‰ÕåM±½Ðñð€À°4(€€€€€‘ÕµÁM±½Ðè‘ÕµÁM±½Ðñð€À°4(€€€€€•¹ÑÉå‘Øè•¹ÑÉå‘Ø€üü¹Õ±°°4(€€€€€•¹ÑÉåA½½±M½°è•¹ÑÉåA½½±M½°€üü¹Õ±°°4(€€€€€•¹ÑÉå1¥ÅÕ¥‘¥Ñäè•¹ÑÉå1¥ÅÕ¥‘¥Ñä€üü¹Õ±°°4(€€€€€Í•±±½Õ¹ÐÄÁÌèÍ•±±½Õ¹ÐÄÁÌ€üü¹Õ±°°€€€€€€€€¼¼ØÌ¸ÄÜ¸ÌØèƒ¢þ{ž:¿š.S–n{šÖ,4(€€€€€Ñ½Ñ…±M•±±M½°ÄÁÌèÑ½Ñ…±M•±±M½°ÄÁÌ€üü¹Õ±°°€€¼¼ØÌ¸ÄÜ¸ÌØèƒ¢þ{ž:¿š.S–n{šÖ,4(€€€€€µ¥¹Ñ•Ñ	ÕåM•Œèµ¥¹Ñ•Ñ	ÕåM•Œ€üü¹Õ±°°€€¼¼ØÌ¸ÄÜ¸Ìäèƒ¦š[’þ‡–>ß–"Ã’æÃ–—žjžžKšVÀ4(€€€€€ÉÍ¥AÉ•ÕµÀèÉÍ¥AÉ•ÕµÀ€üü¹Õ±°°€€€€€€€€€€€€€€¼¼ØÌ¸ÄÜ¸Ìàèƒž‚ã–6W–&4IM$ÕÌ4(€€€€€ÉÍ¤ÅÍAÉ•ÕµÀèÉÍ¤ÅÍAÉ•ÕµÀ€üü¹Õ±°°€€€€€€€€€€¼¼ØÌ¸ÄÜ¸Ìàèƒž‚ã–6W–&4IM$ÅÌ4(€€€€€ÉÍ¤ÌÁÍAÉ•ÕµÀèÉÍ¤ÌÁÍAÉ•ÕµÀ€üü¹Õ±°°€€€€€€€€¼¼ØÌ¸ÄÜ¸ÐÈèƒž‚ã–6W–&4IM$ÌÁÌ4(€€€€€¥Íµ…MÑÉ…Ñ•äè¥Íµ…MÑÉ…Ñ•ä€üü€À°€€€€€€€€€€€€¼¼5ž¶[žV—š‚¢ºÀ4(€€€€€¥Í‘‘=¸è¥Í‘‘=¸€üü€À°€€€€€€€€€€€€€€€€€€€€€€€¼¼ƒ–*ƒ’îOš‚¢ºÀ4(€€€ô¤ì4(€ô4(4(€ÕÁ‘…Ñ•A½Í¥Ñ¥½¹¹ÑÉä¡Á½Í¥Ñ¥½¹%°ì•¹ÑÉåM½°°•¹ÑÉåAÉ¥”°Ñ½­•¹µ½Õ¹Ð°‰Õå••1…µÁ½ÉÑÌ°‰ÕåM±½Ð°‘ÕµÁM±½Ðô¤ì4(€€€€¼¼ØÌ¸ÄÜ¸ÈÀµ™¥àèƒšR¿š2‰ÕåM±½Ð½‘ÕµÁM±½ÐƒšnÓšZÀ4(€€€½¹ÍÐ¡…ÍM±½ÑUÁ‘…Ñ”€ô‰ÕåM±½Ð€„ô¹Õ±°ñð‘ÕµÁM±½Ð€„ô¹Õ±°ì4(€€€¥˜€¡¡…ÍM±½ÑUÁ‘…Ñ”¤ì4(€€€€€Ñ¡¥Ì¹‘ˆ¹ÁÉ•Á…É”¡€4(€€€€€€€UAQÁ½Í¥Ñ¥½¹ÌMP4(€€€€€€€€€•¹ÑÉå}Í½°€ô•¹ÑÉåM½°°4(€€€€€€€€€•¹ÑÉå}ÁÉ¥”€ô•¹ÑÉåAÉ¥”°4(€€€€€€€€€Ñ½­•¹}…µ½Õ¹Ð€ôÑ½­•¹µ½Õ¹Ð°4(€€€€€€€€€‰Õå}™••}±…µÁ½ÉÑÌ€ô‰Õå••1…µÁ½ÉÑÌ°4(€€€€€€€€€‰Õå}Í±½Ð€ô=1M¡‰ÕåM±½Ð°‰Õå}Í±½Ð¤°4(€€€€€€€€€‘ÕµÁ}Í±½Ð€ô=1M¡‘ÕµÁM±½Ð°‘ÕµÁ}Í±½Ð¤4(€€€€€€€]!IÁ½Í¥Ñ¥½¹}¥€ôÁ½Í¥Ñ¥½¹%4(€€€€€€¤¹ÉÕ¸¡ì4(€€€€€€€Á½Í¥Ñ¥½¹%°4(€€€€€€€•¹ÑÉåM½°è•¹ÑÉåM½°€üü¹Õ±°°4(€€€€€€€•¹ÑÉåAÉ¥”è•¹ÑÉåAÉ¥”€üü¹Õ±°°4(€€€€€€€Ñ½­•¹µ½Õ¹ÐèÑ½­•¹µ½Õ¹Ð€üü¹Õ±°°4(€€€€€€€‰Õå••1…µÁ½ÉÑÌè‰Õå••1…µÁ½ÉÑÌ€üü€À°4(€€€€€€€‰ÕåM±½Ðè‰ÕåM±½Ð€üü¹Õ±°°4(€€€€€€€‘ÕµÁM±½Ðè‘ÕµÁM±½Ð€üü¹Õ±°°4(€€€€€ô¤ì4(€€€ô•±Í”ì4(€€€€€Ñ¡¥Ì¹ÍÑµÑÌ¹ÕÁ‘…Ñ•¹ÑÉä¹ÉÕ¸¡ì4(€€€€€€€Á½Í¥Ñ¥½¹%°4(€€€€€€€•¹ÑÉåM½°è•¹ÑÉåM½°€üü¹Õ±°°4(€€€€€€€•¹ÑÉåAÉ¥”è•¹ÑÉåAÉ¥”€üü¹Õ±°°4(€€€€€€€Ñ½­•¹µ½Õ¹ÐèÑ½­•¹µ½Õ¹Ð€üü¹Õ±°°4(€€€€€€€‰Õå••1…µÁ½ÉÑÌè‰Õå••1…µÁ½ÉÑÌ€üü€À°4(€€€€€ô¤ì4(€€€ô4(€ô4(4(€±½Í•A½Í¥Ñ¥½¸¡Á½Í¥Ñ¥½¹%°ì±½Í•‘Ð°•á¥ÑAÉ¥”°•á¥ÑM½°°Á¹±M½°°Á¹±AÐ°•á¥ÑI•…Í½¸°Í•±±M¥¹…ÑÕÉ”°Á•…­A¹±AÐ°Á•…­AÉ¥”°Á•…­QÌ°Ñ¥µ•Q½A•…­5Ì°ÁÉ¥•Q¥­½Õ¹Ðô¤ì4(€€€Ñ¡¥Ì¹ÍÑµÑÌ¹±½Í•A½Í¥Ñ¥½¸¹ÉÕ¸¡ì4(€€€€€Á½Í¥Ñ¥½¹%°4(€€€€€±½Í•‘Ðè±½Í•‘Ðñð…Ñ”¹¹½Ü ¤°4(€€€€€•á¥ÑAÉ¥”è•á¥ÑAÉ¥”€üü¹Õ±°°4(€€€€€•á¥ÑM½°è•á¥ÑM½°€üü¹Õ±°°4(€€€€€Á¹±M½°èÁ¹±M½°€üü¹Õ±°°4(€€€€€Á¹±AÐèÁ¹±AÐ€üü¹Õ±°°4(€€€€€•á¥ÑI•…Í½¸è•á¥ÑI•…Í½¸ñð¹Õ±°°4(€€€€€Í•±±M¥¹…ÑÕÉ”èÍ•±±M¥¹…ÑÕÉ”ñð¹Õ±°°4(€€€€€Á•…­A¹±AÐèÁ•…­A¹±AÐ€üü¹Õ±°°4(€€€€€Á•…­AÉ¥”èÁ•…­AÉ¥”€üü¹Õ±°°4(€€€€€Á•…­QÌèÁ•…­QÌ€üü¹Õ±°°4(€€€€€Ñ¥µ•Q½A•…­5ÌèÑ¥µ•Q½A•…­5Ì€üü¹Õ±°°4(€€€€€ÁÉ¥•Q¥­½Õ¹ÐèÁÉ¥•Q¥­½Õ¹Ð€üü€À°4(€€€ô¤ì4(€ô4(4(€€¼¼ØÌ¸ÄÜ¸ÌÄèƒ–æÏ’îO–B;’îßš‚ó¢þ÷¢â«–g–”4(€É•½É‘A½ÍÑá¥ÑMÑ…ÑÌ¡ìÁ½Í¥Ñ¥½¹%°µ¥¹Ð°•á¥ÑAÉ¥”°•á¥ÑQÌ°µ…áAÉ¥”°µ…áAÉ¥•QÌ°4(€€€µ…áAÕµÁAÐ°µ¥¹AÉ¥”°µ¥¹AÉ¥•QÌ°µ…áÕµÁAÐ°Í…µÁ±•½Õ¹Ð°4(€€€Í¹…ÁÍ¡½ÑÌ°™¥¹…±¥é•‘Ðô¤ì4(€€€¥˜€ …Ñ¡¥Ì¹ÍÑµÑÌ¹É•½É‘A½ÍÑá¥ÑMÑ…ÑÌ¤ì4(€€€€€Ñ¡¥Ì¹ÍÑµÑÌ¹É•½É‘A½ÍÑá¥ÑMÑ…ÑÌ€ôÑ¡¥Ì¹‘ˆ¹ÁÉ•Á…É”¡€4(€€€€€€€%9MIP=HIA1%9Q<Á½ÍÑ}•á¥Ñ}ÍÑ…ÑÌ€ 4(€€€€€€€€€Á½Í¥Ñ¥½¹}¥°µ¥¹Ð°•á¥Ñ}ÁÉ¥”°•á¥Ñ}ÑÌ°4(€€€€€€€€€µ…á}ÁÉ¥”°µ…á}ÁÉ¥•}ÑÌ°µ…á}ÁÕµÁ}ÁÐ°4(€€€€€€€€€µ¥¹}ÁÉ¥”°µ¥¹}ÁÉ¥•}ÑÌ°µ…á}‘ÕµÁ}ÁÐ°4(€€€€€€€€€Í…µÁ±•}½Õ¹Ð°Í¹…ÁÍ¡½ÑÌ°™¥¹…±¥é•‘}…Ð4(€€€€€€€€¤Y1UL€ 4(€€€€€€€€€Á½Í¥Ñ¥½¹%°µ¥¹Ð°•á¥ÑAÉ¥”°•á¥ÑQÌ°4(€€€€€€€€€µ…áAÉ¥”°µ…áAÉ¥•QÌ°µ…áAÕµÁAÐ°4(€€€€€€€€€µ¥¹AÉ¥”°µ¥¹AÉ¥•QÌ°µ…áÕµÁAÐ°4(€€€€€€€€€Í…µÁ±•½Õ¹Ð°Í¹…ÁÍ¡½ÑÌ°™¥¹…±¥é•‘Ð4(€€€€€€€€¤4(€€€€€€¤ì4(€€€ô4(€€€Ñ¡¥Ì¹ÍÑµÑÌ¹É•½É‘A½ÍÑá¥ÑMÑ…ÑÌ¹ÉÕ¸¡ì4(€€€€€Á½Í¥Ñ¥½¹%°µ¥¹Ð°•á¥ÑAÉ¥”°•á¥ÑQÌ°4(€€€€€µ…áAÉ¥”°µ…áAÉ¥•QÌ°µ…áAÕµÁAÐ°4(€€€€€µ¥¹AÉ¥”°µ¥¹AÉ¥•QÌ°µ…áÕµÁAÐ°4(€€€€€Í…µÁ±•½Õ¹Ð°Í¹…ÁÍ¡½ÑÌ°™¥¹…±¥é•‘Ð°4(€€€ô¤ì4(€ô4(4(€µ…É­M•±±A•¹‘¥¹œ¡Á½Í¥Ñ¥½¹%°Í¥¹…ÑÕÉ”°•á¥ÑI•…Í½¸¤ì4(€€€Ñ¡¥Ì¹ÍÑµÑÌ¹µ…É­M•±±A•¹‘¥¹œ¹ÉÕ¸¡Í¥¹…ÑÕÉ”ñð¹Õ±°°•á¥ÑI•…Í½¸ñð¹Õ±°°…Ñ”¹¹½Ü ¤°Á½Í¥Ñ¥½¹%¤ì4(€ô4(4(€µ…É­M•±±…¥±•‘A•¹‘¥¹I•ÑÉä¡Á½Í¥Ñ¥½¹%°¹•áÑI•ÑÉåÐ°•ÉÉ½É5Íœ°•á¥ÑI•…Í½¸¤ì4(€€€Ñ¡¥Ì¹ÍÑµÑÌ¹µ…É­M•±±…¥±•‘A•¹‘¥¹I•ÑÉä¹ÉÕ¸ 4(€€€€€¹•áÑI•ÑÉåÐ°4(€€€€€•ÉÉ½É5Íœñð¹Õ±°°4(€€€€€•á¥ÑI•…Í½¸ñð¹Õ±°°4(€€€€€…Ñ”¹¹½Ü ¤°4(€€€€€Á½Í¥Ñ¥½¹%°4(€€€€¤ì4(€ô4(4(€µ…É­MÑÕ¬¡Á½Í¥Ñ¥½¹%°É•…Í½¸¤ì4(€€€Ñ¡¥Ì¹ÍÑµÑÌ¹µ…É­MÑÕ¬¹ÉÕ¸¡É•…Í½¸ñð¹Õ±°°…Ñ”¹¹½Ü ¤°Á½Í¥Ñ¥½¹%¤ì4(€ô4(4(€É•½É‘M•±±ÑÑ•µÁÐ¡Á½Í¥Ñ¥½¹%°•ÉÉ½É5Íœ¤ì4(€€€Ñ¡¥Ì¹ÍÑµÑÌ¹É•½É‘M•±±ÑÑ•µÁÐ¹ÉÕ¸¡•ÉÉ½É5Íœñð¹Õ±°°…Ñ”¹¹½Ü ¤°Á½Í¥Ñ¥½¹%¤ì4(€ô4(4(€•Ñ=Á•¹A½Í¥Ñ¥½¹Ì ¤ì4(€€€É•ÑÕÉ¸Ñ¡¥Ì¹ÍÑµÑÌ¹•Ñ=Á•¹A½Í¥Ñ¥½¹Ì¹…±° ¤ì4(€ô4(4(€•ÑÕ•A•¹‘¥¹I•ÑÉ¥•Ì¡¹½Ü¤ì4(€€€É•ÑÕÉ¸Ñ¡¥Ì¹ÍÑµÑÌ¹•ÑÕ•A•¹‘¥¹I•ÑÉ¥•Ì¹…±°¡¹½Ü¤ì4(€ô4(4(€€¼¼€ôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôô4(€€¼¼I•Á½ÉÑ¥¹œ€¼‘…Í¡‰½…ÉÅÕ•É¥•Ì4(€€¼¼€ôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôôô4(4(€•ÑM¥¹…±Í%¹I…¹”¡ÍÑ…ÉÑ5Ì°•¹‘5Ì¤ì4(€€€É•ÑÕÉ¸Ñ¡¥Ì¹ÍÑµÑÌ¹Í¥¹…±Í%¹I…¹”¹…±°¡ÍÑ…ÉÑ5Ì°•¹‘5Ì¤ì4(€ô4(4(€•ÑQÉ…‘•Í%¹I…¹”¡ÍÑ…ÉÑ5Ì°•¹‘5Ì¤ì4(€€€É•ÑÕÉ¸Ñ¡¥Ì¹ÍÑµÑÌ¹ÑÉ…‘•Í%¹I…¹”¹…±°¡ÍÑ…ÉÑ5Ì°•¹‘5Ì¤ì4(€ô4(4(€•ÑMÝ…ÁÙ•¹ÑÍ%¹I…¹”¡ÍÑ…ÉÑ5Ì°•¹‘5Ì¤ì4(€€€É•ÑÕÉ¸Ñ¡¥Ì¹ÍÑµÑÌ¹ÍÝ…ÁÙ•¹ÑÍ%¹I…¹”¹…±°¡ÍÑ…ÉÑ5Ì°•¹‘5Ì¤ì4(€ô4(4(€•ÑA½Í¥Ñ¥½¹Í%¹I…¹”¡ÍÑ…ÉÑ5Ì°•¹‘5Ì¤ì4(€€€É•ÑÕÉ¸Ñ¡¥Ì¹ÍÑµÑÌ¹Á½Í¥Ñ¥½¹Í%¹I…¹”¹…±°¡ÍÑ…ÉÑ5Ì°•¹‘5Ì¤ì4(€ô4(4(€•ÑI••¹ÑM¥¹…±Ì¡±¥µ¥Ð€ô€ÄÀÀ¤ì4(€€€É•ÑÕÉ¸Ñ¡¥Ì¹ÍÑµÑÌ¹É••¹ÑM¥¹…±Ì¹…±°¡±¥µ¥Ð¤ì4(€ô4(4(€•ÑI••¹ÑQÉ…‘•Ì¡±¥µ¥Ð€ô€ÄÀÀ¤ì4(€€€É•ÑÕÉ¸Ñ¡¥Ì¹ÍÑµÑÌ¹É••¹ÑQÉ…‘•Ì¹…±°¡±¥µ¥Ð¤ì4(€ô4(4(€•ÑI••¹ÑA½Í¥Ñ¥½¹Ì¡±¥µ¥Ð€ô€ÄÀÀ¤ì4(€€€É•ÑÕÉ¸Ñ¡¥Ì¹ÍÑµÑÌ¹É••¹ÑA½Í¥Ñ¥½¹Ì¹…±°¡±¥µ¥Ð¤ì4(€ô4(4(€•ÑMÑÕ­A½Í¥Ñ¥½¹Ì ¤ì4(€€€É•ÑÕÉ¸Ñ¡¥Ì¹ÍÑµÑÌ¹ÍÑÕ­A½Í¥Ñ¥½¹Ì¹…±° ¤ì4(€ô4(4(€€¼¼€ôôôôôôôôôôôôÁÉ¥•}Í…µÁ±•Ì€ôôôôôôôôôôôô4(4(€€¼¨¨4(€€€¨M…Ù”„Í¥¹±”ÁÉ¥”Í…µÁ±”€¡…±±•™É½´M¥¹…±¹¥¹”¹}Í…µÁ±•1½¹AÉ¥”¤4(€€€¨¼4(€Í…Ù•AÉ¥•M…µÁ±”¡µ¥¹Ð°ÑÌ°ÁÉ¥”¤ì4(€€€ÑÉäì4(€€€€€Ñ¡¥Ì¹ÍÑµÑÌ¹¥¹Í•ÉÑAÉ¥•M…µÁ±”¹ÉÕ¸¡ìµ¥¹Ð°ÑÌ°ÁÉ¥”ô¤ì4(€€€ô…Ñ €¡|¤ì€¼¨‰•ÍÐ•™™½ÉÐ€¨¼ô4(€ô4(4(€€¼¨¨4(€€€¨1½…ÁÉ¥”Í…µÁ±•Ì™É½´Ñ¡”±…ÍÐ8µ¥±±¥Í•½¹‘Ì¸4(€€€¨I•ÑÕÉ¹Ì5…Àñµ¥¹Ð°míÑÌ°ÁÉ¥•ô°€¸¸¹tø4(€€€¨¼4(€±½…‘I••¹ÑAÉ¥•M…µÁ±•Ì¡Í¥¹•5Ì¤ì4(€€€½¹ÍÐÉ½ÝÌ€ôÑ¡¥Ì¹ÍÑµÑÌ¹±½…‘I••¹ÑAÉ¥•M…µÁ±•Ì¹…±°¡Í¥¹•5Ì¤ì4(€€€½¹ÍÐµ…À€ô¹•Ü5…À ¤ì4(€€€™½È€¡½¹ÍÐÉ½Ü½˜É½ÝÌ¤ì4(€€€€€±•Ð…ÉÈ€ôµ…À¹•Ð¡É½Ü¹µ¥¹Ð¤ì4(€€€€€¥˜€ ……ÉÈ¤ì4(€€€€€€€…ÉÈ€ômtì4(€€€€€€€µ…À¹Í•Ð¡É½Ü¹µ¥¹Ð°…ÉÈ¤ì4(€€€€€ô4(€€€€€…ÉÈ¹ÁÕÍ ¡ìÑÌèÉ½Ü¹ÑÌ°ÁÉ¥”èÉ½Ü¹ÁÉ¥”ô¤ì4(€€€ô4(€€€É•ÑÕÉ¸µ…Àì4(€ô4(4(€€¼¨¨4(€€€¨ØÌ¸ÄÜ¸ÐÄè½Õ¹ÐÁ½Í¥Ñ¥½¹Ì½Á•¹•™½È„µ¥¹ÐÍ¥¹”„Ñ¥µ•ÍÑ…µÀ4(€€€¨¼4(€½Õ¹ÑI••¹Ñ	ÕåÍ	å5¥¹Ð¡µ¥¹Ð°Í¥¹•5Ì¤ì(€€€ÑÉäì4(€€€€€½¹ÍÐÉ½Ü€ôÑ¡¥Ì¹‘ˆ¹ÁÉ•Á…É” 4(€€€€€€€€M1P½Õ¹Ð ¨¤…Ì¹ÐI=4Á½Í¥Ñ¥½¹Ì]!Iµ¥¹Ð€ô€ü9½Á•¹•‘}…Ð€ø€üœ4(€€€€€€¤¹•Ð¡µ¥¹Ð°Í¥¹•5Ì¤ì4(€€€€€É•ÑÕÉ¸É½Ü€üÉ½Ü¹¹Ð€è€Àì4(€€€ô…Ñ €¡|¤ìÉ•ÑÕÉ¸€´Äìô(€ô((€¡…ÍMÕ•ÍÍ™Õ±	Õå½É5¥¹Ð¡µ¥¹Ð¤ì(€€€½¹ÍÐÉ½Ü€ôÑ¡¥Ì¹‘ˆ¹ÁÉ•Á…É” (€€€€€€‰M1P€ÄL™½Õ¹I=4ÑÉ…‘•Ì€ˆ€¬(€€€€€€€€‰]!Iµ¥¹Ð€ô€ü9Í¥‘”€ô€	Udœ9ÍÕ•ÍÌ€ô€Ä9‘Éå}ÉÕ¸€ô€À1%5%P€Äˆ°(€€€€¤¹•Ð¡µ¥¹Ð¤ì(€€€É•ÑÕÉ¸€„…É½Üì(€ô((€€¼¨¨(€€€¨•±•Ñ”ÁÉ¥”Í…µÁ±•Ì½±‘•ÈÑ¡…¸ÕÑ½™™5Ì(€€€¨¼4(€±•…¹=±‘AÉ¥•M…µÁ±•Ì¡ÕÑ½™™5Ì¤ì4(€€€ÑÉäì4(€€€€€Ñ¡¥Ì¹ÍÑµÑÌ¹±•…¹=±‘AÉ¥•M…µÁ±•Ì¹ÉÕ¸¡ÕÑ½™™5Ì¤ì4(€€€ô…Ñ €¡|¤ì€¼¨‰•ÍÐ•™™½ÉÐ€¨¼ô4(€ô4)ô4(4)µ½‘Õ±”¹•áÁ½ÉÑÌ€ôQÉ…‘•1½•Èì4)µ½‘Õ±”¹•áÁ½ÉÑÌ¹MQIQe}1	}EU1%Qe}YIM%=8€ôMQIQe}1	}EU1%Qe}YIM%=8ì4(