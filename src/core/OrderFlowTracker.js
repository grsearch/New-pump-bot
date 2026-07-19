'use strict';

const EventEmitter = require('events');
const { config } = require('../config');
const { evaluateFlowAccelerationEntry } = require('./FlowCandleStrategy');

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true' || raw === '1' || String(raw).toLowerCase() === 'yes';
}

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueCount(items, field) {
  const set = new Set();
  for (const item of items) {
    const v = item[field];
    if (v) set.add(v);
  }
  return set.size;
}

function sumVolume(items) {
  return items.reduce((sum, x) => sum + (Number.isFinite(x.solVolume) ? x.solVolume : 0), 0);
}

function stddev(values) {
  const nums = values.filter(Number.isFinite);
  if (nums.length < 2) return 0;
  const mean = nums.reduce((sum, value) => sum + value, 0) / nums.length;
  const variance = nums.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / nums.length;
  return Math.sqrt(variance);
}

function round(n, digits = 3) {
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

class OrderFlowTracker extends EventEmitter {
  constructor(opts = {}) {
    super();
    const flowConfig = config.activityFlow || {};
    this.tokenRegistry = opts.tokenRegistry || null;
    this.solPriceUsd = opts.solPriceUsd ?? numEnv('SOL_PRICE_USD', 72);

    this.enabled =
      opts.enabled ?? flowConfig.enabled ?? boolEnv('ACTIVITY_FLOW_ENABLED', boolEnv('ORDER_FLOW_ENABLED', true));
    this.replaceDumpSignal =
      opts.replaceDumpSignal ??
      flowConfig.replaceDumpSignal ??
      boolEnv('ACTIVITY_FLOW_REPLACE_DUMP_SIGNAL', boolEnv('ORDER_FLOW_REPLACE_DUMP_SIGNAL', true));

    const requestedEntryMode = String(
      (opts.entryMode ?? flowConfig.entryMode ?? process.env.ACTIVITY_FLOW_ENTRY_MODE ?? 'BREADTH_BURST_V6') ||
        'BREADTH_BURST_V6',
    ).toUpperCase();
    // Existing production .env files still name V5. Remap them so deployment cannot silently keep old entry rules.
    this.entryMode = requestedEntryMode === 'ACTIVITY_BURST_V5' ? 'BREADTH_BURST_V6' : requestedEntryMode;
    this.minVolume1mUsd =
      opts.minVolume1mUsd ?? flowConfig.minVolume1mUsd ?? numEnv('ACTIVITY_FLOW_1M_MIN_VOLUME_USD', 3000);
    this.minVolume1mSol =
      opts.minVolume1mSol ??
      flowConfig.minVolume1mSol ??
      numEnv('ACTIVITY_FLOW_1M_MIN_VOLUME_SOL', this.minVolume1mUsd / Math.max(numEnv('SOL_PRICE_USD', 72), 0.001));
    this.minTrades1m =
      opts.minTrades1m ?? flowConfig.minTrades1m ?? numEnv('ACTIVITY_FLOW_1M_MIN_TRADES', 25);
    this.armWindowMs =
      opts.armWindowMs ?? flowConfig.armWindowMs ?? numEnv('ACTIVITY_FLOW_ARM_WINDOW_MS', 30_000);
    this.armCancelMinVolume1mSol =
      opts.armCancelMinVolume1mSol ??
      flowConfig.armCancelMinVolume1mSol ??
      numEnv('ACTIVITY_FLOW_ARM_CANCEL_MIN_VOLUME_1M_SOL', 2000 / Math.max(numEnv('SOL_PRICE_USD', 72), 0.001));
    this.armMinUniqueTraders1m =
      opts.armMinUniqueTraders1m ??
      flowConfig.armMinUniqueTraders1m ??
      numEnv('ACTIVITY_FLOW_ARM_MIN_UNIQUE_TRADERS_1M', 8);
    this.armMaxLargestBuyShare1m =
      opts.armMaxLargestBuyShare1m ??
      flowConfig.armMaxLargestBuyShare1m ??
      numEnv('ACTIVITY_FLOW_ARM_MAX_LARGEST_BUY_SHARE_1M', 0.25);
    this.armCancelMaxLargestBuyShare1m =
      opts.armCancelMaxLargestBuyShare1m ??
      flowConfig.armCancelMaxLargestBuyShare1m ??
      numEnv('ACTIVITY_FLOW_ARM_CANCEL_MAX_LARGEST_BUY_SHARE_1M', 0.40);
    this.armMinVolatility1mPct =
      opts.armMinVolatility1mPct ??
      flowConfig.armMinVolatility1mPct ??
      numEnv('ACTIVITY_FLOW_ARM_MIN_VOLATILITY_1M_PCT', 1.1);
    this.triggerMinVolume5sSol =
      opts.triggerMinVolume5sSol ??
      flowConfig.triggerMinVolume5sSol ??
      numEnv('ACTIVITY_FLOW_TRIGGER_MIN_VOLUME_5S_SOL', 2);
    this.triggerMinTrades5s =
      opts.triggerMinTrades5s ?? flowConfig.triggerMinTrades5s ?? numEnv('ACTIVITY_FLOW_TRIGGER_MIN_TRADES_5S', 4);
    this.triggerMinUniqueBuyers5s =
      opts.triggerMinUniqueBuyers5s ??
      flowConfig.triggerMinUniqueBuyers5s ??
      numEnv('ACTIVITY_FLOW_TRIGGER_MIN_UNIQUE_BUYERS_5S', 2);
    this.triggerMinTxAcceleration5s =
      opts.triggerMinTxAcceleration5s ??
      flowConfig.triggerMinTxAcceleration5s ??
      numEnv('ACTIVITY_FLOW_TRIGGER_MIN_TX_ACCEL_5S', 2);
    this.triggerMinRange5sPct =
      opts.triggerMinRange5sPct ??
      flowConfig.triggerMinRange5sPct ??
      numEnv('ACTIVITY_FLOW_TRIGGER_MIN_RANGE_5S_PCT', 1);
    this.triggerMinPriceChange10sPct =
      opts.triggerMinPriceChange10sPct ??
      flowConfig.triggerMinPriceChange10sPct ??
      numEnv('ACTIVITY_FLOW_TRIGGER_MIN_PRICE_CHANGE_10S_PCT', 0);
    this.triggerMaxPriceChange10sPct =
      opts.triggerMaxPriceChange10sPct ??
      flowConfig.triggerMaxPriceChange10sPct ??
      numEnv('ACTIVITY_FLOW_TRIGGER_MAX_PRICE_CHANGE_10S_PCT', 6);
    this.triggerConfirmMinGapMs =
      opts.triggerConfirmMinGapMs ??
      flowConfig.triggerConfirmMinGapMs ??
      numEnv('ACTIVITY_FLOW_TRIGGER_CONFIRM_MIN_GAP_MS', 1_000);
    this.triggerConfirmMaxGapMs =
      opts.triggerConfirmMaxGapMs ??
      flowConfig.triggerConfirmMaxGapMs ??
      numEnv('ACTIVITY_FLOW_TRIGGER_CONFIRM_MAX_GAP_MS', 3_000);
    this.breadthMinUniqueBuyers1m =
      opts.breadthMinUniqueBuyers1m ??
      flowConfig.breadthMinUniqueBuyers1m ??
      numEnv('BREADTH_BURST_MIN_UNIQUE_BUYERS_1M', 80);
    this.breadthMinNewBuyers1m =
      opts.breadthMinNewBuyers1m ??
      flowConfig.breadthMinNewBuyers1m ??
      numEnv('BREADTH_BURST_MIN_NEW_BUYERS_1M', 40);
    this.breadthMinBuyCount1m =
      opts.breadthMinBuyCount1m ??
      flowConfig.breadthMinBuyCount1m ??
      numEnv('BREADTH_BURST_MIN_BUY_COUNT_1M', 100);
    this.breadthMaxLargestBuyShare1m =
      opts.breadthMaxLargestBuyShare1m ??
      flowConfig.breadthMaxLargestBuyShare1m ??
      numEnv('BREADTH_BURST_MAX_LARGEST_BUY_SHARE_1M', 0.10);
    this.breadthMinUniqueBuyers5s =
      opts.breadthMinUniqueBuyers5s ??
      flowConfig.breadthMinUniqueBuyers5s ??
      numEnv('BREADTH_BURST_MIN_UNIQUE_BUYERS_5S', 10);
    this.breadthPreviousRatioMax5s =
      opts.breadthPreviousRatioMax5s ??
      flowConfig.breadthPreviousRatioMax5s ??
      numEnv('BREADTH_BURST_PREVIOUS_RATIO_MAX_5S', 0.8);
    this.breadthCurrentRatioMin5s =
      opts.breadthCurrentRatioMin5s ??
      flowConfig.breadthCurrentRatioMin5s ??
      numEnv('BREADTH_BURST_CURRENT_RATIO_MIN_5S', 0.8);
    this.breadthCurrentRatioMax5s =
      opts.breadthCurrentRatioMax5s ??
      flowConfig.breadthCurrentRatioMax5s ??
      numEnv('BREADTH_BURST_CURRENT_RATIO_MAX_5S', 1.0);
    this.breadthMinAccelerationFactor5s =
      opts.breadthMinAccelerationFactor5s ??
      flowConfig.breadthMinAccelerationFactor5s ??
      numEnv('BREADTH_BURST_MIN_ACCELERATION_FACTOR_5S', 1.5);
    this.breadthMinPriceChange10sPct =
      opts.breadthMinPriceChange10sPct ??
      flowConfig.breadthMinPriceChange10sPct ??
      numEnv('BREADTH_BURST_MIN_PRICE_CHANGE_10S_PCT', -5);
    this.breadthMaxPriceChange10sPct =
      opts.breadthMaxPriceChange10sPct ??
      flowConfig.breadthMaxPriceChange10sPct ??
      numEnv('BREADTH_BURST_MAX_PRICE_CHANGE_10S_PCT', 5);
    this.breadthMaxPriceChange60sPct =
      opts.breadthMaxPriceChange60sPct ??
      flowConfig.breadthMaxPriceChange60sPct ??
      numEnv('BREADTH_BURST_MAX_PRICE_CHANGE_60S_PCT', 20);
    this.breadthMinConfirmations =
      opts.breadthMinConfirmations ??
      flowConfig.breadthMinConfirmations ??
      numEnv('BREADTH_BURST_MIN_CONFIRMATIONS', 3);
    this.breadthCooldownMs =
      opts.breadthCooldownMs ??
      flowConfig.breadthCooldownMs ??
      numEnv('BREADTH_BURST_COOLDOWN_MS', 60_000);
    this.breadthWarmupMs =
      opts.breadthWarmupMs ??
      flowConfig.breadthWarmupMs ??
      numEnv('BREADTH_BURST_WARMUP_MS', 60_000);
    this.confirmMinBuyTrades5s =
      opts.confirmMinBuyTrades5s ??
      flowConfig.confirmMinBuyTrades5s ??
      numEnv('ACTIVITY_FLOW_CONFIRM_MIN_BUY_TRADES_5S', 4);
    this.confirmMinUniqueBuyers5s =
      opts.confirmMinUniqueBuyers5s ??
      flowConfig.confirmMinUniqueBuyers5s ??
      numEnv('ACTIVITY_FLOW_CONFIRM_MIN_UNIQUE_BUYERS_5S', 3);
    this.confirmMaxBuyerShare5s =
      opts.confirmMaxBuyerShare5s ??
      flowConfig.confirmMaxBuyerShare5s ??
      numEnv('ACTIVITY_FLOW_CONFIRM_MAX_BUYER_SHARE_5S', 0.50);
    this.confirmMaxPriceRise5sPct =
      opts.confirmMaxPriceRise5sPct ??
      flowConfig.confirmMaxPriceRise5sPct ??
      numEnv('ACTIVITY_FLOW_CONFIRM_MAX_PRICE_RISE_5S_PCT', 6);
    this.confirmMaxSingleBuyImpactPct =
      opts.confirmMaxSingleBuyImpactPct ??
      flowConfig.confirmMaxSingleBuyImpactPct ??
      numEnv('ACTIVITY_FLOW_CONFIRM_MAX_SINGLE_BUY_IMPACT_PCT', 4);

    this.window5Ms = opts.window5Ms ?? flowConfig.window5Ms ?? numEnv('ACTIVITY_FLOW_WINDOW_5S_MS', 5_000);
    this.window10Ms = opts.window10Ms ?? flowConfig.window10Ms ?? numEnv('ACTIVITY_FLOW_WINDOW_10S_MS', 10_000);
    this.window15Ms = opts.window15Ms ?? flowConfig.window15Ms ?? numEnv('ACTIVITY_FLOW_WINDOW_15S_MS', 15_000);
    this.window30Ms = opts.window30Ms ?? flowConfig.window30Ms ?? numEnv('ACTIVITY_FLOW_WINDOW_30S_MS', 30_000);
    this.window60Ms = opts.window60Ms ?? flowConfig.window60Ms ?? numEnv('ACTIVITY_FLOW_WINDOW_60S_MS', 60_000);

    this.minTrades60s =
      opts.minTrades60s ?? flowConfig.minTrades60s ?? numEnv('ACTIVITY_FLOW_MIN_TRADES_60S', 24);
    this.minVolume60sSol =
      opts.minVolume60sSol ?? flowConfig.minVolume60sSol ?? numEnv('ACTIVITY_FLOW_MIN_VOLUME_60S_SOL', 12);
    this.minUniqueTraders60s =
      opts.minUniqueTraders60s ??
      flowConfig.minUniqueTraders60s ??
      numEnv('ACTIVITY_FLOW_MIN_UNIQUE_TRADERS_60S', 10);

    this.minTrades30s =
      opts.minTrades30s ?? flowConfig.minTrades30s ?? numEnv('ACTIVITY_FLOW_MIN_TRADES_30S', 12);
    this.minVolume30sSol =
      opts.minVolume30sSol ?? flowConfig.minVolume30sSol ?? numEnv('ACTIVITY_FLOW_MIN_VOLUME_30S_SOL', 6);
    this.minTrades15s =
      opts.minTrades15s ?? flowConfig.minTrades15s ?? numEnv('ACTIVITY_FLOW_MIN_TRADES_15S', 8);
    this.minVolume15sSol =
      opts.minVolume15sSol ?? flowConfig.minVolume15sSol ?? numEnv('ACTIVITY_FLOW_MIN_VOLUME_15S_SOL', 4);
    this.minImbalance15s =
      opts.minImbalance15s ?? flowConfig.minImbalance15s ?? numEnv('ACTIVITY_FLOW_MIN_IMBALANCE_15S', 0.20);
    this.minUniqueBuyers15s =
      opts.minUniqueBuyers15s ??
      flowConfig.minUniqueBuyers15s ??
      numEnv('ACTIVITY_FLOW_MIN_UNIQUE_BUYERS_15S', 3);
    this.minPriceChange15sPct =
      opts.minPriceChange15sPct ??
      flowConfig.minPriceChange15sPct ??
      numEnv('ACTIVITY_FLOW_MIN_PRICE_CHANGE_15S_PCT', -3);
    this.minPriceChange30sPct =
      opts.minPriceChange30sPct ??
      flowConfig.minPriceChange30sPct ??
      numEnv('ACTIVITY_FLOW_MIN_PRICE_CHANGE_30S_PCT', -20);
    this.minPriceChange60sPct =
      opts.minPriceChange60sPct ??
      flowConfig.minPriceChange60sPct ??
      numEnv('ACTIVITY_FLOW_MIN_PRICE_CHANGE_60S_PCT', -30);

    this.minTrades5s = opts.minTrades5s ?? flowConfig.minTrades5s ?? numEnv('ACTIVITY_FLOW_MIN_TRADES_5S', 5);
    this.minVolume5sSol =
      opts.minVolume5sSol ?? flowConfig.minVolume5sSol ?? numEnv('ACTIVITY_FLOW_MIN_VOLUME_5S_SOL', 2.5);
    this.minImbalance5s =
      opts.minImbalance5s ?? flowConfig.minImbalance5s ?? numEnv('ACTIVITY_FLOW_MIN_IMBALANCE_5S', 0.25);
    this.minUniqueBuyers5s =
      opts.minUniqueBuyers5s ?? flowConfig.minUniqueBuyers5s ?? numEnv('ACTIVITY_FLOW_MIN_UNIQUE_BUYERS_5S', 2);
    this.minPriceChange5sPct =
      opts.minPriceChange5sPct ??
      flowConfig.minPriceChange5sPct ??
      numEnv('ACTIVITY_FLOW_MIN_PRICE_CHANGE_5S_PCT', 0.2);

    this.maxPriceChange5sPct =
      opts.maxPriceChange5sPct ??
      flowConfig.maxPriceChange5sPct ??
      numEnv('ACTIVITY_FLOW_MAX_PRICE_CHANGE_5S_PCT', 5);
    this.maxPriceChange30sPct =
      opts.maxPriceChange30sPct ??
      flowConfig.maxPriceChange30sPct ??
      numEnv('ACTIVITY_FLOW_MAX_PRICE_CHANGE_30S_PCT', 10);
    this.maxPriceChange60sPct =
      opts.maxPriceChange60sPct ??
      flowConfig.maxPriceChange60sPct ??
      numEnv('ACTIVITY_FLOW_MAX_PRICE_CHANGE_60S_PCT', 10);
    this.cooldownMs =
      opts.cooldownMs ??
      flowConfig.cooldownMs ??
      numEnv('ACTIVITY_FLOW_COOLDOWN_MS', 0);
    this.maxSignalAgeMs =
      opts.maxSignalAgeMs ?? flowConfig.maxSignalAgeMs ?? numEnv('ACTIVITY_FLOW_MAX_SIGNAL_AGE_MS', config.strategy.maxPushLagMs || 5_000);
    this.maxEventsPerMint =
      opts.maxEventsPerMint ?? flowConfig.maxEventsPerMint ?? numEnv('ACTIVITY_FLOW_MAX_EVENTS_PER_MINT', 600);
    this.debug = opts.debug ?? flowConfig.debug ?? boolEnv('ACTIVITY_FLOW_DEBUG', false);

    this.maxWindowMs = Math.max(90_000, this.window5Ms, this.window15Ms, this.window30Ms, this.window60Ms);
    this.states = new Map();
    this.cooldowns = new Map();
    this._lastDebugLog = new Map();
  }

  handleSwap(swap) {
    if (!this.enabled || !swap || !swap.mint) return;
    const side = String(swap.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return;

    const price = Number(swap.price);
    const priceBefore = Number(swap.priceBefore);
    let priceChangePct = Number(swap.priceChangePct);
    const solVolume = Number(swap.solVolume);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(solVolume) || solVolume <= 0) return;
    if (!Number.isFinite(priceChangePct)) {
      priceChangePct = Number.isFinite(priceBefore) && priceBefore > 0
        ? ((price - priceBefore) / priceBefore) * 100
        : 0;
    }
    let poolQuoteAfter = Number(swap.poolQuoteAfter);
    if (!Number.isFinite(poolQuoteAfter) || poolQuoteAfter <= 0) {
      poolQuoteAfter = null;
      const tokenInfo = this.tokenRegistry ? this.tokenRegistry.getToken(swap.mint) : null;
      if (tokenInfo?.liquidity) {
        poolQuoteAfter = tokenInfo.liquidity / 170;
      }
    }

    const ev = {
      mint: swap.mint,
      symbol: swap.symbol || null,
      signer: swap.signer || null,
      side,
      solVolume,
      price,
      priceBefore: Number.isFinite(priceBefore) && priceBefore > 0 ? priceBefore : null,
      priceChangePct,
      ts: Number.isFinite(swap.ts) ? swap.ts : Date.now(),
      slot: swap.slot || 0,
      signature: swap.signature || null,
      poolAddress: swap.poolAddress || null,
      poolQuoteAfter,
    };

    const state = this._stateOf(ev.mint);
    if (state.firstSeenTs == null) state.firstSeenTs = ev.ts;
    state.events.push(ev);
    state.symbol = ev.symbol || state.symbol;
    state.poolAddress = ev.poolAddress || state.poolAddress;
    state.lastPoolQuoteAfter = ev.poolQuoteAfter || state.lastPoolQuoteAfter || null;
    this._prune(state, ev.ts);

    if (ev.side === 'BUY' && ev.signer && !state.firstBuySeen.has(ev.signer)) {
      state.firstBuySeen.set(ev.signer, ev.ts);
    }

    if (
      this.entryMode === 'FLOW_ACCEL_15S' ||
      this.entryMode === 'ACTIVITY_BURST_V5' ||
      this.entryMode === 'BREADTH_BURST_V6' ||
      ev.side === 'BUY'
    ) {
      this._trySignal(state, ev);
    }
  }

  noteSuppressedDumpSignal(signal) {
    if (!signal || !signal.mint) return;
    const state = this._stateOf(signal.mint);
    state.lastDumpSignal = signal;
  }

  getStrategyCandidates(limit = 100, now = Date.now()) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const candidates = [];
    const summary = {
      active: 0,
      volumeReady: 0,
      armReady: 0,
      armed: 0,
      confirming: 0,
      signaled: 0,
    };

    for (const [mint, state] of this.states) {
      const latest = state.events[state.events.length - 1];
      if (!latest) continue;

      const s5 = this._stats(state, now, this.window5Ms);
      const s10 = this._stats(state, now, this.window10Ms);
      const s60 = this._stats(state, now, this.window60Ms);
      if (s60.tradeCount === 0) continue;

      let conditions;
      let armReady;
      let triggerReady;
      let trigger;
      if (this.entryMode === 'BREADTH_BURST_V6') {
        const historyAgeMs = Math.max(0, now - (state.firstSeenTs ?? now));
        const breadth = this._breadthMetrics(s5, s10, s60, historyAgeMs);
        conditions = {
          ...breadth.coreConditions,
          ...breadth.supportConditions,
          supportScore: breadth.supportScore >= this.breadthMinConfirmations,
        };
        armReady = Object.values(breadth.coreConditions).every(Boolean);
        triggerReady = armReady && breadth.supportScore >= this.breadthMinConfirmations;
        trigger = {
          ...breadth.trigger,
          supportScore: breadth.supportScore,
        };
      } else {
        const previousNet5s = s10.netFlow - s5.netFlow;
        const flowAcceleration5s = s5.netFlow - previousNet5s;
        const txAcceleration5s = (2 * s5.tradeCount) - s10.tradeCount;
        conditions = {
          volume1m: s60.volumeSol >= this.minVolume1mSol,
          trades1m: s60.tradeCount >= this.minTrades1m,
          wallets1m: s60.uniqueTraders >= this.armMinUniqueTraders1m,
          largestBuy1m: s60.largestBuyShare <= this.armMaxLargestBuyShare1m,
          volatility1m: s60.volatilityPct >= this.armMinVolatility1mPct,
          netTurn5s: previousNet5s <= 0 && s5.netFlow > 0,
          flowAcceleration5s: flowAcceleration5s > 0,
          txAcceleration5s: txAcceleration5s >= this.triggerMinTxAcceleration5s,
          volume5s: s5.volumeSol >= this.triggerMinVolume5sSol,
          trades5s: s5.tradeCount >= this.triggerMinTrades5s,
          buyers5s: s5.uniqueBuyers >= this.triggerMinUniqueBuyers5s,
          range5s: s5.rangePct >= this.triggerMinRange5sPct,
          price10s:
            s10.priceChangePct >= this.triggerMinPriceChange10sPct &&
            s10.priceChangePct <= this.triggerMaxPriceChange10sPct,
        };
        armReady = [
          conditions.volume1m,
          conditions.trades1m,
          conditions.wallets1m,
          conditions.largestBuy1m,
          conditions.volatility1m,
          s10.priceChangePct <= this.triggerMaxPriceChange10sPct,
        ].every(Boolean);
        triggerReady = [
          conditions.netTurn5s,
          conditions.flowAcceleration5s,
          conditions.txAcceleration5s,
          conditions.volume5s,
          conditions.trades5s,
          conditions.buyers5s,
          conditions.range5s,
          conditions.price10s,
        ].every(Boolean);
        trigger = {
          previousNet5s: round(previousNet5s, 4),
          currentNet5s: round(s5.netFlow, 4),
          flowAcceleration5s: round(flowAcceleration5s, 4),
          txAcceleration5s: round(txAcceleration5s, 2),
        };
      }
      const armed = state.armedAt != null && state.armedUntil != null && state.armedUntil >= now;
      const recentlySignaled = state.lastV5SignalTs != null && now - state.lastV5SignalTs <= this.window60Ms;
      const recentlyCancelled =
        state.lastArmCancelTs != null && now - state.lastArmCancelTs <= this.window15Ms;

      let stage = 'monitoring';
      if (recentlySignaled) stage = 'signaled';
      else if (armed && state.triggerConfirmFirstTs != null && triggerReady) stage = 'confirming';
      else if (armed) stage = 'armed';
      else if (armReady) stage = 'ready';
      else if (recentlyCancelled) stage = 'cancelled';

      summary.active++;
      if (conditions.volume1m) summary.volumeReady++;
      if (armReady) summary.armReady++;
      if (stage === 'armed') summary.armed++;
      if (stage === 'confirming') summary.confirming++;
      if (stage === 'signaled') summary.signaled++;

      candidates.push({
        mint,
        symbol: state.symbol || null,
        updatedAt: latest.ts,
        ageMs: Math.max(0, now - latest.ts),
        stage,
        armReady,
        triggerReady,
        armedAt: armed ? state.armedAt : null,
        armedUntil: armed ? state.armedUntil : null,
        confirmFirstTs: armed ? state.triggerConfirmFirstTs : null,
        lastSignalTs: state.lastV5SignalTs || null,
        cancelReason: recentlyCancelled ? state.lastArmCancelReason : null,
        conditions,
        s60: {
          ...this._compactStats(s60),
          volumeUsd: round(s60.volumeSol * this.solPriceUsd, 2),
        },
        s10: this._compactStats(s10),
        s5: this._compactStats(s5),
        trigger,
      });
    }

    const stageRank = { signaled: 5, confirming: 4, armed: 3, ready: 2, cancelled: 1, monitoring: 0 };
    candidates.sort((a, b) =>
      (stageRank[b.stage] - stageRank[a.stage]) ||
      (Number(b.conditions.volume1m) - Number(a.conditions.volume1m)) ||
      (b.s60.volumeUsd - a.s60.volumeUsd) ||
      (b.updatedAt - a.updatedAt));

    return {
      mode: this.entryMode,
      now,
      thresholds: {
        volume1mUsd: this.minVolume1mUsd,
        volume1mSol: this.minVolume1mSol,
        trades1m: this.minTrades1m,
        wallets1m: this.armMinUniqueTraders1m,
        largestBuyShare1m: this.armMaxLargestBuyShare1m,
        volatility1mPct: this.armMinVolatility1mPct,
        volume5sSol: this.triggerMinVolume5sSol,
        trades5s: this.triggerMinTrades5s,
        buyers5s: this.triggerMinUniqueBuyers5s,
        txAcceleration5s: this.triggerMinTxAcceleration5s,
        range5sPct: this.triggerMinRange5sPct,
        priceChange10sMinPct: this.triggerMinPriceChange10sPct,
        priceChange10sMaxPct: this.triggerMaxPriceChange10sPct,
        confirmMinGapMs: this.triggerConfirmMinGapMs,
        confirmMaxGapMs: this.triggerConfirmMaxGapMs,
        buyers1m: this.breadthMinUniqueBuyers1m,
        newBuyers1m: this.breadthMinNewBuyers1m,
        buyTrades1m: this.breadthMinBuyCount1m,
        breadthLargestBuyShare1m: this.breadthMaxLargestBuyShare1m,
        breadthBuyers5s: this.breadthMinUniqueBuyers5s,
        previousRatioMax5s: this.breadthPreviousRatioMax5s,
        currentRatioMin5s: this.breadthCurrentRatioMin5s,
        currentRatioMax5s: this.breadthCurrentRatioMax5s,
        accelerationFactor5s: this.breadthMinAccelerationFactor5s,
        breadthPriceChange10sMinPct: this.breadthMinPriceChange10sPct,
        breadthPriceChange10sMaxPct: this.breadthMaxPriceChange10sPct,
        breadthPriceChange60sMaxPct: this.breadthMaxPriceChange60sPct,
        minConfirmations: this.breadthMinConfirmations,
        cooldownMs: this.breadthCooldownMs,
        warmupMs: this.breadthWarmupMs,
      },
      summary,
      candidates: candidates.slice(0, safeLimit),
    };
  }

  _stateOf(mint) {
    let state = this.states.get(mint);
    if (!state) {
      state = {
        events: [],
        symbol: null,
        poolAddress: null,
        lastPoolQuoteAfter: null,
        lastDumpSignal: null,
        lastEntrySignalBucket: null,
        firstSeenTs: null,
        armedAt: null,
        armedUntil: null,
        triggerConfirmFirstTs: null,
        lastArmCancelTs: null,
        lastArmCancelReason: null,
        lastV5SignalTs: null,
        firstBuySeen: new Map(),
        lastWalletPruneTs: 0,
      };
      this.states.set(mint, state);
    }
    return state;
  }

  _prune(state, now) {
    const cutoff = now - this.maxWindowMs - 1_000;
    while (state.events.length > 0 && state.events[0].ts < cutoff) state.events.shift();
    if (state.events.length > this.maxEventsPerMint) {
      state.events.splice(0, state.events.length - this.maxEventsPerMint);
    }
    if (now - state.lastWalletPruneTs >= 60_000) {
      const walletCutoff = now - 24 * 60 * 60 * 1000;
      for (const [wallet, ts] of state.firstBuySeen) {
        if (ts < walletCutoff) state.firstBuySeen.delete(wallet);
      }
      state.lastWalletPruneTs = now;
    }
  }

  _windowEvents(state, now, windowMs) {
    const start = now - windowMs;
    return state.events
      .filter((ev) => ev.ts >= start && ev.ts <= now)
      .sort((a, b) => (a.ts - b.ts) || ((a.slot || 0) - (b.slot || 0)));
  }

  _stats(state, now, windowMs) {
    const events = this._windowEvents(state, now, windowMs);
    const buys = events.filter((ev) => ev.side === 'BUY');
    const sells = events.filter((ev) => ev.side === 'SELL');
    const buySol = sumVolume(buys);
    const sellSol = sumVolume(sells);
    const volumeSol = buySol + sellSol;
    const buyerVolume = new Map();
    for (const buy of buys) {
      const buyer = buy.signer || '__unknown__';
      buyerVolume.set(buyer, (buyerVolume.get(buyer) || 0) + buy.solVolume);
    }
    const largestBuyerSol = buyerVolume.size > 0 ? Math.max(...buyerVolume.values()) : 0;
    const largestBuySol = buys.length > 0 ? Math.max(...buys.map((buy) => buy.solVolume)) : 0;
    const maxSingleBuyImpactPct = buys.reduce(
      (maxImpact, buy) => Math.max(maxImpact, Number.isFinite(buy.priceChangePct) ? buy.priceChangePct : 0),
      0,
    );
    const first = events[0] || null;
    const last = events[events.length - 1] || null;
    const firstPrice = first ? first.price : 0;
    const lastPrice = last ? last.price : 0;
    const priceChangePct = firstPrice > 0 && lastPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;
    const prices = events.map((event) => event.price).filter((value) => Number.isFinite(value) && value > 0);
    const returns = [];
    for (let index = 1; index < prices.length; index++) {
      returns.push(((prices[index] - prices[index - 1]) / prices[index - 1]) * 100);
    }
    const highPrice = prices.length > 0 ? Math.max(...prices) : 0;
    const lowPrice = prices.length > 0 ? Math.min(...prices) : 0;
    const start = now - windowMs;
    const uniqueBuyers = uniqueCount(buys, 'signer');
    const newUniqueBuyers = [...new Set(buys.map((buy) => buy.signer).filter(Boolean))]
      .filter((wallet) => (state.firstBuySeen.get(wallet) || 0) >= start).length;

    return {
      windowMs,
      events,
      tradeCount: events.length,
      buyCount: buys.length,
      sellCount: sells.length,
      buySol,
      sellSol,
      netFlow: buySol - sellSol,
      volumeSol,
      buySellRatio: buySol / Math.max(sellSol, 0.001),
      buyCountRatio: buys.length / Math.max(sells.length, 1),
      imbalance: (buySol - sellSol) / Math.max(volumeSol, 0.001),
      uniqueBuyers,
      newUniqueBuyers,
      uniqueSellers: uniqueCount(sells, 'signer'),
      uniqueTraders: uniqueCount(events, 'signer'),
      largestBuyerSol,
      largestBuyerShare: largestBuyerSol / Math.max(buySol, 0.001),
      largestBuySol,
      largestBuyShare: largestBuySol / Math.max(buySol, 0.001),
      maxSingleBuyImpactPct,
      firstPrice,
      lastPrice,
      priceChangePct,
      highPrice,
      lowPrice,
      rangePct: lastPrice > 0 ? ((highPrice - lowPrice) / lastPrice) * 100 : 0,
      volatilityPct: stddev(returns),
      lastSide: last ? last.side : null,
    };
  }

  _breadthMetrics(s5, s10, s60, historyAgeMs = Number.POSITIVE_INFINITY) {
    const previousBuy5s = Math.max(0, s10.buySol - s5.buySol);
    const previousSell5s = Math.max(0, s10.sellSol - s5.sellSol);
    const previousBuySellRatio5s = previousBuy5s / Math.max(previousSell5s, 0.001);
    const txAccelerationFactor5s = (s5.tradeCount * 12) / Math.max(s60.tradeCount, 1);
    const volumeAccelerationFactor5s = (s5.buySol * 12) / Math.max(s60.buySol, 0.001);

    const coreConditions = {
      historyReady: historyAgeMs >= this.breadthWarmupMs,
      volume1m: s60.volumeSol >= this.minVolume1mSol,
      buyers1m: s60.uniqueBuyers >= this.breadthMinUniqueBuyers1m,
      newBuyers1m: s60.newUniqueBuyers >= this.breadthMinNewBuyers1m,
      price60s: s60.priceChangePct <= this.breadthMaxPriceChange60sPct,
      price10s:
        s10.priceChangePct >= this.breadthMinPriceChange10sPct &&
        s10.priceChangePct <= this.breadthMaxPriceChange10sPct,
    };
    const supportConditions = {
      buyTrades1m: s60.buyCount >= this.breadthMinBuyCount1m,
      largestBuy1m: s60.largestBuyShare <= this.breadthMaxLargestBuyShare1m,
      buyers5s: s5.uniqueBuyers >= this.breadthMinUniqueBuyers5s,
      ratioTurn5s:
        previousBuySellRatio5s < this.breadthPreviousRatioMax5s &&
        s5.buySellRatio >= this.breadthCurrentRatioMin5s &&
        s5.buySellRatio <= this.breadthCurrentRatioMax5s,
      acceleration5s:
        txAccelerationFactor5s >= this.breadthMinAccelerationFactor5s ||
        volumeAccelerationFactor5s >= this.breadthMinAccelerationFactor5s,
    };
    const supportScore = Object.values(supportConditions).filter(Boolean).length;

    return {
      coreConditions,
      supportConditions,
      supportScore,
      trigger: {
        previousBuySellRatio5s,
        currentBuySellRatio5s: s5.buySellRatio,
        txAccelerationFactor5s,
        volumeAccelerationFactor5s,
      },
    };
  }

  _trySignal(state, ev) {
    const wallNow = Date.now();
    if (this.maxSignalAgeMs > 0 && wallNow - ev.ts > this.maxSignalAgeMs) {
      this._debugReject(ev.mint, ev.ts, `signal age ${wallNow - ev.ts}ms>${this.maxSignalAgeMs}ms`, null, null, null, null);
      return;
    }

    const cooldownUntil = this.cooldowns.get(ev.mint) || 0;
    if (cooldownUntil > wallNow) return;

    if (this.entryMode === 'BREADTH_BURST_V6') {
      this._tryBreadthBurstV6(state, ev, wallNow);
      return;
    }

    if (this.entryMode === 'ACTIVITY_BURST_V5') {
      this._tryActivityBurstV5(state, ev, wallNow);
      return;
    }

    const entryPattern = evaluateFlowAccelerationEntry(state.events, ev.ts, {
      sinceTs: state.firstSeenTs,
    });
    if (
      entryPattern.triggerBucketTs != null &&
      entryPattern.triggerBucketTs === state.lastEntrySignalBucket
    ) {
      return;
    }

    const s5 = this._stats(state, ev.ts, this.window5Ms);
    const s10 = this._stats(state, ev.ts, this.window10Ms);
    const s15 = this._stats(state, ev.ts, this.window15Ms);
    const s30 = this._stats(state, ev.ts, this.window30Ms);
    const s60 = this._stats(state, ev.ts, this.window60Ms);
    const poolQuoteSol = ev.poolQuoteAfter || state.lastPoolQuoteAfter || null;
    const reject = this._firstReject(s5, s15, s30, s60, entryPattern);
    if (reject) {
      this._debugReject(ev.mint, ev.ts, reject, s5, s15, s30, s60);
      return;
    }

    this._emitBuySignal(state, ev, {
      s5,
      s10,
      s15,
      s30,
      s60,
      poolQuoteSol,
      entryPattern,
    });
  }

  _tryBreadthBurstV6(state, ev, wallNow) {
    const s5 = this._stats(state, ev.ts, this.window5Ms);
    const s10 = this._stats(state, ev.ts, this.window10Ms);
    const s15 = this._stats(state, ev.ts, this.window15Ms);
    const s30 = this._stats(state, ev.ts, this.window30Ms);
    const s60 = this._stats(state, ev.ts, this.window60Ms);
    const historyAgeMs = Math.max(0, ev.ts - (state.firstSeenTs ?? ev.ts));
    const breadth = this._breadthMetrics(s5, s10, s60, historyAgeMs);

    if (state.armedUntil != null && ev.ts > state.armedUntil) {
      state.lastArmCancelTs = ev.ts;
      state.lastArmCancelReason = 'arm timeout';
      this._clearArm(state);
    }

    const coreReject = this._v6CoreReject(s10, s60, breadth);
    if (state.armedAt == null) {
      if (coreReject) {
        this._debugReject(ev.mint, ev.ts, coreReject, s5, s15, s30, s60);
        return;
      }
      state.armedAt = ev.ts;
      state.armedUntil = ev.ts + this.armWindowMs;
      state.triggerConfirmFirstTs = null;
      console.log(
        `[ActivityFlow] ARMED ${state.symbol || ev.mint.slice(0, 6)} mode=${this.entryMode} ` +
          `1m=${s60.buyCount}buys/${s60.volumeSol.toFixed(1)}SOL ` +
          `buyers=${s60.uniqueBuyers} new=${s60.newUniqueBuyers} ` +
          `price10=${s10.priceChangePct.toFixed(2)}% price60=${s60.priceChangePct.toFixed(2)}%`,
      );
      return;
    }

    if (coreReject) {
      console.log(`[ActivityFlow] ARM_CANCEL ${state.symbol || ev.mint.slice(0, 6)}: ${coreReject}`);
      state.lastArmCancelTs = ev.ts;
      state.lastArmCancelReason = coreReject;
      this._clearArm(state);
      return;
    }

    if (breadth.supportScore < this.breadthMinConfirmations) {
      state.triggerConfirmFirstTs = null;
      this._debugReject(
        ev.mint,
        ev.ts,
        `support ${breadth.supportScore}<${this.breadthMinConfirmations}`,
        s5,
        s15,
        s30,
        s60,
      );
      return;
    }

    if (state.triggerConfirmFirstTs == null || ev.ts - state.triggerConfirmFirstTs > this.triggerConfirmMaxGapMs) {
      state.triggerConfirmFirstTs = ev.ts;
      return;
    }
    if (ev.ts - state.triggerConfirmFirstTs < this.triggerConfirmMinGapMs) return;

    const poolQuoteSol = ev.poolQuoteAfter || state.lastPoolQuoteAfter || null;
    this._emitBuySignal(state, ev, {
      s5,
      s10,
      s15,
      s30,
      s60,
      poolQuoteSol,
      v6Pattern: {
        ...breadth.trigger,
        supportScore: breadth.supportScore,
        supportConditions: breadth.supportConditions,
        armedAt: state.armedAt,
        confirmGapMs: ev.ts - state.triggerConfirmFirstTs,
      },
    });
    state.lastV5SignalTs = ev.ts;
    this._clearArm(state);
    this.cooldowns.set(ev.mint, wallNow + this.breadthCooldownMs);
  }

  _v6CoreReject(s10, s60, breadth) {
    if (!breadth.coreConditions.historyReady) {
      return `history warmup <${this.breadthWarmupMs / 1000}s`;
    }
    if (!breadth.coreConditions.volume1m) {
      return `1m volume ${s60.volumeSol.toFixed(2)}<${this.minVolume1mSol.toFixed(2)}SOL`;
    }
    if (!breadth.coreConditions.buyers1m) {
      return `1m buyers ${s60.uniqueBuyers}<${this.breadthMinUniqueBuyers1m}`;
    }
    if (!breadth.coreConditions.newBuyers1m) {
      return `1m new buyers ${s60.newUniqueBuyers}<${this.breadthMinNewBuyers1m}`;
    }
    if (!breadth.coreConditions.price60s) {
      return `60s price ${s60.priceChangePct.toFixed(1)}%>${this.breadthMaxPriceChange60sPct}%`;
    }
    if (s10.priceChangePct < this.breadthMinPriceChange10sPct) {
      return `10s price ${s10.priceChangePct.toFixed(1)}%<${this.breadthMinPriceChange10sPct}%`;
    }
    if (s10.priceChangePct > this.breadthMaxPriceChange10sPct) {
      return `10s price ${s10.priceChangePct.toFixed(1)}%>${this.breadthMaxPriceChange10sPct}%`;
    }
    return null;
  }

  _tryActivityBurstV5(state, ev, wallNow) {
    const s5 = this._stats(state, ev.ts, this.window5Ms);
    const s10 = this._stats(state, ev.ts, this.window10Ms);
    const s15 = this._stats(state, ev.ts, this.window15Ms);
    const s30 = this._stats(state, ev.ts, this.window30Ms);
    const s60 = this._stats(state, ev.ts, this.window60Ms);

    if (state.armedUntil != null && ev.ts > state.armedUntil) {
      state.lastArmCancelTs = ev.ts;
      state.lastArmCancelReason = 'arm timeout';
      this._clearArm(state);
    }

    if (state.armedAt == null) {
      const armReject = this._v5ArmReject(s10, s60);
      if (armReject) {
        this._debugReject(ev.mint, ev.ts, armReject, s5, s15, s30, s60);
        return;
      }
      state.armedAt = ev.ts;
      state.armedUntil = ev.ts + this.armWindowMs;
      state.triggerConfirmFirstTs = null;
      console.log(
        `[ActivityFlow] ARMED ${state.symbol || ev.mint.slice(0, 6)} ` +
          `1m=${s60.tradeCount}tx/${s60.volumeSol.toFixed(1)}SOL ` +
          `wallets=${s60.uniqueTraders} topBuy=${(s60.largestBuyShare * 100).toFixed(1)}% ` +
          `vol=${s60.volatilityPct.toFixed(2)}%`,
      );
      return;
    }

    const cancelReason = this._v5CancelReason(s10, s60);
    if (cancelReason) {
      console.log(`[ActivityFlow] ARM_CANCEL ${state.symbol || ev.mint.slice(0, 6)}: ${cancelReason}`);
      state.lastArmCancelTs = ev.ts;
      state.lastArmCancelReason = cancelReason;
      this._clearArm(state);
      return;
    }

    const previousNet5s = s10.netFlow - s5.netFlow;
    const flowAcceleration5s = s5.netFlow - previousNet5s;
    const txAcceleration5s = (2 * s5.tradeCount) - s10.tradeCount;
    const trigger = {
      currentNet5s: s5.netFlow,
      previousNet5s,
      flowAcceleration5s,
      txAcceleration5s,
      range5sPct: s5.rangePct,
      priceChange10sPct: s10.priceChangePct,
    };

    const triggerReject = this._v5TriggerReject(s5, s10, trigger);
    if (triggerReject) {
      state.triggerConfirmFirstTs = null;
      this._debugReject(ev.mint, ev.ts, triggerReject, s5, s15, s30, s60);
      return;
    }

    if (state.triggerConfirmFirstTs == null || ev.ts - state.triggerConfirmFirstTs > this.triggerConfirmMaxGapMs) {
      state.triggerConfirmFirstTs = ev.ts;
      return;
    }
    if (ev.ts - state.triggerConfirmFirstTs < this.triggerConfirmMinGapMs) return;

    const poolQuoteSol = ev.poolQuoteAfter || state.lastPoolQuoteAfter || null;
    this._emitBuySignal(state, ev, {
      s5,
      s10,
      s15,
      s30,
      s60,
      poolQuoteSol,
      v5Pattern: {
        ...trigger,
        armedAt: state.armedAt,
        confirmGapMs: ev.ts - state.triggerConfirmFirstTs,
      },
    });
    state.lastV5SignalTs = ev.ts;
    this._clearArm(state);
    this.cooldowns.set(ev.mint, wallNow + Math.max(this.cooldownMs, 5_000));
  }

  _v5ArmReject(s10, s60) {
    if (this.minTrades1m > 0 && s60.tradeCount < this.minTrades1m) {
      return `1m trades ${s60.tradeCount}<${this.minTrades1m}`;
    }
    if (s60.volumeSol < this.minVolume1mSol) {
      return `1m volume ${s60.volumeSol.toFixed(2)}<${this.minVolume1mSol.toFixed(2)}SOL`;
    }
    if (s60.uniqueTraders < this.armMinUniqueTraders1m) {
      return `1m wallets ${s60.uniqueTraders}<${this.armMinUniqueTraders1m}`;
    }
    if (s60.largestBuyShare > this.armMaxLargestBuyShare1m) {
      return `1m largest buy ${(s60.largestBuyShare * 100).toFixed(1)}%>${(this.armMaxLargestBuyShare1m * 100).toFixed(1)}%`;
    }
    if (s60.volatilityPct < this.armMinVolatility1mPct) {
      return `1m volatility ${s60.volatilityPct.toFixed(2)}%<${this.armMinVolatility1mPct}%`;
    }
    if (s10.priceChangePct > this.triggerMaxPriceChange10sPct) {
      return `10s price ${s10.priceChangePct.toFixed(1)}%>${this.triggerMaxPriceChange10sPct}%`;
    }
    return null;
  }

  _v5CancelReason(s10, s60) {
    if (s60.volumeSol < this.armCancelMinVolume1mSol) {
      return `1m volume ${s60.volumeSol.toFixed(2)}<${this.armCancelMinVolume1mSol.toFixed(2)}SOL`;
    }
    if (s60.largestBuyShare > this.armCancelMaxLargestBuyShare1m) {
      return `1m largest buy ${(s60.largestBuyShare * 100).toFixed(1)}%>${(this.armCancelMaxLargestBuyShare1m * 100).toFixed(1)}%`;
    }
    if (s10.priceChangePct > this.triggerMaxPriceChange10sPct) {
      return `10s price ${s10.priceChangePct.toFixed(1)}%>${this.triggerMaxPriceChange10sPct}%`;
    }
    return null;
  }

  _v5TriggerReject(s5, s10, trigger) {
    if (trigger.previousNet5s > 0 || trigger.currentNet5s <= 0) return '5s net flow did not turn non-positive to positive';
    if (trigger.flowAcceleration5s <= 0) return '5s flow acceleration is not positive';
    if (trigger.txAcceleration5s < this.triggerMinTxAcceleration5s) {
      return `5s tx acceleration ${trigger.txAcceleration5s}<${this.triggerMinTxAcceleration5s}`;
    }
    if (s5.volumeSol < this.triggerMinVolume5sSol) {
      return `5s volume ${s5.volumeSol.toFixed(2)}<${this.triggerMinVolume5sSol}SOL`;
    }
    if (s5.tradeCount < this.triggerMinTrades5s) return `5s trades ${s5.tradeCount}<${this.triggerMinTrades5s}`;
    if (s5.uniqueBuyers < this.triggerMinUniqueBuyers5s) {
      return `5s buyers ${s5.uniqueBuyers}<${this.triggerMinUniqueBuyers5s}`;
    }
    if (s5.rangePct < this.triggerMinRange5sPct) {
      return `5s range ${s5.rangePct.toFixed(2)}%<${this.triggerMinRange5sPct}%`;
    }
    if (s10.priceChangePct < this.triggerMinPriceChange10sPct) {
      return `10s price ${s10.priceChangePct.toFixed(1)}%<${this.triggerMinPriceChange10sPct}%`;
    }
    if (s10.priceChangePct > this.triggerMaxPriceChange10sPct) {
      return `10s price ${s10.priceChangePct.toFixed(1)}%>${this.triggerMaxPriceChange10sPct}%`;
    }
    return null;
  }

  _clearArm(state) {
    state.armedAt = null;
    state.armedUntil = null;
    state.triggerConfirmFirstTs = null;
  }

  _emitBuySignal(
    state,
    ev,
    { s5, s10, s15, s30, s60, poolQuoteSol, entryPattern = null, v5Pattern = null, v6Pattern = null },
  ) {
    const flow = {
      s5: this._compactStats(s5),
      s10: this._compactStats(s10),
      s15: this._compactStats(s15),
      s30: this._compactStats(s30),
      s60: this._compactStats(s60),
      entry15s: entryPattern ? this._compactEntryPattern(entryPattern) : null,
      entryV5: v5Pattern ? this._compactV5Pattern(v5Pattern) : null,
      entryV6: v6Pattern ? this._compactV6Pattern(v6Pattern) : null,
    };
    const entryStats = this.entryMode === 'FLOW_ACCEL_15S' ||
      this.entryMode === 'VOLUME_RATIO_1M' ||
      this.entryMode === 'ACTIVITY_BURST_V5' ||
      this.entryMode === 'BREADTH_BURST_V6' ? s60 : s15;

    const signal = {
      mint: ev.mint,
      symbol: state.symbol || ev.symbol,
      sellSol: round(entryStats.sellSol, 4),
      priceImpactPct: round(Math.max(0, -entryStats.priceChangePct), 3),
      poolQuoteAfter: poolQuoteSol,
      poolQuoteSol,
      seller: null,
      signature: `activity:${ev.signature || `${ev.mint}:${ev.ts}`}`,
      ts: ev.ts,
      slot: ev.slot || 0,
      poolAddress: ev.poolAddress || state.poolAddress,
      priceAfter: ev.price,
      priceBefore: entryStats.firstPrice || ev.price,
      _aggregated: true,
      _activityFlow: true,
      _sellCount: entryStats.sellCount,
      _sellCount10s: entryStats.sellCount,
      _totalSellSol10s: round(entryStats.sellSol, 4),
      _sellers: [...new Set(entryStats.events.filter((x) => x.side === 'SELL').map((x) => x.signer).filter(Boolean))],
      _flow: flow,
      _flowPattern: flow.entryV6 || flow.entryV5 || flow.entry15s,
    };

    if (flow.entryV6) {
      console.log(
        `[ActivityFlow] BUY_CONFIRM ${signal.symbol || ev.mint.slice(0, 6)} mode=${this.entryMode} ` +
          `1m=${flow.s60.buyCount}buys/${flow.s60.volumeSol.toFixed(1)}SOL ` +
          `buyers=${flow.s60.uniqueBuyers} new=${flow.s60.newUniqueBuyers} ` +
          `price60=${flow.s60.priceChangePct.toFixed(2)}% ` +
          `support=${flow.entryV6.supportScore}/${Object.keys(flow.entryV6.supportConditions).length} ` +
          `ratio5=${flow.entryV6.previousBuySellRatio5s.toFixed(2)}->` +
          `${flow.entryV6.currentBuySellRatio5s.toFixed(2)} ` +
          `accel=${flow.entryV6.txAccelerationFactor5s.toFixed(2)}x/` +
          `${flow.entryV6.volumeAccelerationFactor5s.toFixed(2)}x`,
      );
    } else if (flow.entryV5) {
      console.log(
        `[ActivityFlow] BUY_CONFIRM ${signal.symbol || ev.mint.slice(0, 6)} mode=${this.entryMode} ` +
          `1m=${flow.s60.tradeCount}tx/${flow.s60.volumeSol.toFixed(1)}SOL ` +
          `net5=${flow.entryV5.previousNet5s.toFixed(2)}->${flow.entryV5.currentNet5s.toFixed(2)}SOL ` +
          `flowAccel=${flow.entryV5.flowAcceleration5s.toFixed(2)} ` +
          `txAccel=${flow.entryV5.txAcceleration5s.toFixed(0)} ` +
          `range5=${flow.entryV5.range5sPct.toFixed(2)}%`,
      );
    } else {
      console.log(
        `[ActivityFlow] BUY_CONFIRM ${signal.symbol || ev.mint.slice(0, 6)} ` +
          `mode=${this.entryMode} ` +
          `1m=${flow.s60.tradeCount}tx/${flow.s60.volumeSol.toFixed(1)}SOL ` +
          `15sNet=${flow.entry15s.netFlows.map((value) => value.toFixed(2)).join('/')}SOL ` +
          `accel=${flow.entry15s.previousAcceleration.toFixed(2)}->` +
          `${flow.entry15s.currentAcceleration.toFixed(2)}->` +
          `${flow.entry15s.latestAcceleration.toFixed(2)}`,
      );
    }

    if (entryPattern) state.lastEntrySignalBucket = entryPattern.triggerBucketTs;
    this.cooldowns.set(ev.mint, Date.now() + this.cooldownMs);
    this.emit('flowReversalSignal', signal);
  }

  _firstReject(s5, s15, s30, s60, entryPattern) {
    if (this.entryMode === 'FLOW_ACCEL_15S') {
      if (this.minTrades1m > 0 && s60.tradeCount < this.minTrades1m) {
        return `1m trades ${s60.tradeCount}<${this.minTrades1m}`;
      }
      if (s60.volumeSol < this.minVolume1mSol) {
        return `1m volume ${s60.volumeSol.toFixed(2)}<${this.minVolume1mSol.toFixed(2)}SOL`;
      }
      if (!entryPattern.matched) return entryPattern.reason;
      return null;
    }
    if (this.entryMode === 'VOLUME_RATIO_1M') {
      if (this.minTrades1m > 0 && s60.tradeCount < this.minTrades1m) {
        return `1m trades ${s60.tradeCount}<${this.minTrades1m}`;
      }
      if (s60.volumeSol < this.minVolume1mSol) {
        return `1m volume ${s60.volumeSol.toFixed(2)}<${this.minVolume1mSol.toFixed(2)}SOL`;
      }
      if (s5.buyCount < this.confirmMinBuyTrades5s) {
        return `5s buy trades ${s5.buyCount}<${this.confirmMinBuyTrades5s}`;
      }
      if (s5.uniqueBuyers < this.confirmMinUniqueBuyers5s) {
        return `5s buyers ${s5.uniqueBuyers}<${this.confirmMinUniqueBuyers5s}`;
      }
      if (s5.largestBuyerShare > this.confirmMaxBuyerShare5s) {
        return `5s top buyer ${(s5.largestBuyerShare * 100).toFixed(0)}%>${(this.confirmMaxBuyerShare5s * 100).toFixed(0)}%`;
      }
      if (s5.priceChangePct > this.confirmMaxPriceRise5sPct) {
        return `5s price ${s5.priceChangePct.toFixed(1)}%>${this.confirmMaxPriceRise5sPct}%`;
      }
      if (s5.maxSingleBuyImpactPct > this.confirmMaxSingleBuyImpactPct) {
        return `single buy impact ${s5.maxSingleBuyImpactPct.toFixed(1)}%>${this.confirmMaxSingleBuyImpactPct}%`;
      }
      if (s60.lastSide !== 'BUY') return 'last side is not BUY';
      return null;
    }

    if (s60.tradeCount < this.minTrades60s) return `60s trades ${s60.tradeCount}<${this.minTrades60s}`;
    if (s60.volumeSol < this.minVolume60sSol) return `60s volume ${s60.volumeSol.toFixed(2)}<${this.minVolume60sSol}`;
    if (s60.uniqueTraders < this.minUniqueTraders60s) {
      return `60s traders ${s60.uniqueTraders}<${this.minUniqueTraders60s}`;
    }
    if (s30.tradeCount < this.minTrades30s) return `30s trades ${s30.tradeCount}<${this.minTrades30s}`;
    if (s30.volumeSol < this.minVolume30sSol) return `30s volume ${s30.volumeSol.toFixed(2)}<${this.minVolume30sSol}`;
    if (s30.priceChangePct < this.minPriceChange30sPct) {
      return `30s price ${s30.priceChangePct.toFixed(1)}%<${this.minPriceChange30sPct}%`;
    }
    if (s60.priceChangePct < this.minPriceChange60sPct) {
      return `60s price ${s60.priceChangePct.toFixed(1)}%<${this.minPriceChange60sPct}%`;
    }

    if (s15.tradeCount < this.minTrades15s) return `15s trades ${s15.tradeCount}<${this.minTrades15s}`;
    if (s15.volumeSol < this.minVolume15sSol) return `15s volume ${s15.volumeSol.toFixed(2)}<${this.minVolume15sSol}`;
    if (s15.imbalance < this.minImbalance15s) {
      return `15s imbalance ${s15.imbalance.toFixed(2)}<${this.minImbalance15s}`;
    }
    if (s15.uniqueBuyers < this.minUniqueBuyers15s) {
      return `15s buyers ${s15.uniqueBuyers}<${this.minUniqueBuyers15s}`;
    }
    if (s15.priceChangePct < this.minPriceChange15sPct) {
      return `15s price ${s15.priceChangePct.toFixed(1)}%<${this.minPriceChange15sPct}%`;
    }

    if (s5.tradeCount < this.minTrades5s) return `5s trades ${s5.tradeCount}<${this.minTrades5s}`;
    if (s5.volumeSol < this.minVolume5sSol) return `5s volume ${s5.volumeSol.toFixed(2)}<${this.minVolume5sSol}`;
    if (s5.imbalance < this.minImbalance5s) return `5s imbalance ${s5.imbalance.toFixed(2)}<${this.minImbalance5s}`;
    if (s5.uniqueBuyers < this.minUniqueBuyers5s) return `5s buyers ${s5.uniqueBuyers}<${this.minUniqueBuyers5s}`;
    if (s5.lastSide !== 'BUY') return 'last side is not BUY';
    if (s5.priceChangePct < this.minPriceChange5sPct) {
      return `5s price ${s5.priceChangePct.toFixed(1)}%<${this.minPriceChange5sPct}%`;
    }

    if (s5.priceChangePct > this.maxPriceChange5sPct) {
      return `5s price ${s5.priceChangePct.toFixed(1)}%>${this.maxPriceChange5sPct}%`;
    }
    if (s30.priceChangePct > this.maxPriceChange30sPct) {
      return `30s price ${s30.priceChangePct.toFixed(1)}%>${this.maxPriceChange30sPct}%`;
    }
    if (s60.priceChangePct > this.maxPriceChange60sPct) {
      return `60s price ${s60.priceChangePct.toFixed(1)}%>${this.maxPriceChange60sPct}%`;
    }
    return null;
  }

  _compactStats(stats) {
    return {
      windowMs: stats.windowMs,
      tradeCount: stats.tradeCount,
      buyCount: stats.buyCount,
      sellCount: stats.sellCount,
      buySol: round(stats.buySol, 4),
      sellSol: round(stats.sellSol, 4),
      netFlow: round(stats.netFlow, 4),
      volumeSol: round(stats.volumeSol, 4),
      buySellRatio: round(stats.buySellRatio, 3),
      buyCountRatio: round(stats.buyCountRatio, 3),
      imbalance: round(stats.imbalance, 3),
      uniqueBuyers: stats.uniqueBuyers,
      newUniqueBuyers: stats.newUniqueBuyers,
      uniqueSellers: stats.uniqueSellers,
      uniqueTraders: stats.uniqueTraders,
      largestBuyerShare: round(stats.largestBuyerShare, 3),
      largestBuyShare: round(stats.largestBuyShare, 3),
      maxSingleBuyImpactPct: round(stats.maxSingleBuyImpactPct, 3),
      priceChangePct: round(stats.priceChangePct, 3),
      rangePct: round(stats.rangePct, 3),
      volatilityPct: round(stats.volatilityPct, 3),
    };
  }

  _compactV5Pattern(pattern) {
    return {
      armedAt: pattern.armedAt,
      confirmGapMs: pattern.confirmGapMs,
      previousNet5s: round(pattern.previousNet5s, 4),
      currentNet5s: round(pattern.currentNet5s, 4),
      flowAcceleration5s: round(pattern.flowAcceleration5s, 4),
      txAcceleration5s: round(pattern.txAcceleration5s, 2),
      range5sPct: round(pattern.range5sPct, 3),
      priceChange10sPct: round(pattern.priceChange10sPct, 3),
    };
  }

  _compactV6Pattern(pattern) {
    return {
      armedAt: pattern.armedAt,
      confirmGapMs: pattern.confirmGapMs,
      supportScore: pattern.supportScore,
      supportConditions: { ...pattern.supportConditions },
      previousBuySellRatio5s: round(pattern.previousBuySellRatio5s, 3),
      currentBuySellRatio5s: round(pattern.currentBuySellRatio5s, 3),
      txAccelerationFactor5s: round(pattern.txAccelerationFactor5s, 3),
      volumeAccelerationFactor5s: round(pattern.volumeAccelerationFactor5s, 3),
    };
  }

  _compactEntryPattern(pattern) {
    return {
      triggerBucketTs: pattern.triggerBucketTs,
      previousAcceleration: round(pattern.previousAcceleration, 4),
      currentAcceleration: round(pattern.currentAcceleration, 4),
      latestAcceleration: round(pattern.latestAcceleration, 4),
      netFlows: pattern.candles.map((candle) => round(candle.netFlow, 4)),
    };
  }

  _debugReject(mint, ts, reason, s5, s15, s30, s60) {
    if (!this.debug) return;
    const last = this._lastDebugLog.get(mint) || 0;
    if (ts - last < 2_000) return;
    this._lastDebugLog.set(mint, ts);
    if (!s5 || !s15 || !s30 || !s60) {
      console.log(`[ActivityFlow] skip ${mint.slice(0, 6)}: ${reason}`);
      return;
    }
    console.log(
      `[ActivityFlow] skip ${mint.slice(0, 6)}: ${reason} ` +
        `5s=${s5.tradeCount}tx/${s5.volumeSol.toFixed(1)}SOL r=${s5.buySellRatio.toFixed(2)} ` +
        `15s=${s15.tradeCount}tx/${s15.volumeSol.toFixed(1)}SOL r=${s15.buySellRatio.toFixed(2)} ` +
        `30s=${s30.tradeCount}tx/${s30.volumeSol.toFixed(1)}SOL ` +
        `60s=${s60.tradeCount}tx/${s60.volumeSol.toFixed(1)}SOL`,
    );
  }
}

module.exports = OrderFlowTracker;
