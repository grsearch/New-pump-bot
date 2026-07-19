'use strict';

const DEFAULT_FRAME_MS = 15_000;

function sumVolume(events, side) {
  return events.reduce((total, event) => {
    if (event.side !== side) return total;
    const volume = Number(event.solVolume);
    return total + (Number.isFinite(volume) && volume > 0 ? volume : 0);
  }, 0);
}

function uniqueWalletCount(events, side) {
  return new Set(
    events
      .filter((event) => event.side === side && event.signer)
      .map((event) => event.signer),
  ).size;
}

function buildClosedCandles(events, now, count, options = {}) {
  const frameMs = Number(options.frameMs) || DEFAULT_FRAME_MS;
  const closedBefore = Math.floor(now / frameMs) * frameMs;
  const firstBucketTs = closedBefore - count * frameMs;
  const sinceTs = Number(options.sinceTs);
  if (Number.isFinite(sinceTs)) {
    const firstFullBucketTs = Math.ceil(sinceTs / frameMs) * frameMs;
    if (firstBucketTs < firstFullBucketTs) return [];
  }

  const buckets = new Map();
  for (const event of events || []) {
    const ts = Number(event.ts);
    const price = Number(event.price);
    if (!Number.isFinite(ts) || ts < firstBucketTs || ts >= closedBefore) continue;
    if (!Number.isFinite(price) || price <= 0) continue;
    const bucketTs = Math.floor(ts / frameMs) * frameMs;
    if (bucketTs < firstBucketTs || bucketTs >= closedBefore) continue;
    if (!buckets.has(bucketTs)) buckets.set(bucketTs, []);
    buckets.get(bucketTs).push(event);
  }

  const candles = [];
  for (let index = 0; index < count; index++) {
    const bucketTs = firstBucketTs + index * frameMs;
    const rows = (buckets.get(bucketTs) || [])
      .slice()
      .sort((a, b) => (a.ts - b.ts) || ((a.slot || 0) - (b.slot || 0)));
    if (rows.length === 0) return [];

    const prices = rows.map((row) => Number(row.price));
    const buySol = sumVolume(rows, 'BUY');
    const sellSol = sumVolume(rows, 'SELL');
    const open = prices[0];
    const close = prices[prices.length - 1];
    candles.push({
      bucketTs,
      open,
      high: Math.max(...prices),
      low: Math.min(...prices),
      close,
      buySol,
      sellSol,
      netFlow: buySol - sellSol,
      uniqueBuyers: uniqueWalletCount(rows, 'BUY'),
      uniqueSellers: uniqueWalletCount(rows, 'SELL'),
      tradeCount: rows.length,
      priceChangePct: open > 0 ? ((close - open) / open) * 100 : 0,
    });
  }
  return candles;
}

function evaluateFlowAccelerationEntry(events, now, options = {}) {
  const candles = buildClosedCandles(events, now, 4, options);
  if (candles.length !== 4) {
    return { matched: false, reason: 'need 4 complete contiguous 15s flow windows', candles };
  }

  const previousAcceleration = candles[1].netFlow - candles[0].netFlow;
  const currentAcceleration = candles[2].netFlow - candles[1].netFlow;
  const latestAcceleration = candles[3].netFlow - candles[2].netFlow;
  const netFlowIncreasing = (
    candles[1].netFlow < candles[2].netFlow &&
    candles[2].netFlow < candles[3].netFlow
  );
  const accelerationTurnedPositive = (
    previousAcceleration < 0 &&
    currentAcceleration > 0 &&
    latestAcceleration > 0
  );

  return {
    matched: netFlowIncreasing && accelerationTurnedPositive,
    reason: !netFlowIncreasing
      ? 'last 3 complete 15s net-flow values are not strictly increasing'
      : !accelerationTurnedPositive
        ? '15s net-flow acceleration did not turn negative to positive'
        : null,
    candles,
    previousAcceleration,
    currentAcceleration,
    latestAcceleration,
    triggerBucketTs: candles[3].bucketTs,
  };
}

function evaluateFlowTurnExit(events, now, options = {}) {
  const candles = buildClosedCandles(events, now, 2, options);
  if (candles.length !== 2) {
    return { matched: false, reason: 'need 2 complete contiguous 15s candles', candles };
  }

  const [previous, current] = candles;
  const flowTurnedNegative = previous.netFlow > 0 && current.netFlow < 0;
  const requireSellerBreadth = options.requireSellerBreadth !== false;
  const sellerBreadthConfirmed = current.uniqueSellers >= current.uniqueBuyers;

  return {
    matched: flowTurnedNegative && (!requireSellerBreadth || sellerBreadthConfirmed),
    reason: !flowTurnedNegative
      ? '15s net flow did not turn positive to negative'
      : requireSellerBreadth && !sellerBreadthConfirmed
        ? '15s seller wallet breadth is below buyer wallet breadth'
        : null,
    candles,
    previousNetFlow: previous.netFlow,
    currentNetFlow: current.netFlow,
    currentUniqueBuyers: current.uniqueBuyers,
    currentUniqueSellers: current.uniqueSellers,
    sellerBreadthConfirmed,
    triggerBucketTs: current.bucketTs,
  };
}

module.exports = {
  DEFAULT_FRAME_MS,
  buildClosedCandles,
  evaluateFlowAccelerationEntry,
  evaluateFlowTurnExit,
};
