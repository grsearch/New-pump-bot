'use strict';

const EventEmitter = require('events');
const { config } = require('../config');
const { evaluateFlowAccelerationEntry } = require('./FlowCandleStrategy');
const { normalizeUnixMs } = require('../utils/migrationTime');

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
      (opts.entryMode ?? flowConfig.entryMode ?? process.env.ACTIVITY_FLOW_ENTRY_MODE ?? 'ONE_SECOND_REBOUND_V8') ||
        'ONE_SECOND_REBOUND_V8',
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
    this.reboundWindowMs =
      opts.reboundWindowMs ??
      flowConfig.reboundWindowMs ??
      numEnv('REBOUND_WINDOW_MS', 1_000);
    this.reboundMinDropPct =
      opts.reboundMinDropPct ??
      flowConfig.reboundMinDropPct ??
      numEnv('REBOUND_MIN_DROP_PCT', 20);
    this.reboundMaxDropPct =
      opts.reboundMaxDropPct ??
      flowConfig.reboundMaxDropPct ??
      numEnv('REBOUND_MAX_DROP_PCT', 65);
    this.reboundMinRecoveryPct =
      opts.reboundMinRecoveryPct ??
      flowConfig.reboundMinRecoveryPct ??
      numEnv('REBOUND_MIN_RECOVERY_PCT', 2);
    this.reboundMaxRecoveryPct =
      opts.reboundMaxRecoveryPct ??
      flowConfig.reboundMaxRecoveryPct ??
      numEnv('REBOUND_MAX_RECOVERY_PCT', 10);
    this.reboundConfirmMinGapMs =
      opts.reboundConfirmMinGapMs ??
      flowConfig.reboundConfirmMinGapMs ??
      numEnv('REBOUND_CONFIRM_MIN_GAP_MS', 1_000);
    this.reboundConfirmMaxGapMs =
      opts.reboundConfirmMaxGapMs ??
      flowConfig.reboundConfirmMaxGapMs ??
      numEnv('REBOUND_CONFIRM_MAX_GAP_MS', 3_000);
    this.reboundMinUniqueBuyers1s =
      opts.reboundMinUniqueBuyers1s ??
      flowConfig.reboundMinUniqueBuyers1s ??
      numEnv('REBOUND_MIN_UNIQUE_BUYERS_1S', 2);
    this.reboundCooldownMs =
      opts.reboundCooldownMs ??
      flowConfig.reboundCooldownMs ??
      numEnv('REBOUND_COOLDOWN_MS', 60_000);
    this.breadthMinUniqueBuyers1m =
      opts.breadthMinUniqueBuyers1m ??
      flowConfig.breadthMinUniqueBuyers1m ??
      numEnv('BREADTH_BURST_MIN_UNIQUE_BUYERS_1M', 100);
    this.breadthMinNewBuyers1m =
      opts.breadthMinNewBuyers1m ??
      flowConfig.breadthMinNewBuyers1m ??
      numEnv('BREADTH_BURST_MIN_NEW_BUYERS_1M', 30);
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
    this.breadthMaxAvgBuyPerWallet5sSol =
      opts.breadthMaxAvgBuyPerWallet5sSol ??
      flowConfig.breadthMaxAvgBuyPerWallet5sSol ??
      numEnv('BREADTH_BURST_MAX_AVG_BUY_PER_WALLET_5S_SOL', 0.4);
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
    this.age3EntryTargetMs =
      opts.age3EntryTargetMs ??
      flowConfig.age3EntryTargetMs ??
      numEnv('AGE3_ENTRY_TARGET_MS', 180_000);
    this.age3EntryToleranceMs =
      opts.age3EntryToleranceMs ??
      flowConfig.age3EntryToleranceMs ??
      numEnv('AGE3_ENTRY_TOLERANCE_MS', 15_000);
    this.age3MinFdvUsd =
      opts.age3MinFdvUsd ??
      flowConfig.age3MinFdvUsd ??
      numEnv('AGE3_ENTRY_MIN_FDV_USD', 40_000);
    this.age3MinUniqueBuyers1m =
      opts.age3MinUniqueBuyers1m ??
      flowConfig.age3MinUniqueBuyers1m ??
      numEnv('AGE3_ENTRY_MIN_UNIQUE_BUYERS_1M', 17);
    this.age3TokenSupply =
      opts.age3TokenSupply ??
      flowConfig.age3TokenSupply ??
      numEnv('PUMP_TOKEN_SUPPLY', 1_000_000_000);
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
    this.maxPriceChange60sPc×5æÚ$z{-®éÜj×W&âsW2fÆ÷r66VÆW&F–öâ—2æ÷B÷6—F—fRs°Ğ¢–b‡G&–vvW"çG„66VÆW&F–öãW2ÂF†—2çG&–vvW$Ö–åG„66VÆW&F–öãW2’°Ğ¢&WGW&âW2G‚66VÆW&F–öâG·G&–vvW"çG„66VÆW&F–öãW7ÓÂG·F†—2çG&–vvW$Ö–åG„66VÆW&F–öãW7Ö°Ğ¢ĞĞ¢–b‡3RçföÇVÖU6öÂÂF†—2çG&–vvW$Ö–åföÇVÖSW56öÂ’°Ğ¢&WGW&âW2föÇVÖRG·3RçföÇVÖU6öÂçFôf—†VBƒ"—ÓÂG·F†—2çG&–vvW$Ö–åföÇVÖSW56öÇÕ4ôÆ°Ğ¢ĞĞ¢–b‡3RçG&FT6÷VçBÂF†—2çG&–vvW$Ö–åG&FW3W2’&WGW&âW2G&FW2G·3RçG&FT6÷VçGÓÂG·F†—2çG&–vvW$Ö–åG&FW3W7Ö°Ğ¢–b‡3RçVæ—VT'W–W'2ÂF†—2çG&–vvW$Ö–åVæ—VT'W–W'3W2’°Ğ¢&WGW&âW2'W–W'2G·3RçVæ—VT'W–W'7ÓÂG·F†—2çG&–vvW$Ö–åVæ—VT'W–W'3W7Ö°Ğ¢ĞĞ¢–b‡3Rç&ævU7BÂF†—2çG&–vvW$Ö–å&ævSW57B’°Ğ¢&WGW&âW2&ævRG·3Rç&ævU7BçFôf—†VBƒ"—ÒSÂG·F†—2çG&–vvW$Ö–å&ævSW57GÒV°Ğ¢ĞĞ¢–b‡3ç&–6T6†ævU7BÂF†—2çG&–vvW$Ö–å&–6T6†ævS57B’°Ğ¢&WGW&â2&–6RG·3ç&–6T6†ævU7BçFôf—†VBƒ—ÒSÂG·F†—2çG&–vvW$Ö–å&–6T6†ævS57GÒV°Ğ¢ĞĞ¢–b‡3ç&–6T6†ævU7BâF†—2çG&–vvW$Ö…&–6T6†ævS57B’°Ğ¢&WGW&â2&–6RG·3ç&–6T6†ævU7BçFôf—†VBƒ—ÒSâG·F†—2çG&–vvW$Ö…&–6T6†ævS57GÒV°Ğ¢ĞĞ¢&WGW&âçVÆÃ°Ğ¢ĞĞ Ğ¢ö6ÆV$&Ò‡7FFR’°¢7FFRæ&ÖVDBÒçVÆÃ°¢7FFRæ&ÖVEVçF–ÂÒçVÆÃ°¢7FFRçG&–vvW$6öæf—&Ôf—'7EG2ÒçVÆÃ°¢7FFRæÆ7D&Õv—EG2ÒçVÆÃ°¢7FFRæÆ7D&Õv—E&V6öâÒçVÆÃ°¢Ğ Ğ¢öVÖ—D'W•6–væÂ€¢7FFRÀ¢WbÀ¢°¢3ÒçVÆÂÀ¢3RÀ¢3À¢3RÀ¢33À¢3cÀ¢ööÅV÷FU6öÂÀ¢VçG'•GFW&âÒçVÆÂÀ¢cUGFW&âÒçVÆÂÀ¢ceGFW&âÒçVÆÂÀ¢vS5GFW&âÒçVÆÂÀ¢&V&÷VæEGFW&âÒçVÆÂÀ¢ÒÀ¢’°¢6öç7BfÆ÷rÒ°¢3¢3òF†—2åö6ö×7E7FG2‡3’¢çVÆÂÀ¢3S¢F†—2åö6ö×7E7FG2‡3R’À¢3¢F†—2åö6ö×7E7FG2‡3’ÀĞ¢3S¢F†—2åö6ö×7E7FG2‡3R’ÀĞ¢33¢F†—2åö6ö×7E7FG2‡33’ÀĞ¢3c¢F†—2åö6ö×7E7FG2‡3c’ÀĞ¢VçG'“W3¢VçG'•GFW&âòF†—2åö6ö×7DVçG'•GFW&â†VçG'•GFW&â’¢çVÆÂÀ¢VçG'•cS¢cUGFW&âòF†—2åö6ö×7EcUGFW&â‡cUGFW&â’¢çVÆÂÀ¢VçG'•cc¢ceGFW&âòF†—2åö6ö×7EceGFW&â‡ceGFW&â’¢çVÆÂÀ¢VçG'•&V&÷VæC¢&V&÷VæEGFW&âòF†—2åö6ö×7E&V&÷VæEGFW&â‡&V&÷VæEGFW&â’¢çVÆÂÀ¢VçG'”vS3¢vS5GFW&âò°¢Ö–w&F–öåG3¢vS5GFW&âæÖ–w&F–öåG2À¢Fö¶VävT×3¢&÷VæB†vS5GFW&âçFö¶VävT×2Â’À¢fGeW6C¢&÷VæB†vS5GFW&âæfGeW6BÂ"’À¢Væ—VT'W–W'3Ó¢vS5GFW&âçVæ—VT'W–W'3ÒÀ¢Ò¢çVÆÂÀ¢Ó°¢6öç7BVçG'•7FG2ÒfÆ÷ræVçG'•&V&÷VæBò3¢€¢F†—2æVçG'”ÖöFRÓÓÒtdÄõuô44TÅóU2rÇÀ¢F†—2æVçG'”ÖöFRÓÓÒudôÅTÔUõ$D”õóÒrÇÀ¢F†—2æVçG'”ÖöFRÓÓÒt5D•d•E•ô%U%5EõcRrÇÀ¢F†—2æVçG'”ÖöFRÓÓÒt%$TED…ô%U%5EõcbrÇÀ¢F†—2æVçG'”ÖöFRÓÓÒttS5ô%$TED…õcrrò3c¢3P¢“° Ğ¢6öç7B6–væÂÒ°Ğ¢Ö–çC¢WbæÖ–çBÀĞ¢7–Ö&öÃ¢7FFRç7–Ö&öÂÇÂWbç7–Ö&öÂÀĞ¢6VÆÅ6öÃ¢&÷VæB†VçG'•7FG2ç6VÆÅ6öÂÂB’ÀĞ¢&–6T–×7E7C¢&÷VæB„ÖF‚æÖ‚ƒÂÖVçG'•7FG2ç&–6T6†ævU7B’Â2’ÀĞ¢ööÅV÷FTgFW#¢ööÅV÷FU6öÂÀĞ¢ööÅV÷FU6öÂÀĞ¢6VÆÆW#¢çVÆÂÀĞ¢6–væGW&S¢7F—f—G“¢G¶Wbç6–væGW&RÇÂG¶WbæÖ–çGÓ¢G¶WbçG7ÖÖÀĞ¢G3¢WbçG2ÀĞ¢6Æ÷C¢Wbç6Æ÷BÇÂÀĞ¢ööÄFG&W73¢WbçööÄFG&W72ÇÂ7FFRçööÄFG&W72ÀĞ¢&–6TgFW#¢Wbç&–6RÀĞ¢&–6T&Vf÷&S¢VçG'•7FG2æf—'7E&–6RÇÂWbç&–6RÀĞ¢övw&VvFVC¢G'VRÀ¢ö7F—f—G”fÆ÷s¢G'VRÀ¢övS4VçG'“¢fÆ÷ræVçG'”vS2À¢÷&V&÷VæDVçG'“¢fÆ÷ræVçG'•&V&÷VæBÀ¢÷6VÆÄ6÷VçC¢VçG'•7FG2ç6VÆÄ6÷VçBÀĞ¢÷6VÆÄ6÷VçC3¢VçG'•7FG2ç6VÆÄ6÷VçBÀĞ¢÷F÷FÅ6VÆÅ6öÃ3¢&÷VæB†VçG'•7FG2ç6VÆÅ6öÂÂB’ÀĞ¢÷6VÆÆW'3¢²ââææWr6WB†VçG'•7FG2æWfVçG2æf–ÇFW"‚‡‚’Óâ‚ç6–FRÓÓÒu4TÄÂr’æÖ‚‡‚’Óâ‚ç6–væW"’æf–ÇFW"„&ööÆVâ’•ÒÀĞ¢öfÆ÷s¢fÆ÷rÀĞ¢öfÆ÷uGFW&ã ¢fÆ÷ræVçG'•&V&÷VæBÇÀ¢fÆ÷ræVçG'”vS2ÇÀ¢fÆ÷ræVçG'•cbÇÀ¢fÆ÷ræVçG'•cRÇÀ¢fÆ÷ræVçG'“W2À¢Ó° ¢–b†fÆ÷ræVçG'•&V&÷VæB’°¢6öç6öÆRæÆör€¢´7F—f—G”fÆ÷uÒ%U•ô4ôäd•$ÒG·6–væÂç7–Ö&öÂÇÂWbæÖ–çBç6Æ–6RƒÂb—ÒÖöFSÒG·F†—2æVçG'”ÖöFWÒ°¢G&÷ÒG¶fÆ÷ræVçG'•&V&÷VæBæG&÷FWF…7BçFôf—†VBƒ"—ÒR°¢&V6÷fW'“ÒG¶fÆ÷ræVçG'•&V&÷VæBç&V6÷fW'•7BçFôf—†VBƒ"—ÒR°¢'W–W'3ÒG¶fÆ÷ræVçG'•&V&÷VæBçVæ—VT'W–W'37Ò°¢6öæf—&ÓÒG¶fÆ÷ræVçG'•&V&÷VæBæ6öæf—&Ôv×7Ö×6À¢“°¢ÒVÇ6R–b†fÆ÷ræVçG'”vS2’°¢6öç6öÆRæÆör€¢´7F—f—G”fÆ÷uÒ%U•ô4ôäd•$ÒG·6–væÂç7–Ö&öÂÇÂWbæÖ–çBç6Æ–6RƒÂb—ÒÖöFSÒG·F†—2æVçG'”ÖöFWÒ°¢vSÒG²†fÆ÷ræVçG'”vS2çFö¶VävT×2ò’çFôf—†VBƒ—×2°¢fGcÒBG´ÖF‚ç&÷VæB†fÆ÷ræVçG'”vS2æfGeW6B—Ò°¢'W–W'3cÒG¶fÆ÷rç3cçVæ—VT'W–W'7Ò°¢föÇVÖScÒBG´ÖF‚ç&÷VæB†fÆ÷rç3cçföÇVÖU6öÂ¢F†—2ç6öÅ&–6UW6B—ÖÀ¢“°¢ÒVÇ6R–b†fÆ÷ræVçG'•cb’°¢6öç6öÆRæÆör€Ğ¢´7F—f—G”fÆ÷uÒ%U•ô4ôäd•$ÒG·6–væÂç7–Ö&öÂÇÂWbæÖ–çBç6Æ–6RƒÂb—ÒÖöFSÒG·F†—2æVçG'”ÖöFWÒ°Ğ¢ÓÒG¶fÆ÷rç3cæ'W”6÷VçGÖ'W—2òG¶fÆ÷rç3cçföÇVÖU6öÂçFôf—†VBƒ—Õ4ôÂ°Ğ¢'W–W'3ÒG¶fÆ÷rç3cçVæ—VT'W–W'7ÒæWsÒG¶fÆ÷rç3cææWuVæ—VT'W–W'7Ò°¢ft'W“SÒG¶fÆ÷ræVçG'•cbæft'W•W%vÆÆWCW56öÂçFôf—†VBƒ"—Õ4ôÂ°¢&–6ScÒG¶fÆ÷rç3cç&–6T6†ævU7BçFôf—†VBƒ"—ÒR°¢7W÷'CÒG¶fÆ÷ræVçG'•cbç7W÷'E66÷&WÒòG´ö&¦V7Bæ¶W—2†fÆ÷ræVçG'•cbç7W÷'D6öæF—F–öç2’æÆVæwF‡Ò°¢&F–óSÒG¶fÆ÷ræVçG'•cbç&Wf–÷W4'W•6VÆÅ&F–óW2çFôf—†VBƒ"—ÒÓæ°Ğ¢G¶fÆ÷ræVçG'•cbæ7W'&VçD'W•6VÆÅ&F–óW2çFôf—†VBƒ"—Ò°Ğ¢66VÃÒG¶fÆ÷ræVçG'•cbçG„66VÆW&F–öäf7F÷#W2çFôf—†VBƒ"—×‚ö°Ğ¢G¶fÆ÷ræVçG'•cbçföÇVÖT66VÆW&F–öäf7F÷#W2çFôf—†VBƒ"—×†ÀĞ¢“°Ğ¢ÒVÇ6R–b†fÆ÷ræVçG'•cR’°Ğ¢6öç6öÆRæÆör€Ğ¢´7F—f—G”fÆ÷uÒ%U•ô4ôäd•$ÒG·6–væÂç7–Ö&öÂÇÂWbæÖ–çBç6Æ–6RƒÂb—ÒÖöFSÒG·F†—2æVçG'”ÖöFWÒ°Ğ¢ÓÒG¶fÆ÷rç3cçG&FT6÷VçG×G‚òG¶fÆ÷rç3cçföÇVÖU6öÂçFôf—†VBƒ—Õ4ôÂ°Ğ¢æWCSÒG¶fÆ÷ræVçG'•cRç&Wf–÷W4æWCW2çFôf—†VBƒ"—ÒÓâG¶fÆ÷ræVçG'•cRæ7W'&VçDæWCW2çFôf—†VBƒ"—Õ4ôÂ°Ğ¢fÆ÷t66VÃÒG¶fÆ÷ræVçG'•cRæfÆ÷t66VÆW&F–öãW2çFôf—†VBƒ"—Ò°Ğ¢G„66VÃÒG¶fÆ÷ræVçG'•cRçG„66VÆW&F–öãW2çFôf—†VBƒ—Ò°Ğ¢&ævSSÒG¶fÆ÷ræVçG'•cRç&ævSW57BçFôf—†VBƒ"—ÒVÀĞ¢“°Ğ¢ÒVÇ6R°Ğ¢6öç6öÆRæÆör€Ğ¢´7F—f—G”fÆ÷uÒ%U•ô4ôäd•$ÒG·6–væÂç7–Ö&öÂÇÂWbæÖ–çBç6Æ–6RƒÂb—Ò°Ğ¢ÖöFSÒG·F†—2æVçG'”ÖöFWÒ°Ğ¢ÓÒG¶fÆ÷rç3cçG&FT6÷VçG×G‚òG¶fÆ÷rç3cçföÇVÖU6öÂçFôf—†VBƒ—Õ4ôÂ°Ğ¢W4æWCÒG¶fÆ÷ræVçG'“W2ææWDfÆ÷w2æÖ‚‡fÇVR’ÓâfÇVRçFôf—†VBƒ"’’æ¦ö–â‚ròr—Õ4ôÂ°Ğ¢66VÃÒG¶fÆ÷ræVçG'“W2ç&Wf–÷W466VÆW&F–öâçFôf—†VBƒ"—ÒÓæ°Ğ¢G¶fÆ÷ræVçG'“W2æ7W'&VçD66VÆW&F–öâçFôf—†VBƒ"—ÒÓæ°Ğ¢G¶fÆ÷ræVçG'“W2æÆFW7D66VÆW&F–öâçFôf—†VBƒ"—ÖÀĞ¢“°Ğ¢ĞĞ Ğ¢–b†VçG'•GFW&â’7FFRæÆ7DVçG'•6–væÄ'V6¶WBÒVçG'•GFW&âçG&–vvW$'V6¶WEG3°Ğ¢F†—2æ6ööÆF÷vç2ç6WB†WbæÖ–çBÂFFRææ÷r‚’²F†—2æ6ööÆF÷vä×2“°Ğ¢F†—2æVÖ—B‚vfÆ÷u&WfW'6Å6–væÂrÂ6–væÂ“°Ğ¢ĞĞ Ğ¢öf—'7E&V¦V7B‡3RÂ3RÂ33Â3cÂVçG'•GFW&â’°Ğ¢–b‡F†—2æVçG'”ÖöFRÓÓÒtdÄõuô44TÅóU2r’°Ğ¢–b‡F†—2æÖ–åG&FW3Òâbb3cçG&FT6÷VçBÂF†—2æÖ–åG&FW3Ò’°Ğ¢&WGW&âÒG&FW2G·3cçG&FT6÷VçGÓÂG·F†—2æÖ–åG&FW3×Ö°Ğ¢ĞĞ¢–b‡3cçföÇVÖU6öÂÂF†—2æÖ–åföÇVÖSÕ6öÂ’°Ğ¢&WGW&âÒföÇVÖRG·3cçföÇVÖU6öÂçFôf—†VBƒ"—ÓÂG·F†—2æÖ–åföÇVÖSÕ6öÂçFôf—†VBƒ"—Õ4ôÆ°Ğ¢ĞĞ¢–b‚VçG'•GFW&âæÖF6†VB’&WGW&âVçG'•GFW&âç&V6öã°Ğ¢&WGW&âçVÆÃ°Ğ¢ĞĞ¢–b‡F†—2æVçG'”ÖöFRÓÓÒudôÅTÔUõ$D”õóÒr’°Ğ¢–b‡F†—2æÖ–åG&FW3Òâbb3cçG&FT6÷VçBÂF†—2æÖ–åG&FW3Ò’°Ğ¢&WGW&âÒG&FW2G·3cçG&FT6÷VçGÓÂG·F†—2æÖ–åG&FW3×Ö°Ğ¢ĞĞ¢–b‡3cçföÇVÖU6öÂÂF†—2æÖ–åföÇVÖSÕ6öÂ’°Ğ¢&WGW&âÒföÇVÖRG·3cçföÇVÖU6öÂçFôf—†VBƒ"—ÓÂG·F†—2æÖ–åföÇVÖSÕ6öÂçFôf—†VBƒ"—Õ4ôÆ°Ğ¢ĞĞ¢–b‡3Ræ'W”6÷VçBÂF†—2æ6öæf—&ÔÖ–ä'W•G&FW3W2’°Ğ¢&WGW&âW2'W’G&FW2G·3Ræ'W”6÷VçGÓÂG·F†—2æ6öæf—&ÔÖ–ä'W•G&FW3W7Ö°Ğ¢ĞĞ¢–b‡3RçVæ—VT'W–W'2ÂF†—2æ6öæf—&ÔÖ–åVæ—VT'W–W'3W2’°Ğ¢&WGW&âW2'W–W'2G·3RçVæ—VT'W–W'7ÓÂG·F†—2æ6öæf—&ÔÖ–åVæ—VT'W–W'3W7Ö°Ğ¢ĞĞ¢–b‡3RæÆ&vW7D'W–W%6†&RâF†—2æ6öæf—&ÔÖ„'W–W%6†&SW2’°Ğ¢&WGW&âW2F÷'W–W"G²‡3RæÆ&vW7D'W–W%6†&R¢’çFôf—†VBƒ—ÒSâG²‡F†—2æ6öæf—&ÔÖ„'W–W%6†&SW2¢’çFôf—†VBƒ—ÒV°Ğ¢ĞĞ¢–b‡3Rç&–6T6†ævU7BâF†—2æ6öæf—&ÔÖ…&–6U&—6SW57B’°Ğ¢&WGW&âW2&–6RG·3Rç&–6T6†ævU7BçFôf—†VBƒ—ÒSâG·F†—2æ6öæf—&ÔÖ…&–6U&—6SW57GÒV°Ğ¢ĞĞ¢–b‡3RæÖ…6–ævÆT'W”–×7E7BâF†—2æ6öæf—&ÔÖ…6–ævÆT'W”–×7E7B’°Ğ¢&WGW&â6–ævÆR'W’–×7BG·3RæÖ…6–ævÆT'W”–×7E7BçFôf—†VBƒ—ÒSâG·F†—2æ6öæf—&ÔÖ…6–ævÆT'W”–×7E7GÒV°Ğ¢ĞĞ¢–b‡3cæÆ7E6–FRÓÒt%U’r’&WGW&âvÆ7B6–FR—2æ÷B%U’s°Ğ¢&WGW&âçVÆÃ°Ğ¢ĞĞ Ğ¢–b‡3cçG&FT6÷VçBÂF†—2æÖ–åG&FW3c2’&WGW&âc2G&FW2G·3cçG&FT6÷VçGÓÂG·F†—2æÖ–åG&FW3c7Ö°Ğ¢–b‡3cçföÇVÖU6öÂÂF†—2æÖ–åföÇVÖSc56öÂ’&WGW&âc2föÇVÖRG·3cçföÇVÖU6öÂçFôf—†VBƒ"—ÓÂG·F†—2æÖ–åföÇVÖSc56öÇÖ°Ğ¢–b‡3cçVæ—VUG&FW'2ÂF†—2æÖ–åVæ—VUG&FW'3c2’°Ğ¢&WGW&âc2G&FW'2G·3cçVæ—VUG&FW'7ÓÂG·F†—2æÖ–åVæ—VUG&FW'3c7Ö°Ğ¢ĞĞ¢–b‡33çG&FT6÷VçBÂF†—2æÖ–åG&FW332’&WGW&â32G&FW2G·33çG&FT6÷VçGÓÂG·F†—2æÖ–åG&FW337Ö°Ğ¢–b‡33çföÇVÖU6öÂÂF†—2æÖ–åföÇVÖS356öÂ’&WGW&â32föÇVÖRG·33çföÇVÖU6öÂçFôf—†VBƒ"—ÓÂG·F†—2æÖ–åföÇVÖS356öÇÖ°Ğ¢–b‡33ç&–6T6†ævU7BÂF†—2æÖ–å&–6T6†ævS357B’°Ğ¢&WGW&â32&–6RG·33ç&–6T6†ævU7BçFôf—†VBƒ—ÒSÂG·F†—2æÖ–å&–6T6†ævS357GÒV°Ğ¢ĞĞ¢–b‡3cç&–6T6†ævU7BÂF†—2æÖ–å&–6T6†ævSc57B’°Ğ¢&WGW&âc2&–6RG·3cç&–6T6†ævU7BçFôf—†VBƒ—ÒSÂG·F†—2æÖ–å&–6T6†ævSc57GÒV°Ğ¢ĞĞ Ğ¢–b‡3RçG&FT6÷VçBÂF†—2æÖ–åG&FW3W2’&WGW&âW2G&FW2G·3RçG&FT6÷VçGÓÂG·F†—2æÖ–åG&FW3W7Ö°Ğ¢–b‡3RçföÇVÖU6öÂÂF†—2æÖ–åföÇVÖSW56öÂ’&WGW&âW2föÇVÖRG·3RçföÇVÖU6öÂçFôf—†VBƒ"—ÓÂG·F†—2æÖ–åföÇVÖSW56öÇÖ°Ğ¢–b‡3Ræ–Ö&Ææ6RÂF†—2æÖ–ä–Ö&Ææ6SW2’°Ğ¢&WGW&âW2–Ö&Ææ6RG·3Ræ–Ö&Ææ6RçFôf—†VBƒ"—ÓÂG·F†—2æÖ–ä–Ö&Ææ6SW7Ö°Ğ¢ĞĞ¢–b‡3RçVæ—VT'W–W'2ÂF†—2æÖ–åVæ—VT'W–W'3W2’°Ğ¢&WGW&âW2'W–W'2G·3RçVæ—VT'W–W'7ÓÂG·F†—2æÖ–åVæ—VT'W–W'3W7Ö°Ğ¢ĞĞ¢–b‡3Rç&–6T6†ævU7BÂF†—2æÖ–å&–6T6†ævSW57B’°Ğ¢&WGW&âW2&–6RG·3Rç&–6T6†ævU7BçFôf—†VBƒ—ÒSÂG·F†—2æÖ–å&–6T6†ævSW57GÒV°Ğ¢ĞĞ Ğ¢–b‡3RçG&FT6÷VçBÂF†—2æÖ–åG&FW3W2’&WGW&âW2G&FW2G·3RçG&FT6÷VçGÓÂG·F†—2æÖ–åG&FW3W7Ö°Ğ¢–b‡3RçföÇVÖU6öÂÂF†—2æÖ–åföÇVÖSW56öÂ’&WGW&âW2föÇVÖRG·3RçföÇVÖU6öÂçFôf—†VBƒ"—ÓÂG·F†—2æÖ–åföÇVÖSW56öÇÖ°Ğ¢–b‡3Ræ–Ö&Ææ6RÂF†—2æÖ–ä–Ö&Ææ6SW2’&WGW&âW2–Ö&Ææ6RG·3Ræ–Ö&Ææ6RçFôf—†VBƒ"—ÓÂG·F†—2æÖ–ä–Ö&Ææ6SW7Ö°Ğ¢–b‡3RçVæ—VT'W–W'2ÂF†—2æÖ–åVæ—VT'W–W'3W2’&WGW&âW2'W–W'2G·3RçVæ—VT'W–W'7ÓÂG·F†—2æÖ–åVæ—VT'W–W'3W7Ö°Ğ¢–b‡3RæÆ7E6–FRÓÒt%U’r’&WGW&âvÆ7B6–FR—2æ÷B%U’s°Ğ¢–b‡3Rç&–6T6†ævU7BÂF†—2æÖ–å&–6T6†ævSW57B’°Ğ¢&WGW&âW2&–6RG·3Rç&–6T6†ævU7BçFôf—†VBƒ—ÒSÂG·F†—2æÖ–å&–6T6†ævSW57GÒV°Ğ¢ĞĞ Ğ¢–b‡3Rç&–6T6†ævU7BâF†—2æÖ…&–6T6†ævSW57B’°Ğ¢&WGW&âW2&–6RG·3Rç&–6T6†ævU7BçFôf—†VBƒ—ÒSâG·F†—2æÖ…&–6T6†ævSW57GÒV°Ğ¢ĞĞ¢–b‡33ç&–6T6†ævU7BâF†—2æÖ…&–6T6†ævS357B’°Ğ¢&WGW&â32&–6RG·33ç&–6T6†ævU7BçFôf—†VBƒ—ÒSâG·F†—2æÖ…&–6T6†ævS357GÒV°Ğ¢ĞĞ¢–b‡3cç&–6T6†ævU7BâF†—2æÖ…&–6T6†ævSc57B’°Ğ¢&WGW&âc2&–6RG·3cç&–6T6†ævU7BçFôf—†VBƒ—ÒSâG·F†—2æÖ…&–6T6†ævSc57GÒV°Ğ¢ĞĞ¢&WGW&âçVÆÃ°Ğ¢ĞĞ Ğ¢ö6ö×7E7FG2‡7FG2’°¢&WGW&â°Ğ¢v–æF÷t×3¢7FG2çv–æF÷t×2ÀĞ¢G&FT6÷VçC¢7FG2çG&FT6÷VçBÀĞ¢'W”6÷VçC¢7FG2æ'W”6÷VçBÀĞ¢6VÆÄ6÷VçC¢7FG2ç6VÆÄ6÷VçBÀĞ¢'W•6öÃ¢&÷VæB‡7FG2æ'W•6öÂÂB’ÀĞ¢6VÆÅ6öÃ¢&÷VæB‡7FG2ç6VÆÅ6öÂÂB’ÀĞ¢æWDfÆ÷s¢&÷VæB‡7FG2ææWDfÆ÷rÂB’ÀĞ¢föÇVÖU6öÃ¢&÷VæB‡7FG2çföÇVÖU6öÂÂB’ÀĞ¢'W•6VÆÅ&F–ó¢&÷VæB‡7FG2æ'W•6VÆÅ&F–òÂ2’ÀĞ¢'W”6÷VçE&F–ó¢&÷VæB‡7FG2æ'W”6÷VçE&F–òÂ2’ÀĞ¢–Ö&Ææ6S¢&÷VæB‡7FG2æ–Ö&Ææ6RÂ2’ÀĞ¢Væ—VT'W–W'3¢7FG2çVæ—VT'W–W'2ÀĞ¢æWuVæ—VT'W–W'3¢7FG2ææWuVæ—VT'W–W'2ÀĞ¢Væ—VU6VÆÆW'3¢7FG2çVæ—VU6VÆÆW'2ÀĞ¢Væ—VUG&FW'3¢7FG2çVæ—VUG&FW'2ÀĞ¢Æ&vW7D'W–W%6†&S¢&÷VæB‡7FG2æÆ&vW7D'W–W%6†&RÂ2’ÀĞ¢Æ&vW7D'W•6†&S¢&÷VæB‡7FG2æÆ&vW7D'W•6†&RÂ2’ÀĞ¢Ö…6–ævÆT'W”–×7E7C¢&÷VæB‡7FG2æÖ…6–ævÆT'W”–×7E7BÂ2’ÀĞ¢&–6T6†ævU7C¢&÷VæB‡7FG2ç&–6T6†ævU7BÂ2’ÀĞ¢&ævU7C¢&÷VæB‡7FG2ç&ævU7BÂ2’ÀĞ¢föÆF–Æ—G•7C¢&÷VæB‡7FG2çföÆF–Æ—G•7BÂ2’ÀĞ¢Ó°¢Ğ ¢ö6ö×7E&V&÷VæEGFW&â‡GFW&â’°¢&WGW&â°¢&ÖVDC¢GFW&âæ&ÖVDBÀ¢Æ÷uG3¢GFW&âæÆ÷uG2À¢6öæf—&Ôv×3¢GFW&âæ6öæf—&Ôv×2À¢&VfW&Væ6U&–6S¢GFW&âç&VfW&Væ6U&–6RÀ¢Æ÷u&–6S¢GFW&âæÆ÷u&–6RÀ¢G&÷FWF…7C¢&÷VæB‡GFW&âæG&÷FWF…7BÂ2’À¢&V6÷fW'•7C¢&÷VæB‡GFW&âç&V6÷fW'•7BÂ2’À¢Væ—VT'W–W'33¢GFW&âçVæ—VT'W–W'32À¢Ó°¢Ğ ¢ö6ö×7EcUGFW&â‡GFW&â’°¢&WGW&â°Ğ¢&ÖVDC¢GFW&âæ&ÖVDBÀĞ¢6öæf—&Ôv×3¢GFW&âæ6öæf—&Ôv×2ÀĞ¢&Wf–÷W4æWCW3¢&÷VæB‡GFW&âç&Wf–÷W4æWCW2ÂB’ÀĞ¢7W'&VçDæWCW3¢&÷VæB‡GFW&âæ7W'&VçDæWCW2ÂB’ÀĞ¢fÆ÷t66VÆW&F–öãW3¢&÷VæB‡GFW&âæfÆ÷t66VÆW&F–öãW2ÂB’ÀĞ¢G„66VÆW&F–öãW3¢&÷VæB‡GFW&âçG„66VÆW&F–öãW2Â"’ÀĞ¢&ævSW57C¢&÷VæB‡GFW&âç&ævSW57BÂ2’ÀĞ¢&–6T6†ævS57C¢&÷VæB‡GFW&âç&–6T6†ævS57BÂ2’ÀĞ¢Ó°Ğ¢ĞĞ Ğ¢ö6ö×7EceGFW&â‡GFW&â’°Ğ¢&WGW&â°Ğ¢&ÖVDC¢GFW&âæ&ÖVDBÀĞ¢6öæf—&Ôv×3¢GFW&âæ6öæf—&Ôv×2ÀĞ¢7W÷'E66÷&S¢GFW&âç7W÷'E66÷&RÀĞ¢7W÷'D6öæF—F–öç3¢²ââçGFW&âç7W÷'D6öæF—F–öç2ÒÀĞ¢&Wf–÷W4'W•6VÆÅ&F–óW3¢&÷VæB‡GFW&âç&Wf–÷W4'W•6VÆÅ&F–óW2Â2’ÀĞ¢7W'&VçD'W•6VÆÅ&F–óW3¢&÷VæB‡GFW&âæ7W'&VçD'W•6VÆÅ&F–óW2Â2’ÀĞ¢G„66VÆW&F–öäf7F÷#W3¢&÷VæB‡GFW&âçG„66VÆW&F–öäf7F÷#W2Â2’À¢föÇVÖT66VÆW&F–öäf7F÷#W3¢&÷VæB‡GFW&âçföÇVÖT66VÆW&F–öäf7F÷#W2Â2’À¢ft'W•W%vÆÆWCW56öÃ¢&÷VæB‡GFW&âæft'W•W%vÆÆWCW56öÂÂB’À¢Ó°Ğ¢ĞĞ Ğ¢ö6ö×7DVçG'•GFW&â‡GFW&â’°Ğ¢&WGW&â°Ğ¢G&–vvW$'V6¶WEG3¢GFW&âçG&–vvW$'V6¶WEG2ÀĞ¢&Wf–÷W466VÆW&F–öã¢&÷VæB‡GFW&âç&Wf–÷W466VÆW&F–öâÂB’ÀĞ¢7W'&VçD66VÆW&F–öã¢&÷VæB‡GFW&âæ7W'&VçD66VÆW&F–öâÂB’ÀĞ¢ÆFW7D66VÆW&F–öã¢&÷VæB‡GFW&âæÆFW7D66VÆW&F–öâÂB’ÀĞ¢æWDfÆ÷w3¢GFW&âæ6æFÆW2æÖ‚†6æFÆR’Óâ&÷VæB†6æFÆRææWDfÆ÷rÂB’’ÀĞ¢Ó°Ğ¢ĞĞ Ğ¢öFV'Vu&V¦V7B†Ö–çBÂG2Â&V6öâÂ3RÂ3RÂ33Â3c’°Ğ¢–b‚F†—2æFV'Vr’&WGW&ã°Ğ¢6öç7BÆ7BÒF†—2åöÆ7DFV'VtÆörævWB†Ö–çB’ÇÂ°Ğ¢–b‡G2ÒÆ7BÂ%ó’&WGW&ã°Ğ¢F†—2åöÆ7DFV'VtÆörç6WB†Ö–çBÂG2“°Ğ¢–b‚3RÇÂ3RÇÂ33ÇÂ3c’°Ğ¢6öç6öÆRæÆör†´7F—f—G”fÆ÷uÒ6¶—G¶Ö–çBç6Æ–6RƒÂb—Ó¢G·&V6öçÖ“°Ğ¢&WGW&ã°Ğ¢ĞĞ¢6öç6öÆRæÆör€Ğ¢´7F—f—G”fÆ÷uÒ6¶—G¶Ö–çBç6Æ–6RƒÂb—Ó¢G·&V6öçÒ°Ğ¢W3ÒG·3RçG&FT6÷VçG×G‚òG·3RçföÇVÖU6öÂçFôf—†VBƒ—Õ4ôÂ#ÒG·3Ræ'W•6VÆÅ&F–òçFôf—†VBƒ"—Ò°Ğ¢W3ÒG·3RçG&FT6÷VçG×G‚òG·3RçföÇVÖU6öÂçFôf—†VBƒ—Õ4ôÂ#ÒG·3Ræ'W•6VÆÅ&F–òçFôf—†VBƒ"—Ò°Ğ¢33ÒG·33çG&FT6÷VçG×G‚òG·33çföÇVÖU6öÂçFôf—†VBƒ—Õ4ôÂ°Ğ¢c3ÒG·3cçG&FT6÷VçG×G‚òG·3cçföÇVÖU6öÂçFôf—†VBƒ—Õ4ôÆÀĞ¢“°Ğ¢ĞĞ§ĞĞ Ğ¦ÖöGVÆRæW‡÷'G2Ò÷&FW$fÆ÷uG&6¶W#°Ğ