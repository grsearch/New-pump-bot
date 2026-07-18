'use strict';

const REQUIRED_LABEL_COLUMNS = [
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

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function inspectStrategyLabQuality(db, options = {}) {
  const now = numberOrZero(options.now) || Date.now();
  const minQualityVersion = Math.max(1, Math.floor(numberOrZero(options.minQualityVersion) || 4));
  const maxJumpRatio = Math.max(1.01, numberOrZero(options.maxJumpRatio) || 2);
  const maxBacklogAgeMs = Math.max(0, numberOrZero(options.maxBacklogAgeMs) || 300_000);
  const sinceTs = numberOrZero(options.sinceTs) || 0;
  const untilTs = numberOrZero(options.untilTs) || now;
  const matureBefore = Math.min(untilTs, now - 180_000);
  const params = {
    min_quality_version: minQualityVersion,
    since_ts: sinceTs,
    until_ts: untilTs,
    mature_before: matureBefore,
    max_jump_ratio: maxJumpRatio,
  };

  const completePredicate = [
    "label_status = 'complete'",
    'COALESCE(label_quality_version, 0) >= @min_quality_version',
    ...REQUIRED_LABEL_COLUMNS.map((name) => `${name} IS NOT NULL`),
  ].join(' AND ');
  const incompletePredicate = [
    "label_status IS NULL OR label_status != 'complete'",
    'COALESCE(label_quality_version, 0) < @min_quality_version',
    ...REQUIRED_LABEL_COLUMNS.map((name) => `${name} IS NULL`),
  ].join(' OR ');

  const snapshots = db.prepare(`
    SELECT
      COUNT(*) AS matured_count,
      SUM(CASE WHEN label_updated_at IS NULL THEN 1 ELSE 0 END) AS pending_count,
      MIN(CASE WHEN label_updated_at IS NULL THEN ts END) AS oldest_pending_ts,
      SUM(CASE WHEN ${completePredicate} THEN 1 ELSE 0 END) AS complete_count,
      SUM(CASE
        WHEN label_updated_at IS NOT NULL AND (${incompletePredicate}) THEN 1
        ELSE 0
      END) AS processed_incomplete_count
    FROM token_snapshots
    WHERE ts >= @since_ts
      AND ts <= @mature_before
      AND COALESCE(data_quality_version, 1) >= @min_quality_version
      AND price > 0
      AND trusted_price_ts IS NOT NULL
      AND COALESCE(feature_quality_status, '') IN ('trusted', 'mixed_filtered', 'quiet')
  `).get({
    min_quality_version: params.min_quality_version,
    since_ts: params.since_ts,
    mature_before: params.mature_before,
  });

  const jumps = db.prepare(`
    WITH ordered AS (
      SELECT
        mint,
        ts,
        price,
        sanitizer_reason,
        LAG(price) OVER (PARTITION BY mint ORDER BY ts, id) AS previous_price
      FROM swap_events
      WHERE ts >= @since_ts
        AND ts <= @until_ts
        AND COALESCE(data_quality_version, 1) >= @min_quality_version
        AND COALESCE(feature_eligible, 0) = 1
        AND COALESCE(price_reliable, 0) = 1
        AND price > 0
    ), ratios AS (
      SELECT
        mint,
        ts,
        sanitizer_reason,
        CASE
          WHEN price >= previous_price THEN price / previous_price
          ELSE previous_price / price
        END AS jump_ratio
      FROM ordered
      WHERE previous_price > 0
    )
    SELECT
      COUNT(*) AS bad_jump_count,
      MAX(jump_ratio) AS max_bad_jump_ratio,
      COUNT(DISTINCT mint) AS bad_jump_mints
    FROM ratios
    WHERE jump_ratio > @max_jump_ratio
      AND COALESCE(sanitizer_reason, '') NOT IN (
        'market_anchor_refresh',
        'direct_jump_independently_confirmed'
      )
  `).get({
    min_quality_version: params.min_quality_version,
    since_ts: params.since_ts,
    until_ts: params.until_ts,
    max_jump_ratio: params.max_jump_ratio,
  });

  const events = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN COALESCE(feature_eligible, 0) = 1 THEN 1 ELSE 0 END) AS eligible_count,
      SUM(CASE WHEN COALESCE(feature_eligible, 0) = 0 THEN 1 ELSE 0 END) AS filtered_count,
      SUM(CASE WHEN COALESCE(feature_eligible, 0) = 1 THEN COALESCE(sol_volume, 0) ELSE 0 END)
        AS eligible_volume_sol,
      SUM(CASE WHEN COALESCE(feature_eligible, 0) = 0 THEN COALESCE(sol_volume, 0) ELSE 0 END)
        AS filtered_volume_sol
    FROM swap_events
    WHERE ts >= @since_ts
      AND ts <= @until_ts
      AND COALESCE(data_quality_version, 1) >= @min_quality_version
  `).get({
    min_quality_version: params.min_quality_version,
    since_ts: params.since_ts,
    until_ts: params.until_ts,
  });

  const contaminatedLabels = db.prepare(`
    SELECT COUNT(*) AS count
    FROM token_snapshots
    WHERE ts >= @since_ts
      AND ts <= @mature_before
      AND COALESCE(data_quality_version, 1) >= @min_quality_version
      AND label_updated_at IS NOT NULL
      AND (
        trusted_price_ts IS NULL OR
        COALESCE(feature_quality_status, '') NOT IN ('trusted', 'mixed_filtered', 'quiet')
      )
  `).get({
    min_quality_version: params.min_quality_version,
    since_ts: params.since_ts,
    mature_before: params.mature_before,
  });

  const oldestPendingTs = numberOrZero(snapshots?.oldest_pending_ts) || null;
  const pendingCount = numberOrZero(snapshots?.pending_count);
  const oldestPendingAgeMs = oldestPendingTs
    ? Math.max(0, matureBefore - oldestPendingTs)
    : 0;
  const result = {
    checkedAt: now,
    range: { sinceTs, untilTs, matureBefore },
    minQualityVersion,
    thresholds: { maxJumpRatio, maxBacklogAgeMs },
    snapshots: {
      maturedCount: numberOrZero(snapshots?.matured_count),
      completeCount: numberOrZero(snapshots?.complete_count),
      pendingCount,
      processedIncompleteCount: numberOrZero(snapshots?.processed_incomplete_count),
      oldestPendingTs,
      oldestPendingAgeMs,
    },
    prices: {
      badJumpCount: numberOrZero(jumps?.bad_jump_count),
      badJumpMints: numberOrZero(jumps?.bad_jump_mints),
      maxBadJumpRatio: numberOrZero(jumps?.max_bad_jump_ratio),
    },
    events: {
      totalCount: numberOrZero(events?.total_count),
      eligibleCount: numberOrZero(events?.eligible_count),
      filteredCount: numberOrZero(events?.filtered_count),
      eligibleVolumeSol: numberOrZero(events?.eligible_volume_sol),
      filteredVolumeSol: numberOrZero(events?.filtered_volume_sol),
    },
    contaminatedLabelCount: numberOrZero(contaminatedLabels?.count),
  };

  const failures = [];
  if (result.snapshots.maturedCount === 0) {
    failures.push('no matured Strategy Lab snapshots found in the requested range');
  }
  if (result.prices.badJumpCount > 0) {
    failures.push(
      `${result.prices.badJumpCount} unverified price jumps exceed ${maxJumpRatio}x`,
    );
  }
  if (pendingCount > 0 && oldestPendingAgeMs > maxBacklogAgeMs) {
    failures.push(
      `label backlog oldest age ${oldestPendingAgeMs}ms exceeds ${maxBacklogAgeMs}ms`,
    );
  }
  if (result.snapshots.processedIncompleteCount > 0) {
    failures.push(
      `${result.snapshots.processedIncompleteCount} processed snapshots have incomplete labels`,
    );
  }
  if (result.contaminatedLabelCount > 0) {
    failures.push(
      `${result.contaminatedLabelCount} labels were written from snapshots without a trusted feature price`,
    );
  }
  result.failures = failures;
  result.passed = failures.length === 0;
  return result;
}

function qualitySummary(result) {
  return [
    `quality=v${result.minQualityVersion}`,
    `matured=${result.snapshots.maturedCount}`,
    `complete=${result.snapshots.completeCount}`,
    `pending=${result.snapshots.pendingCount}`,
    `oldestPending=${Math.round(result.snapshots.oldestPendingAgeMs / 1000)}s`,
    `badJumps=${result.prices.badJumpCount}`,
    `eligibleEvents=${result.events.eligibleCount}`,
    `filteredEvents=${result.events.filteredCount}`,
    result.passed ? 'PASS' : `FAIL: ${result.failures.join('; ')}`,
  ].join(' ');
}

module.exports = {
  REQUIRED_LABEL_COLUMNS,
  inspectStrategyLabQuality,
  qualitySummary,
};
