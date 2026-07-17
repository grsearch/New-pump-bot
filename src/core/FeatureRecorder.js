'use strict';

const { config } = require('../config');

const WINDOWS_SEC = [1, 5, 10, 20, 30, 60];
const CANDLE_FRAMES = [
  { timeframe: '15s', ms: 15_000 },
  { timeframe: '1m', ms: 60_000 },
];

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positive(value, fallback = null) {
  const n = finite(value, null);
  return n != null && n > 0 ? n : fallback;
}

function sum(items, selector) {
  let total = 0;
  for (const item of items) {
    const n = selector(item);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

function median(values) {
  const nums = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function average(values) {
  const nums = values.filter((n) => Number.isFinite(n));
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stddev(values) {
  const nums = values.filter((n) => Number.isFinite(n));
  if (nums.length < 2) return 0;
  const avg = average(nums);
  const variance = nums.reduce((total, n) => total + ((n - avg) ** 2), 0) / nums.length;
  return Math.sqrt(variance);
}

function uniqueSet(items, selector) {
  const set = new Set();
  for (const item of items) {
    const value = selector(item);
    if (value) set.add(value);
  }
  return set;
}

function parseCsvNumbers(raw, fallback) {
  const source = raw || fallback;
  return String(source)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

class FeatureRecorder {
  constructor(opts = {}) {
    const capture = config.capture || {};
    this.tradeLogger = opts.tradeLogger;
    this.tokenRegistry = opts.tokenRegistry || null;
    this.enabled = opts.enabled ?? capture.strategyLabEnabled ?? boolEnv('STRATEGY_LAB_ENABLED', true);
    this.snapshotIntervalMs = Math.max(
      250,
      opts.snapshotIntervalMs ?? capture.strategyLabSnapshotIntervalMs ?? numEnv('STRATEGY_LAB_SNAPSHOT_INTERVAL_MS', 1000),
    );
    this.retentionMs = Math.max(
      60_000,
      opts.retentionMs ?? capture.strategyLabRetentionMs ?? numEnv('STRATEGY_LAB_RETENTION_MS', 300_000),
    );
    this.labelEnabled = opts.labelEnabled ?? capture.strategyLabLabelEnabled ?? boolEnv('STRATEGY_LAB_LABEL_ENABLED', true);
    this.labelIntervalMs = Math.max(
      1000,
      opts.labelIntervalMs ?? capture.strategyLabLabelIntervalMs ?? numEnv('STRATEGY_LAB_LABEL_INTERVAL_MS', 10_000),
    );
    this.labelBatchSize = Math.max(
      1,
      opts.labelBatchSize ?? capture.strategyLabLabelBatchSize ?? numEnv('STRATEGY_LAB_LABEL_BATCH_SIZE', 500),
    );
    this.snapshotAllActive =
      opts.snapshotAllActive ?? capture.strategyLabSnapshotAllActive ?? boolEnv('STRATEGY_LAB_SNAPSHOT_ALL_ACTIVE', false);
    this.buyBurstThreshold = Math.max(
      1,
      opts.buyBurstThreshold ?? capture.strategyLabBuyBurstThreshold ?? numEnv('STRATEGY_LAB_BUY_BURST_THRESHOLD', 10),
    );
    this.tpsDoubleMin = Math.max(
      0,
      opts.tpsDoubleMin ?? capture.strategyLabTpsDoubleMin ?? numEnv('STRATEGY_LAB_TPS_DOUBLE_MIN', 5),
    );
    this.lpChangePct = Math.max(
      0,
      opts.lpChangePct ?? capture.strategyLabLpChangePct ?? numEnv('STRATEGY_LAB_LP_CHANGE_PCT', 10),
    );
    this.fdvBandsUsd = opts.fdvBandsUsd || parseCsvNumbers(
      process.env.STRATEGY_LAB_FDV_BANDS_USD,
      capture.strategyLabFdvBandsUsd || '50000,100000,250000,500000,1000000',
    );
    this.smartWallets = new Set(
      String(opts.smartWallets || process.env.STRATEGY_LAB_SMART_WALLETS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    this.states = new Map();
    this._snapshotTimer = null;
    this._labelTimer = null;
  }

  start() {
    if (!this.enabled || !this.tradeLogger) return;
    if (!this._snapshotTimer) {
      this._snapshotTimer = setInterval(() => this.flush(Date.now()), this.snapshotIntervalMs);
      if (this._snapshotTimer.unref) this._snapshotTimer.unref();
    }
    if (this.labelEnabled && !this._labelTimer) {
      this._labelTimer = setInterval(() => {
        try {
          this.tradeLogger.backfillSnapshotLabels({ batchSize: this.labelBatchSize });
        } catch (_) {}
      }, this.labelIntervalMs);
      if (this._labelTimer.unref) this._labelTimer.unref();
    }
  }

  stop() {
    if (this._snapshotTimer) clearInterval(this._snapshotTimer);
    if (this._labelTimer) clearInterval(this._labelTimer);
    this._snapshotTimer = null;
    this._labelTimer = null;
  }

  handleSwap(swap) {
    if (!this.enabled || !swap || !swap.mint) return;
    const side = String(swap.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return;

    const state = this._stateOf(swap.mint);
    const ts = finite(swap.ts, Date.now());
    const price = positive(swap.price, state.lastPrice);
    const priceBefore = positive(swap.priceBefore, null);
    const solVolume = Math.max(0, finite(swap.solVolume, 0));

    const ev = {
      mint: swap.mint,
      symbol: swap.symbol || state.symbol || null,
      signer: swap.signer || null,
      side,
      solVolume,
      price,
      priceBefore,
      priceChangePct: finite(swap.priceChangePct, null),
      ts,
      slot: finite(swap.slot, 0),
      signature: swap.signature || null,
      poolAddress: swap.poolAddress || state.poolAddress || null,
      poolQuoteAfter: positive(swap.poolQuoteAfter, null),
    };
    if (ev.priceChangePct == null && ev.price && ev.priceBefore) {
      ev.priceChangePct = ((ev.price - ev.priceBefore) / ev.priceBefore) * 100;
    }

    state.events.push(ev);
    if (state.events.length > 1 && state.events[state.events.length - 2].ts > ev.ts) {
      state.events.sort((a, b) => (a.ts - b.ts) || ((a.slot || 0) - (b.slot || 0)));
    }
    state.symbol = ev.symbol || state.symbol;
    state.poolAddress = ev.poolAddress || state.poolAddress;
    state.lastPoolQuoteAfter = ev.poolQuoteAfter || state.lastPoolQuoteAfter || null;
    state.lastSeenAt = Math.max(state.lastSeenAt || 0, ev.ts);
    if (ev.price) state.lastPrice = ev.price;

    if (ev.signer) {
      if (ev.side === 'BUY' && !state.firstBuySeen.has(ev.signer)) state.firstBuySeen.set(ev.signer, ev.ts);
      if (ev.side === 'SELL' && !state.firstSellSeen.has(ev.signer)) state.firstSellSeen.set(ev.signer, ev.ts);
    }
    if (ev.side === 'BUY') {
      state.buyStreak += 1;
      state.sellStreak = 0;
    } else {
      state.sellStreak += 1;
      state.buyStreak = 0;
    }

    this._prune(state, ev.ts);
    this._recordDerivedEvents(state, ev);
  }

  recordLatency(event) {
    if (!this.enabled || !event) return;
    const normalized = {
      ts: event.ts || Date.now(),
      mint: event.mint || null,
      symbol: event.symbol || null,
      signature: event.signature || null,
      phase: event.phase || null,
      latencyDetectMs: finite(event.latencyDetectMs, null),
      latencyDecisionMs: finite(event.latencyDecisionMs, null),
      latencySendMs: finite(event.latencySendMs, null),
      latencyConfirmMs: finite(event.latencyConfirmMs, null),
      details: event.details || null,
    };
    try { this.tradeLogger.logBotLatencyEvent(normalized); } catch (_) {}
    if (normalized.mint) {
      const state = this._stateOf(normalized.mint);
      state.lastLatency = normalized;
      state.symbol = normalized.symbol || state.symbol;
      state.lastSeenAt = Math.max(state.lastSeenAt || 0, normalized.ts);
    }
  }

  flush(now = Date.now()) {
    if (!this.enabled || !this.tradeLogger) return;
    if (this.snapshotAllActive && this.tokenRegistry) {
      for (const token of this.tokenRegistry.listActive()) {
        const state = this._stateOf(token.mint);
        state.symbol = token.symbol || state.symbol;
        state.lastSeenAt = Math.max(state.lastSeenAt || 0, now);
        state.lastPrice = positive(state.lastPrice, positive(token.price, null));
      }
    }

    const bucketTs = Math.floor(now / this.snapshotIntervalMs) * this.snapshotIntervalMs;
    for (const [mint, state] of this.states) {
      this._prune(state, now);
      if (!this.snapshotAllActive && state.lastSeenAt && now - state.lastSeenAt > this.retentionMs) {
        this.states.delete(mint);
        continue;
      }
      if (state.lastSnapshotBucket === bucketTs) continue;
      state.lastSnapshotBucket = bucketTs;

      const snapshot = this._buildSnapshot(state, now, bucketTs);
      if (snapshot) {
        try { this.tradeLogger.saveTokenSnapshot(snapshot); } catch (_) {}
        this._recordMarketEvents(state, snapshot, now);
        this._appendMarketSample(state, snapshot, now);
      }

      for (const frame of CANDLE_FRAMES) {
        const candle = this._buildCandle(state, now, frame);
        if (candle) {
          try { this.tradeLogger.saveTokenCandle(candle); } catch (_) {}
        }
      }
    }
  }

  _stateOf(mint) {
    let state = this.states.get(mint);
    if (!state) {
      state = {
        mint,
        events: [],
        firstBuySeen: new Map(),
        firstSellSeen: new Map(),
        symbol: null,
        poolAddress: null,
        lastPoolQuoteAfter: null,
        lastPrice: null,
        lastSeenAt: 0,
        buyStreak: 0,
        sellStreak: 0,
        lastSnapshotBucket: null,
        marketSamples: [],
        prevNetFlow30: null,
        prevTps10: null,
        crossedFdvBands: new Set(),
        lastLatency: null,
      };
      this.states.set(mint, state);
    }
    return state;
  }

  _prune(state, now) {
    const cutoff = now - Math.max(this.retentionMs, 180_000) - 5_000;
    while (state.events.length > 0 && state.events[0].ts < cutoff) state.events.shift();
    const walletCutoff = now - 24 * 60 * 60 * 1000;
    for (const [wallet, ts] of state.firstBuySeen) {
      if (ts < walletCutoff) state.firstBuySeen.delete(wallet);
    }
    for (const [wallet, ts] of state.firstSellSeen) {
      if (ts < walletCutoff) state.firstSellSeen.delete(wallet);
    }
    while (state.marketSamples.length > 0 && state.marketSamples[0].ts < cutoff) {
      state.marketSamples.shift();
    }
  }

  _windowEvents(state, now, windowMs) {
    const start = now - windowMs;
    return state.events
      .filter((ev) => ev.ts >= start && ev.ts <= now)
      .sort((a, b) => (a.ts - b.ts) || ((a.slot || 0) - (b.slot || 0)));
  }

  _computeStats(state, now, windowMs) {
    const events = this._windowEvents(state, now, windowMs);
    const start = now - windowMs;
    const buys = events.filter((ev) => ev.side === 'BUY');
    const sells = events.filter((ev) => ev.side === 'SELL');
    const buySizes = buys.map((ev) => ev.solVolume);
    const sellSizes = sells.map((ev) => ev.solVolume);
    const buyVolume = sum(buys, (ev) => ev.solVolume);
    const sellVolume = sum(sells, (ev) => ev.solVolume);
    const buyWallets = uniqueSet(buys, (ev) => ev.signer);
    const sellWallets = uniqueSet(sells, (ev) => ev.signer);
    const allWallets = uniqueSet(events, (ev) => ev.signer);
    const newBuyWallets = [...buyWallets].filter((wallet) => (state.firstBuySeen.get(wallet) || 0) >= start).length;
    const newSellWallets = [...sellWallets].filter((wallet) => (state.firstSellSeen.get(wallet) || 0) >= start).length;
    const prices = events.map((ev) => ev.price).filter((price) => Number.isFinite(price) && price > 0);
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) returns.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
    }

    return {
      buyVolume,
      sellVolume,
      netVolume: buyVolume - sellVolume,
      buySellRatio: sellVolume > 0 ? buyVolume / sellVolume : (buyVolume > 0 ? 999 : 0),
      buyCount: buys.length,
      sellCount: sells.length,
      txCount: events.length,
      uniqueBuyWallets: buyWallets.size,
      uniqueSellWallets: sellWallets.size,
      uniqueWallets: allWallets.size,
      newBuyWallets,
      repeatBuyWallets: Math.max(0, buyWallets.size - newBuyWallets),
      newSellWallets,
      repeatSellWallets: Math.max(0, sellWallets.size - newSellWallets),
      largestBuy: buySizes.length ? Math.max(...buySizes) : 0,
      largestSell: sellSizes.length ? Math.max(...sellSizes) : 0,
      avgBuySize: average(buySizes),
      avgSellSize: average(sellSizes),
      medianBuySize: median(buySizes),
      medianSellSize: median(sellSizes),
      txPerSecond: events.length / Math.max(windowMs / 1000, 1),
      priceChange: prices.length >= 2 ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100 : 0,
      high: prices.length ? Math.max(...prices) : null,
      low: prices.length ? Math.min(...prices) : null,
      volatility: stddev(returns),
      atr: average(returns.map((n) => Math.abs(n))),
    };
  }

  _buildSnapshot(state, now, bucketTs) {
    const token = this.tokenRegistry ? this.tokenRegistry.getToken(state.mint) : null;
    const price = positive(state.lastPrice, positive(token?.price, null));
    const fdv = finite(token?.fdv, null);
    const liquidity = finite(token?.liquidity, null);
    const ageMs = this._ageMs(token, now);
    const snapshot = {
      ts: now,
      bucket_ts: bucketTs,
      mint: state.mint,
      symbol: state.symbol || token?.symbol || null,
      price,
      market_cap: finite(token?.market_cap, null),
      fdv,
      liquidity,
      age_ms: ageMs,
      age_min: ageMs == null ? null : ageMs / 60_000,
      holders: this._extractHolders(token),
      pool_address: state.poolAddress || token?.pool_address || null,
      pool_quote_after: finite(state.lastPoolQuoteAfter, null),
      buy_streak: state.buyStreak,
      sell_streak: state.sellStreak,
      lp_change_60s_pct: this._marketDeltaPct(state, now, 'liquidity', liquidity),
      fdv_change_60s_pct: this._marketDeltaPct(state, now, 'fdv', fdv),
    };

    const latency = state.lastLatency && now - state.lastLatency.ts <= this.retentionMs ? state.lastLatency : null;
    snapshot.latency_detect_ms = latency?.latencyDetectMs ?? null;
    snapshot.latency_decision_ms = latency?.latencyDecisionMs ?? null;
    snapshot.latency_send_ms = latency?.latencySendMs ?? null;
    snapshot.latency_confirm_ms = latency?.latencyConfirmMs ?? null;

    for (const w of WINDOWS_SEC) {
      const stats = this._computeStats(state, now, w * 1000);
      snapshot[`buy_volume_${w}s`] = stats.buyVolume;
      snapshot[`sell_volume_${w}s`] = stats.sellVolume;
      snapshot[`net_volume_${w}s`] = stats.netVolume;
      snapshot[`buy_sell_ratio_${w}s`] = stats.buySellRatio;
      snapshot[`buy_count_${w}s`] = stats.buyCount;
      snapshot[`sell_count_${w}s`] = stats.sellCount;
      snapshot[`tx_count_${w}s`] = stats.txCount;
      snapshot[`unique_buy_wallets_${w}s`] = stats.uniqueBuyWallets;
      snapshot[`unique_sell_wallets_${w}s`] = stats.uniqueSellWallets;
      snapshot[`unique_wallets_${w}s`] = stats.uniqueWallets;
      snapshot[`new_buy_wallets_${w}s`] = stats.newBuyWallets;
      snapshot[`repeat_buy_wallets_${w}s`] = stats.repeatBuyWallets;
      snapshot[`new_sell_wallets_${w}s`] = stats.newSellWallets;
      snapshot[`repeat_sell_wallets_${w}s`] = stats.repeatSellWallets;
      snapshot[`largest_buy_${w}s`] = stats.largestBuy;
      snapshot[`largest_sell_${w}s`] = stats.largestSell;
      snapshot[`avg_buy_size_${w}s`] = stats.avgBuySize;
      snapshot[`avg_sell_size_${w}s`] = stats.avgSellSize;
      snapshot[`median_buy_size_${w}s`] = stats.medianBuySize;
      snapshot[`median_sell_size_${w}s`] = stats.medianSellSize;
      snapshot[`tx_per_second_${w}s`] = stats.txPerSecond;
      snapshot[`price_change_${w}s`] = stats.priceChange;
      snapshot[`high_${w}s`] = stats.high;
      snapshot[`low_${w}s`] = stats.low;
      snapshot[`volatility_${w}s`] = stats.volatility;
      snapshot[`atr_${w}s`] = stats.atr;
    }

    return snapshot;
  }

  _buildCandle(state, now, frame) {
    const bucketTs = Math.floor(now / frame.ms) * frame.ms;
    const events = state.events
      .filter((ev) => ev.ts >= bucketTs && ev.ts < bucketTs + frame.ms)
      .sort((a, b) => (a.ts - b.ts) || ((a.slot || 0) - (b.slot || 0)));
    if (events.length === 0) return null;
    const prices = events.map((ev) => ev.price).filter((price) => Number.isFinite(price) && price > 0);
    if (prices.length === 0) return null;
    const buys = events.filter((ev) => ev.side === 'BUY');
    const sells = events.filter((ev) => ev.side === 'SELL');
    const token = this.tokenRegistry ? this.tokenRegistry.getToken(state.mint) : null;
    return {
      timeframe: frame.timeframe,
      bucket_ts: bucketTs,
      mint: state.mint,
      symbol: state.symbol || token?.symbol || null,
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1],
      volume_sol: sum(events, (ev) => ev.solVolume),
      buy_volume_sol: sum(buys, (ev) => ev.solVolume),
      sell_volume_sol: sum(sells, (ev) => ev.solVolume),
      buy_count: buys.length,
      sell_count: sells.length,
      tx_count: events.length,
      unique_buy_wallets: uniqueSet(buys, (ev) => ev.signer).size,
      unique_sell_wallets: uniqueSet(sells, (ev) => ev.signer).size,
      fdv: finite(token?.fdv, null),
      liquidity: finite(token?.liquidity, null),
      updated_at: now,
    };
  }

  _recordDerivedEvents(state, ev) {
    if (ev.price) {
      const prior60 = state.events.filter((x) => x.ts >= ev.ts - 60_000 && x.ts < ev.ts && x.price > 0);
      const priorHigh = prior60.length ? Math.max(...prior60.map((x) => x.price)) : null;
      if (priorHigh && ev.price > priorHigh) {
        this._recordEvent(state, ev, 'PRICE_BREAK_60S_HIGH', 'first', ev.price, {
          priorHigh,
          changePct: ((ev.price - priorHigh) / priorHigh) * 100,
        });
      }
    }

    const stats30 = this._computeStats(state, ev.ts, 30_000);
    if (state.prevNetFlow30 != null && state.prevNetFlow30 <= 0 && stats30.netVolume > 0) {
      this._recordEvent(state, ev, 'FLOW_TURN_POSITIVE', 'first', stats30.netVolume, {
        previousNetFlow30: state.prevNetFlow30,
        netFlow30: stats30.netVolume,
      });
    }
    state.prevNetFlow30 = stats30.netVolume;

    if (ev.side === 'BUY' && state.buyStreak >= this.buyBurstThreshold) {
      this._recordEvent(state, ev, 'BUY_BURST', `gte_${this.buyBurstThreshold}`, state.buyStreak, {
        buyStreak: state.buyStreak,
        threshold: this.buyBurstThreshold,
      });
    }

    const stats10 = this._computeStats(state, ev.ts, 10_000);
    if (
      state.prevTps10 != null &&
      state.prevTps10 > 0 &&
      stats10.txPerSecond >= this.tpsDoubleMin &&
      stats10.txPerSecond >= state.prevTps10 * 2
    ) {
      this._recordEvent(state, ev, 'TPS_DOUBLE', '10s_first_double', stats10.txPerSecond, {
        previousTps10: state.prevTps10,
        tps10: stats10.txPerSecond,
      });
    }
    state.prevTps10 = stats10.txPerSecond;

    if (ev.side === 'BUY' && ev.signer && this.smartWallets.has(ev.signer)) {
      this._recordEvent(state, ev, 'SMART_WALLET_BUY', ev.signer, ev.solVolume, {
        wallet: ev.signer,
        solVolume: ev.solVolume,
      });
    }
  }

  _recordMarketEvents(state, snapshot, now) {
    if (this.lpChangePct > 0 && Number.isFinite(snapshot.lp_change_60s_pct)) {
      if (Math.abs(snapshot.lp_change_60s_pct) >= this.lpChangePct) {
        const direction = snapshot.lp_change_60s_pct > 0 ? 'up' : 'down';
        this._recordEvent(state, {
          ts: now,
          price: snapshot.price,
        }, 'LP_CHANGE_60S_THRESHOLD', `${direction}_${this.lpChangePct}`, snapshot.lp_change_60s_pct, {
          liquidity: snapshot.liquidity,
          changePct: snapshot.lp_change_60s_pct,
        }, snapshot);
      }
    }

    if (Number.isFinite(snapshot.fdv)) {
      for (const band of this.fdvBandsUsd) {
        if (snapshot.fdv >= band && !state.crossedFdvBands.has(band)) {
          state.crossedFdvBands.add(band);
          this._recordEvent(state, {
            ts: now,
            price: snapshot.price,
          }, 'FDV_BAND_BREAK', String(band), snapshot.fdv, {
            band,
            fdv: snapshot.fdv,
          }, snapshot);
        }
      }
    }
  }

  _recordEvent(state, ev, eventType, eventKey, value, details, snapshot = null) {
    const token = this.tokenRegistry ? this.tokenRegistry.getToken(state.mint) : null;
    const ageMs = snapshot ? snapshot.age_ms : this._ageMs(token, ev.ts || Date.now());
    try {
      this.tradeLogger.logTokenEvent({
        ts: ev.ts || Date.now(),
        mint: state.mint,
        symbol: state.symbol || token?.symbol || null,
        eventType,
        eventKey,
        price: ev.price || snapshot?.price || state.lastPrice || token?.price || null,
        fdv: snapshot?.fdv ?? finite(token?.fdv, null),
        liquidity: snapshot?.liquidity ?? finite(token?.liquidity, null),
        ageMs,
        value,
        details,
      });
    } catch (_) {}
  }

  _appendMarketSample(state, snapshot, now) {
    state.marketSamples.push({
      ts: now,
      fdv: finite(snapshot.fdv, null),
      liquidity: finite(snapshot.liquidity, null),
    });
    this._prune(state, now);
  }

  _marketDeltaPct(state, now, field, current) {
    if (!Number.isFinite(current) || current <= 0) return null;
    const cutoff = now - 60_000;
    let prior = null;
    for (const sample of state.marketSamples) {
      if (sample.ts <= cutoff && Number.isFinite(sample[field]) && sample[field] > 0) prior = sample;
    }
    if (!prior || !Number.isFinite(prior[field]) || prior[field] <= 0) return null;
    return ((current - prior[field]) / prior[field]) * 100;
  }

  _ageMs(token, now) {
    const migrationTime = finite(token?.migration_time, null);
    if (migrationTime && migrationTime > 0) return Math.max(0, now - migrationTime);
    const addedAt = finite(token?.added_at, null);
    if (addedAt && addedAt > 0) return Math.max(0, now - addedAt);
    return null;
  }

  _extractHolders(token) {
    if (!token) return null;
    const direct = finite(token.holders, null);
    if (direct != null) return Math.round(direct);
    if (!token.meta_json) return null;
    try {
      const meta = JSON.parse(token.meta_json);
      const value = this._findNumericMeta(meta, new Set(['holders', 'holder_count', 'holderCount']));
      return value == null ? null : Math.round(value);
    } catch (_) {
      return null;
    }
  }

  _findNumericMeta(value, keys) {
    if (!value || typeof value !== 'object') return null;
    for (const key of Object.keys(value)) {
      if (keys.has(key)) {
        const n = finite(value[key], null);
        if (n != null) return n;
      }
    }
    for (const key of Object.keys(value)) {
      const nested = this._findNumericMeta(value[key], keys);
      if (nested != null) return nested;
    }
    return null;
  }
}

module.exports = FeatureRecorder;
