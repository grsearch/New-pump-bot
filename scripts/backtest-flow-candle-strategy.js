'use strict';

require('dotenv').config({ override: true });

const { config } = require('../src/config');
const {
  evaluateFlowAccelerationEntry,
  evaluateFlowTurnExit,
} = require('../src/core/FlowCandleStrategy');

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function windowActivity(events, index, windowMs) {
  const now = events[index].ts;
  let tradeCount = 0;
  let volumeSol = 0;
  for (let i = index; i >= 0; i--) {
    if (now - events[i].ts > windowMs) break;
    tradeCount++;
    volumeSol += Number(events[i].solVolume) || 0;
  }
  return { tradeCount, volumeSol };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function runBacktest(byMint, options) {
  const trades = [];
  let openPositions = 0;

  for (const events of byMint.values()) {
    let position = null;
    let cooldownUntil = 0;
    let lastEntryBucket = null;

    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (!Number.isFinite(event.price) || event.price <= 0) continue;

      if (position) {
        position.highWaterMark = Math.max(position.highWaterMark, event.price);
        const grossPnlPct = ((event.price - position.entryPrice) / position.entryPrice) * 100;
        let reason = null;

        const flowExit = evaluateFlowTurnExit(events, event.ts, { sinceTs: position.entryTs });
        if (
          flowExit.matched &&
          flowExit.triggerBucketTs !== position.lastExitSignalBucket
        ) {
          position.lastExitSignalBucket = flowExit.triggerBucketTs;
          reason = 'FLOW_TURN_15S';
        } else if (options.takeProfitPct > 0 && grossPnlPct >= options.takeProfitPct) {
          reason = 'TAKE_PROFIT';
        } else if (options.stopLossPct < 0 && grossPnlPct <= options.stopLossPct) {
          reason = 'FIXED_STOP_LOSS';
        } else {
          const peakPnlPct = ((position.highWaterMark - position.entryPrice) / position.entryPrice) * 100;
          if (peakPnlPct >= options.trailingActivatePct) position.trailingArmed = true;
          if (position.trailingArmed && options.trailingDrawdownPct > 0) {
            const drawdownPct = ((position.highWaterMark - event.price) / position.highWaterMark) * 100;
            if (drawdownPct >= options.trailingDrawdownPct) reason = 'TRAILING_STOP';
          }
        }

        if (!reason && options.maxHoldMs > 0 && event.ts - position.entryTs >= options.maxHoldMs) {
          reason = 'TIMEOUT';
        }
        if (!reason) continue;

        trades.push({
          mint: event.mint,
          entryTs: position.entryTs,
          exitTs: event.ts,
          holdSec: (event.ts - position.entryTs) / 1000,
          grossPnlPct,
          netPnlPct: grossPnlPct - options.roundTripCostPct,
          reason,
        });
        cooldownUntil = event.ts + options.cooldownMs;
        position = null;
        continue;
      }

      if (event.ts < cooldownUntil) continue;
      const pattern = evaluateFlowAccelerationEntry(events, event.ts, { sinceTs: events[0].ts });
      if (!pattern.matched || pattern.triggerBucketTs === lastEntryBucket) continue;
      lastEntryBucket = pattern.triggerBucketTs;

      const activity = windowActivity(events, index, 60_000);
      if (activity.tradeCount < options.minTrades1m) continue;
      if (activity.volumeSol < options.minVolume1mSol) continue;
      if (
        options.minPoolQuoteSol > 0 &&
        (!event.poolQuoteAfter || event.poolQuoteAfter < options.minPoolQuoteSol)
      ) {
        continue;
      }

      position = {
        entryTs: event.ts,
        entryPrice: event.price,
        highWaterMark: event.price,
        trailingArmed: false,
        lastExitSignalBucket: null,
      };
    }

    if (position) openPositions++;
  }

  return { trades, openPositions };
}

function main() {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (error) {
    console.error(`better-sqlite3 is required. Install project dependencies first. (${error.message})`);
    process.exit(1);
  }

  let db;
  try {
    db = new Database(config.storage.dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    console.log(`No strategy database is available at ${config.storage.dbPath}.`);
    return;
  }

  const sinceMs = numberEnv('BT_SINCE_MS', Date.now() - 7 * 24 * 60 * 60 * 1000);
  const untilMs = numberEnv('BT_UNTIL_MS', Date.now());
  let rows;
  try {
    rows = db.prepare(`
      SELECT mint, symbol, signer, side, sol_volume AS solVolume, price,
             ts, slot, signature, pool_quote_after AS poolQuoteAfter
      FROM swap_events
      WHERE ts >= ? AND ts < ?
        AND COALESCE(feature_eligible, 0) = 1
      ORDER BY mint, ts, id
    `).all(sinceMs, untilMs).map((row) => ({
      ...row,
      side: String(row.side || '').toUpperCase(),
    }));
  } catch (error) {
    if (String(error.message).includes('no such table')) {
      console.log('No swap_events table exists yet. Run the service to collect market trades first.');
      return;
    }
    throw error;
  } finally {
    db.close();
  }

  if (rows.length === 0) {
    console.log('No research-eligible swap events are available in the selected period.');
    return;
  }

  const byMint = new Map();
  for (const row of rows) {
    if (!byMint.has(row.mint)) byMint.set(row.mint, []);
    byMint.get(row.mint).push(row);
  }

  const options = {
    minVolume1mSol: numberEnv('BT_MIN_VOLUME_1M_SOL', config.activityFlow.minVolume1mSol),
    minTrades1m: numberEnv('BT_MIN_TRADES_1M', config.activityFlow.minTrades1m),
    minPoolQuoteSol: numberEnv('BT_MIN_POOL_QUOTE_SOL', config.activityFlow.minPoolQuoteSol),
    takeProfitPct: numberEnv('BT_TAKE_PROFIT_PCT', config.strategy.takeProfitPct),
    trailingActivatePct: numberEnv('BT_TRAILING_ACTIVATE_PCT', config.strategy.trailingActivatePct),
    trailingDrawdownPct: numberEnv('BT_TRAILING_DRAWDOWN_PCT', config.strategy.trailingDrawdownPct),
    stopLossPct: numberEnv('BT_STOP_LOSS_PCT', config.strategy.fixedStopLossPct),
    maxHoldMs: numberEnv('BT_MAX_HOLD_MS', config.strategy.maxHoldMs),
    cooldownMs: numberEnv('BT_COOLDOWN_MS', config.strategy.rebuyCooldownMs),
    roundTripCostPct: numberEnv('BT_ROUND_TRIP_COST_PCT', 2),
  };
  const result = runBacktest(byMint, options);
  const netReturns = result.trades.map((trade) => trade.netPnlPct);
  const wins = netReturns.filter((value) => value > 0).length;
  const reasons = {};
  for (const trade of result.trades) reasons[trade.reason] = (reasons[trade.reason] || 0) + 1;

  console.log(`Loaded ${rows.length} swaps across ${byMint.size} tokens.`);
  console.log(
    `Entry: 1m>=${options.minVolume1mSol.toFixed(2)}SOL/${options.minTrades1m} trades, ` +
    '3 increasing 15s net-flow values, flow acceleration negative to positive.',
  );
  console.log('Exit: 2 closed 15s net-flow values turning positive to negative, plus TP/trailing/SL.');
  console.log(`Assumed round-trip execution cost: ${options.roundTripCostPct.toFixed(2)}%.`);
  console.table({
    closedTrades: result.trades.length,
    openPositions: result.openPositions,
    winRate: result.trades.length ? `${((wins / result.trades.length) * 100).toFixed(1)}%` : 'n/a',
    averageNetPct: result.trades.length
      ? (netReturns.reduce((sum, value) => sum + value, 0) / result.trades.length).toFixed(2)
      : 'n/a',
    medianNetPct: result.trades.length ? percentile(netReturns, 0.5).toFixed(2) : 'n/a',
    totalNetPct: netReturns.reduce((sum, value) => sum + value, 0).toFixed(2),
    exits: JSON.stringify(reasons),
  });
}

main();
