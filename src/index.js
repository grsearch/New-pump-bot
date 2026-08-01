'use strict';

const crypto = require('crypto');
const { config, validateConfig } = require('./config');
const TokenRegistry = require('./data/TokenRegistry');
const TradeLogger = require('./data/TradeLogger');
const TickStream = require('./core/TickStream');
const DumpDetector = require('./core/DumpDetector');
const PriceTracker = require('./core/PriceTracker');
const SignalEngine = require('./core/SignalEngine');
const Executor = require('./core/Executor');
const PositionManager = require('./core/PositionManager');
const PostExitTracker = require('./core/PostExitTracker');
const DailyReport = require('./reports/DailyReport');
const Server = require('./server/server');
const PoolFinder = require('./utils/poolFinder');
const { getMonitor } = require('./monitor/HealthMonitor');
const AlertChecker = require('./monitor/AlertChecker');
const TokenWatchdog = require('./core/TokenWatchdog');
const CompetitorTracker = require('./core/CompetitorTracker');
const CompetitorForensics = require('./core/CompetitorForensics');
const { resolveCompetitorWallets } = require('./utils/competitorWallets');
const ActivityFlowTracker = require('./core/OrderFlowTracker');
const PumpGraduationDiscovery = require('./core/PumpGraduationDiscovery');
const FeatureRecorder = require('./core/FeatureRecorder');
const { fetchTokenMarketsFromDexScreener } = require('./utils/tokenMeta');

const monitor = getMonitor();
const INVALID_VAULT_ADDRESSES = new Set([
  '11111111111111111111111111111111',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

function needsPoolRepair(token) {
  return !token.pool_address ||
    !token.pool_base_vault ||
    !token.pool_quote_vault ||
    token.pool_base_vault === token.pool_quote_vault ||
    INVALID_VAULT_ADDRESSES.has(token.pool_base_vault) ||
    INVALID_VAULT_ADDRESSES.has(token.pool_quote_vault);
}

async function main() {
  const watchdogCheckIntervalMs = parseInt(process.env.WATCHDOG_CHECK_INTERVAL_MS || '60000', 10);
  const watchdogFdvRange = config.strategy.maxFdVUsd > 0
    ? `$${config.strategy.minFdVUsd}-$${config.strategy.maxFdVUsd}`
    : `>=$${config.strategy.minFdVUsd}`;
  console.log('================================================');
  console.log('🎯 Dump Sniper V3.17.20 starting...');
  console.log(`Mode: ${config.DRY_RUN ? 'DRY_RUN' : '⚠️  LIVE TRADING ⚠️'}`);
  console.log(`Position: ${config.strategy.positionSizeSol} SOL`);
  console.log(`Fixed TP: ${config.strategy.takeProfitPct > 0 ? `+${config.strategy.takeProfitPct}%` : 'disabled'}`);
  console.log(`Trailing: arm at +${config.strategy.trailingActivatePct}% / drawdown ${config.strategy.trailingDrawdownPct}%`);
  console.log('RSI exit: disabled');
  if (config.activityFlow.entryMode === 'DUMP_BACKRUN_V9') {
    console.log(
      `Entry: ${config.activityFlow.entryMode} ` +
        `(sell>=${config.strategy.minSellSol}SOL, ` +
        `${config.strategy.allowAggregatedDumpSignals ? 'single+aggregated' : 'single-sell-only'}, ` +
        `impact=${config.strategy.minPriceImpactPct}%-<${config.strategy.maxPriceImpactPct}%, ` +
        `pool=${config.strategy.minPoolQuoteSol}-<${config.strategy.maxPoolQuoteSol}SOL, ` +
        `age<=${config.strategy.dumpBackrunMaxSignalAgeMs}ms, ` +
        `fast=${config.strategy.dumpBackrunStreamFastBuyEnabled
          ? `direct<=${config.strategy.dumpBackrunFastBuyMaxSignalAgeMs}ms/` +
            `gap<=${config.strategy.dumpBackrunFastBuyMaxSlotGap}/` +
            `meta<=${config.strategy.dumpBackrunFastBuyMaxMetadataAgeMs}ms`
          : 'disabled'}, ` +
        `${config.strategy.dumpBackrunBlockMintAfterTimeout ? 'first-timeout-blocks-mint' : 'timeout-reentry-enabled'}, ` +
        `no rebound confirmation)`,
    );
  } else if (config.activityFlow.entryMode === 'OLD_COIN_PULLBACK_V10') {
    console.log(
      `Entry: ${config.activityFlow.entryMode} ` +
        `(AGE>=${config.strategy.minMintAgeHours}h, ` +
        `FDV=$${Math.round(config.strategy.minFdVUsd)}-$${Math.round(config.strategy.maxFdVUsd)}, ` +
        `LP>=$${Math.round(config.strategy.minLiquidityUsd)}, ` +
        `drop=${config.activityFlow.oldCoinMinDropPct}-${config.activityFlow.oldCoinMaxDropPct}%/` +
        `${config.activityFlow.oldCoinWindowMs}ms, ` +
        `recovery=${config.activityFlow.oldCoinMinRecoveryPct}-${config.activityFlow.oldCoinMaxRecoveryPct}%, ` +
        `signal<=${config.activityFlow.maxSignalAgeMs}ms)`,
    );
  } else if (config.activityFlow.entryMode === 'ONE_SECOND_REBOUND_V8') {
    console.log(
      `Entry: ${config.activityFlow.entryMode} ` +
        `(drop=${config.activityFlow.reboundMinDropPct}%-<${config.activityFlow.reboundMaxDropPct}%/` +
        `${config.activityFlow.reboundWindowMs}ms, ` +
        `confirm=${config.activityFlow.reboundConfirmMinGapMs}-${config.activityFlow.reboundConfirmMaxGapMs}ms, ` +
        `recovery=${config.activityFlow.reboundMinRecoveryPct}-${config.activityFlow.reboundMaxRecoveryPct}%, ` +
        `buyers1>=${config.activityFlow.reboundMinUniqueBuyers1s})`,
    );
  } else {
    console.log(
      `Entry: ${config.activityFlow.entryMode} ` +
        `(one-shot at AGE=${config.activityFlow.age3EntryTargetMs / 1000}s` +
        `+${config.activityFlow.age3EntryToleranceMs / 1000}s tolerance, ` +
        `FDV>=$${Math.round(config.activityFlow.age3MinFdvUsd)}, ` +
        `buyers60>=${config.activityFlow.age3MinUniqueBuyers1m})`,
    );
  }
  console.log(config.strategy.flowReversalExitEnabled
    ? `Flow exit: ${config.strategy.flowReversalExitMode} ` +
      `(2 closed 15s net-flow values, + to -` +
      `${config.strategy.flowReversalExitRequireSellerBreadth ? ', sellers>=buyers' : ''})`
    : 'Flow exit: disabled');
  console.log(
    `Native dumpSignal: ${config.activityFlow.enabled
      ? (config.activityFlow.replaceDumpSignal ? 'telemetry only' : 'live entry enabled')
      : 'disabled by activity-flow kill switch'}`,
  );
  console.log(`Rebuy cooldown: ${config.strategy.rebuyCooldownMs > 0 ? config.strategy.rebuyCooldownMs / 60_000 + 'min after close' : 'disabled'}`);
  console.log(
    `Watchdog: FDV=${watchdogFdvRange}, liquidity>=$${config.strategy.minLiquidityUsd}, ` +
      `tokenAge=>=${config.strategy.minMintAgeHours}h/no maximum ` +
      `(check every ${watchdogCheckIntervalMs / 60_000}min)`,
  );
  console.log(`Fixed stop loss: ${config.strategy.fixedStopLossPct < 0 ? config.strategy.fixedStopLossPct + '%' : 'disabled'}`);
  console.log(`Exit mode: ${config.strategy.exitMode}`);
  console.log(
    `FDV exit: ${config.strategy.positionFdvExitUsd > 0
      ? `<$${Math.round(config.strategy.positionFdvExitUsd)} (sell then remove)`
      : 'disabled'}`,
  );
  console.log(`Emergency stop: ${config.strategy.emergencyStopLossPct < 0 ? config.strategy.emergencyStopLossPct + '%' : 'disabled'}`);
  console.log(`No-bounce exit: ${config.strategy.noBounceExitEnabled ? config.strategy.noBounceExitMs / 1000 + 's' : 'disabled'}`);
  if (config.strategy.exitMode === 'OLD_COIN_PULLBACK_V10') {
    console.log(
      `Old-coin safety exit: LP ${config.strategy.oldCoinLpExitWindowMs / 1000}s ` +
      `drop>=${config.strategy.oldCoinLpExitDropPct}%`,
    );
  }
  if (config.strategy.exitMode === 'DUMP_BACKRUN_V9') {
    console.log(
      `V9 risk policy: entryAge=${config.strategy.dumpBackrunMaxEntryAgeMs > 0
        ? `<=${config.strategy.dumpBackrunMaxEntryAgeMs / 60_000}min`
        : 'unlimited'}, ` +
        `rugPnl<=${config.strategy.dumpBackrunRugExitMaxPnlPct}%, ` +
        `noBounce=${config.strategy.dumpBackrunNoBounceAgeMs / 1000}s/` +
        `MFE<${config.strategy.dumpBackrunNoBounceMaxMfePct}%/` +
        `PnL<=${config.strategy.dumpBackrunNoBounceMaxPnlPct}%`,
    );
    console.log(
      `Sell slippage: normal=${(config.strategy.sellSlippageBps / 100).toFixed(1)}%, ` +
        `risk=${(config.strategy.emergencySellSlippageBps / 100).toFixed(1)}%`,
    );
  }
  console.log(`Max hold: ${config.strategy.maxHoldMs > 0 ? config.strategy.maxHoldMs / 1000 + 's' : 'disabled'}`);
  console.log(
    `Buy execution: buy_exact_quote_in, fixed SOL, virtual-reserve-aware, ` +
      `signal<=+${config.strategy.buyMaxPriceDeviationPct}%, forced pool refresh`,
  );
  console.log('Add-on: disabled');
  console.log(`Executor: Pump AMM SDK direct (no Jupiter)`);
  console.log(`Pump graduation discovery: ${config.pumpDiscovery.enabled ? 'enabled' : 'disabled'}`);
  console.log(
    `ShredStream token auto-add: ${config.pumpDiscovery.shredstreamAutoAddEnabled ? 'enabled' : 'disabled'}`,
  );
  console.log('Token source policy: webhook/manual only');
  console.log('================================================');

  const errors = validateConfig();
  if (errors.length) {
    console.error('Config errors:');
    errors.forEach((e) => console.error('  - ' + e));
    if (errors.some((e) => e.includes('LaserStream') || e.includes('HELIUS_API_KEY'))) {
      console.error('Critical config missing. Exiting.');
      process.exit(1);
    }
  }

  // ============ 数据层 ============
  const tokenRegistry = new TokenRegistry();
  const tradeLogger = new TradeLogger(tokenRegistry.db);

  // ============ 核心引擎 ============
  const priceTracker = new PriceTracker();
  const dumpDetector = new DumpDetector(tokenRegistry);
  const executor = new Executor();

  // v3.5: PoolStateCache - 后台预热所有监控代币的 Pump pool state
  // BUY 路径不再阻塞 swapSolanaState（80-150ms RPC），从内存读 0ms
  // v3.15: 用 executor.cacheSdk（独立实例，走普通 RPC），不占用 stakedRpc 通道
  if (!config.DRY_RUN && executor.cacheSdk && executor.keypair) {
    const PoolStateCache = require('./core/PoolStateCache');
    const poolStateCache = new PoolStateCache({
      onlineSdk: executor.cacheSdk,  // v3.15: 用 cacheSdk 而不是 onlineSdk
      user: executor.keypair.publicKey,
      getMintList: () => {
        return tokenRegistry.listActive()
          .filter((t) => t.pool_address)
          .map((t) => ({ mint: t.mint, poolAddress: t.pool_address }));
      },
    });
    executor.setPoolStateCache(poolStateCache);
    dumpDetector.setPoolStateCache(poolStateCache);
    poolStateCache.start();
  }

  // v3.17.31: 平仓后 5 分钟价格追踪(旁路,不影响主路径)
  const postExitTracker = new PostExitTracker(priceTracker, tradeLogger, {
    windowMs: parseInt(process.env.POST_EXIT_WINDOW_MS || '300000', 10),
  });
  setInterval(() => {
    const stats = postExitTracker.getStats();
    monitor.set('PostExitTracker.activeTracking', stats.activeTracking, 'PostExitTracker');
    monitor.set('PostExitTracker.activeMints', stats.activeMints, 'PostExitTracker');
  }, 30_000);

  const positionManager = new PositionManager({
    tradeLogger,
    executor,
    priceTracker,
    tokenRegistry,
    postExitTracker,
  });
  // v3.17.7: tickStream 必须先于 signalEngine 创建（signalEngine 需要它的 latestSlot getter）
  const competitorWallets = resolveCompetitorWallets(process.env.COMPETITOR_WALLETS);
  const tickStream = new TickStream({ competitorWallets });
  // Keep latest slot available for buy metadata and downstream execution.
  positionManager.tickStream = tickStream;
  // v3.17.12: DumpDetector 查询 sig 的首次来源（SS vs LS）
  dumpDetector._tickStream = tickStream;

  const competitorWatchlistAdds = new Map();
  const addCompetitorBuyToWatchlist = async (mint, event = {}) => {
    const existing = tokenRegistry.getToken(mint);
    if (existing && Number(existing.is_active) === 1) return existing;
    tickStream.addCompetitorMint(mint);
    const pending = competitorWatchlistAdds.get(mint);
    if (pending) return pending;

    const task = (async () => {
      const markets = await fetchTokenMarketsFromDexScreener([{ mint }]);
      const market = markets.get(mint);
      if (!market) {
        const err = new Error('DEX Screener returned no Solana market');
        err.code = 'COMPETITOR_MARKET_MISSING';
        throw err;
      }
      const pairCreatedAt = Number(market.pairCreatedAt) || null;
      const token = await tokenRegistry.addToken(mint, {
        source: 'competitor_buy',
        symbol: market.symbol || null,
        meta: { ...market, decimals: 6 },
        poolAddress: market.pairAddress || null,
        creationTime: pairCreatedAt,
        migrationTime: pairCreatedAt,
        migrationTimeSource: pairCreatedAt ? 'dexscreener_pairCreatedAt' : null,
        fetchCreationTime: !pairCreatedAt,
      });
      await tickStream.updateSubscription(tokenRegistry.listActive().map((row) => row.mint));
      if (!token?.pool_base_vault || !token?.pool_quote_vault) {
        fillPoolForToken(tokenRegistry, mint).catch((err) => {
          console.warn(`[competitor-watchlist] pool fill failed ${mint.slice(0, 8)}: ${err.message}`);
        });
      }
      console.log(
        `[competitor-watchlist] ADD ${token?.symbol || mint.slice(0, 8)} ` +
        `wallet=${event.wallet || 'unknown'} age>=${config.strategy.minMintAgeHours}h`,
      );
      monitor.inc('CompetitorForensics.watchlistAdded', 1, 'CompetitorForensics');
      return token;
    })().catch((err) => {
      const expected = ['TOKEN_TOO_YOUNG', 'TOKEN_AGE_UNKNOWN'].includes(err.code);
      const log = expected ? console.log : console.warn;
      log(`[competitor-watchlist] SKIP ${mint.slice(0, 8)}: ${err.message}`);
      monitor.inc(
        expected
          ? 'CompetitorForensics.watchlistAgeRejected'
          : 'CompetitorForensics.watchlistAddFailed',
        1,
        'CompetitorForensics',
      );
      return null;
    }).finally(() => {
      if (competitorWatchlistAdds.get(mint) === task) competitorWatchlistAdds.delete(mint);
    });
    competitorWatchlistAdds.set(mint, task);
    return task;
  };
  // v3.17.17: SS pre-warm 需要 tokenRegistry 做 base_vault → mint 反查
  tickStream.setTokenRegistry(tokenRegistry);

  // RsiCalculator remains for price-history helpers; RSI buy/sell filters are disabled.
  const RsiCalculator = require('./core/RsiCalculator');
  const rsiCalculator = new RsiCalculator({
    period60: config.activityFlow.rsi1mPeriod,
    priceScaleResetRatio: config.activityFlow.rsiPriceScaleResetRatio,
  });
  if (rsiCalculator) {
    console.log('[main] RSI filters disabled; RSI data kept for price-history helpers only');
    setInterval(() => rsiCalculator.cleanup(), 60_000);

    // Rebuild RSI from captured swaps. The lookback is a maximum, not a token-age
    // requirement: a newly migrated token uses every minute that actually exists.
    try {
      const warmupMinutes = Math.max(
        config.activityFlow.rsi1mPeriod + 1,
        config.activityFlow.rsi1mWarmupMaxMinutes,
      );
      const warmupStart = Date.now() - warmupMinutes * 60_000;
      const warmupRows = tradeLogger.db.prepare(`
        SELECT mint, ts, price
        FROM swap_events
        WHERE ts > ? AND price > 0
        ORDER BY ts ASC, id ASC
      `).all(warmupStart);
      let fed = 0;
      for (const r of warmupRows) {
        rsiCalculator.feedTick(r.mint, Number(r.price), Number(r.ts));
        fed++;
      }
      console.log(
        `[main] RSI warmup: fed ${fed} swap events from up to ${warmupMinutes}min ` +
          '(new tokens use available history only)',
      );
    } catch (e) {
      console.warn('[main] RSI warmup failed:', e.message);
    }
  }

  // ============ EMA Service（EMA 砸单买入策略） ============
      // EMA watch removed

  // ============ Competitor Tracker（竞争对手钱包分析） ============
  //   v3.17.32: 移到 DailyReport 之前，以便注入 competitorTracker
  //   追踪指定钱包在我们监控代币上的买卖，配对成 round-trip 统计盈亏/胜率/持仓时长。
  //   数据复用 DumpDetector 的 swapParsed 事件，零额外 RPC、不影响 BUY 延迟。
  //   地址可在 .env COMPETITOR_WALLETS（逗号分隔）配置，并与内置地址合并。
  // Always merge built-ins with .env so an older production list cannot hide required wallets.
  const competitorForensics = new CompetitorForensics({
    db: tokenRegistry.db,
    wallets: competitorWallets,
    onMintDiscovered: addCompetitorBuyToWatchlist,
    fetchTokenContext: (
      (process.env.COMPETITOR_FORENSICS_MARKET_ENRICH ?? 'true').toLowerCase() === 'true'
    ) ? async (mint) => {
      const markets = await fetchTokenMarketsFromDexScreener([{ mint }]);
      const market = markets.get(mint);
      if (!market) throw new Error('DEX Screener returned no competitor token context');
      return {
        ...market,
        creationTime: market.pairCreatedAt
          ? Math.floor(Number(market.pairCreatedAt) / 1000)
          : null,
        creationTimeSource: market.pairCreatedAt ? 'dexscreener_pairCreatedAt' : null,
      };
    } : null,
    slotToWallClockMs: (slot) => tickStream.slotToWallClockMs(slot),
    labelIntervalMs: parseInt(process.env.COMPETITOR_LABEL_INTERVAL_MS || '10000', 10),
  });
  const competitorTracker = new CompetitorTracker({
    db: tokenRegistry.db,
    addresses: competitorWallets,
    dumpDetector,                              // 零成本进场特征（触发砸单上下文）
    poolStateCache: executor.poolStateCache || null, // 买入瞬间池子 SOL 流动性
    fetchTokenInfo: async (mint) => {          // 代币侧特征（FDV/流动性/24h量），异步不阻塞
      try {
        const markets = await fetchTokenMarketsFromDexScreener([{ mint }]);
        const market = markets.get(mint);
        return market ? {
          fdv: market.fdv,
          liquidity: market.liquidity,
          holders: null,
          volume24h: market.volume24h,
        } : null;
      } catch (_) { return null; }
    },
    enrichEntry: (process.env.COMPETITOR_ENRICH ?? 'true').toLowerCase() === 'true',
    // 跟卖默认关闭（用户选择"只记录分析"）。看完数据后设 COMPETITOR_FOLLOW_SELL=true 即启用。
    followSell: (process.env.COMPETITOR_FOLLOW_SELL ?? 'false').toLowerCase() === 'true',
    followSellMinWinRate: parseFloat(process.env.COMPETITOR_FOLLOW_SELL_MIN_WINRATE || '60'),
    followSellMinClosed: parseInt(process.env.COMPETITOR_FOLLOW_SELL_MIN_CLOSED || '10', 10),
    forensics: competitorForensics,
    onAddressesChanged: (addresses) => tickStream.updateCompetitorWallets(addresses),
  });
  const activityFlowTracker = new ActivityFlowTracker({ tokenRegistry });
  const featureRecorder = new FeatureRecorder({ tradeLogger, tokenRegistry });
  featureRecorder.start();
  const swapSanitizer = dumpDetector.swapEventSanitizer;
  console.log(
    `[main] SwapSanitizer ${swapSanitizer.enabled ? 'enabled' : 'disabled'}: ` +
      `quality=v${swapSanitizer.enabled ? swapSanitizer.dataQualityVersion : 1} ` +
      `jump<=${swapSanitizer.maxJumpRatio}x market<=${swapSanitizer.marketMaxRatio}x ` +
      `independentSources>=${swapSanitizer.confirmMinIndependentSources}`,
  );
  const activityFlowDescription = activityFlowTracker.entryMode === 'DUMP_BACKRUN_V9'
    ? `sell>=${config.strategy.minSellSol}SOL ` +
      `${config.strategy.allowAggregatedDumpSignals ? 'single+aggregated' : 'single-sell-only'} ` +
      `impact=${config.strategy.minPriceImpactPct}%-<${config.strategy.maxPriceImpactPct}% ` +
      `pool=${config.strategy.minPoolQuoteSol}-<${config.strategy.maxPoolQuoteSol}SOL ` +
      `age<=${config.strategy.dumpBackrunMaxSignalAgeMs}ms ` +
      `fast=${config.strategy.dumpBackrunStreamFastBuyEnabled
        ? `direct<=${config.strategy.dumpBackrunFastBuyMaxSignalAgeMs}ms/` +
          `gap<=${config.strategy.dumpBackrunFastBuyMaxSlotGap}/` +
          `meta<=${config.strategy.dumpBackrunFastBuyMaxMetadataAgeMs}ms`
        : 'disabled'}`
    : activityFlowTracker.entryMode === 'ONE_SECOND_REBOUND_V8'
    ? `drop=${activityFlowTracker.reboundMinDropPct}%-<${activityFlowTracker.reboundMaxDropPct}%/` +
      `${activityFlowTracker.reboundWindowMs}ms ` +
      `recovery=${activityFlowTracker.reboundMinRecoveryPct}-${activityFlowTracker.reboundMaxRecoveryPct}% ` +
      `confirm=${activityFlowTracker.reboundConfirmMinGapMs}-${activityFlowTracker.reboundConfirmMaxGapMs}ms ` +
      `buyers1>=${activityFlowTracker.reboundMinUniqueBuyers1s}`
    : `age=${activityFlowTracker.age3EntryTargetMs / 1000}s` +
      `+${activityFlowTracker.age3EntryToleranceMs / 1000}s ` +
      `fdv>=$${Math.round(activityFlowTracker.age3MinFdvUsd)} ` +
      `buyers60>=${activityFlowTracker.age3MinUniqueBuyers1m}`;
  console.log(
    `[main] ActivityFlow ${activityFlowTracker.enabled ? 'enabled' : 'disabled'}: ` +
      `mode=${activityFlowTracker.entryMode} ${activityFlowDescription} ` +
      `replaceDump=${activityFlowTracker.replaceDumpSignal}`,
  );
  console.log(
    `[main] StrategyLab ${featureRecorder.enabled ? 'enabled' : 'disabled'}: ` +
      `snapshot=${featureRecorder.snapshotIntervalMs}ms ` +
      `labels=${featureRecorder.labelEnabled ? featureRecorder.labelIntervalMs + 'ms' : 'disabled'} ` +
      `labelBatch=${featureRecorder.labelBatchSize}x${featureRecorder.labelMaxBatchesPerTick} ` +
      `allActive=${featureRecorder.snapshotAllActive}`,
  );
  dumpDetector.on("swapParsed", (swap) => {
    if (config.capture.swapEventsEnabled || config.capture.strategyLabEnabled) {
      try { tradeLogger.logSwapEvent(swap); } catch (_) { /* analytics only */ }
    }
    try { featureRecorder.handleSwap(swap); } catch (_) { /* analytics only */ }
    if (swap.featureEligible === true) {
      try { competitorTracker.handleSwap(swap); } catch (_) { /* prevent CT errors from breaking DumpDetector */ }
      try { activityFlowTracker.handleSwap(swap); } catch (err) {
        console.warn(`[ActivityFlow] handleSwap failed: ${err.message}`);
      }
      try { positionManager.handleSwapForExit(swap); } catch (err) {
        console.warn(`[FlowExit] handleSwap failed: ${err.message}`);
      }
    } else {
      monitor.inc('main.filteredSwapEvent', 1, 'main');
    }
  });

  // ============ 报告 ============
  const dailyReport = new DailyReport({ tradeLogger, tokenRegistry, competitorTracker });
  dailyReport.start();

  // 竞争对手卖出 → 可选跟卖（默认 followSell=false，仅记录分析）。
  //   优先级最高：他们一卖，我们若持有同币立即卖（早于 TP/trailing），但仅当 eligible=true
  //   （高胜率 + 足够样本的钱包）且 COMPETITOR_FOLLOW_SELL=true 时才执行。
  competitorTracker.on('competitorSell', (sig) => {
    if (!sig.eligible) return; // 关闭跟卖 或 该钱包未达胜率/样本门槛 → 只记录，不动作
    const pids = positionManager.byMint.get(sig.mint);
    if (!pids || pids.size === 0) return; // 我们没持有这个币
    console.log(
      `[main] 🔁 FOLLOW_SELL ${sig.symbol || sig.mint.slice(0, 6)}: competitor ${sig.wallet.slice(0, 6)}.. ` +
        `(winRate ${sig.walletWinRatePct.toFixed(0)}%, n=${sig.walletClosedCount}) sold → exiting our positions`,
    );
    for (const pid of pids) {
      const pos = positionManager.positions.get(pid);
      if (pos && !pos.exiting) {
        const px = positionManager.priceTracker.getPrice(sig.mint) || pos.entryPrice;
        positionManager._exitForCondition(pos, px, 'COMPETITOR_FOLLOW_SELL');
      }
    }
  });

  // ============ Signal Engine ============
  const signalEngine = new SignalEngine({
    tradeLogger,
    positionManager,
    tickStream,
    dumpDetector,
    rsiCalculator,  // v3.17.17: 可为 null,SignalEngine 内部会跳过 RSI 过滤
    poolStateCache: executor.poolStateCache || null,  // v3.17.21: 信号触发时 addHot
    tokenRegistry,  // v3.26: 新币策略 — 按 token age 区分过滤逻辑
  });
  // v3.17.41: PositionManager blacklist needs signalEngine reference
  positionManager.signalEngine = signalEngine;
  activityFlowTracker.on('flowReversalSignal', (signal) => {
    Promise.resolve(signalEngine.handleDumpSignal(signal)).catch((err) => {
      console.error(`[ActivityFlow] SignalEngine error: ${err.message}`);
    });
  });

  // ============ 服务器 ============
  const server = new Server({
    tokenRegistry,
    tradeLogger,
    positionManager,
    signalEngine,
    activityFlowTracker,
    dailyReport,
    competitorTracker,
    onTokenListChanged: () => {
      const mints = tokenRegistry.listActive().map((t) => t.mint);
      tickStream.updateSubscription(mints);
      // v2: 同步 EMA 监控列表
    },
    onTokenAdded: async (token) => {
      // 新增代币 → 后台异步补 pool 信息
      if (config.autoFillPoolsOnStart) {
        fillPoolForToken(tokenRegistry, token.mint).catch((err) => {
          console.warn(`[onTokenAdded] fillPool failed for ${token.symbol || token.mint.slice(0,8)}: ${err.message}`);
        });
      }
      // v2: 新币加入 EMA 监控
    },
  });

  const pumpDiscovery = new PumpGraduationDiscovery({
    tokenRegistry,
    onBeforeAdd: (mint) => server._evictIfNeeded(mint),
    onMigrationDetected: (migration) => {
      if (rsiCalculator) rsiCalculator.reset(migration.mint, 'pump_migration');
    },
    onTokenAdded: async ({ token, migration, screening, evicted }) => {
      const mints = tokenRegistry.listActive().map((t) => t.mint);
      tickStream.updateSubscription(mints);
      if (migration.poolAddress && executor.poolStateCache) {
        executor.poolStateCache.refreshOne(migration.poolAddress).catch(() => {});
      }
      server.broadcast({
        type: 'tokenAdded',
        token,
        discovery: {
          source: 'pump_graduation',
          migrationTime: migration.migrationTime,
          migrationTimeSource: migration.migrationTimeSource,
          migrationSlot: migration.slot,
          signature: migration.signature,
          fdv: screening.market.fdv,
          liquidity: screening.market.liquidity,
        },
        evicted,
      });
    },
  });

  // ============ 启动恢复未平仓持仓 ============
  const restored = positionManager.restoreFromDb();
  if (restored.length > 0) {
    console.log(`[main] restored ${restored.length} open position(s) from db`);
    monitor.inc('main.restoredPositions', restored.length, 'main');
  }

  // ============ Token Watchdog（监控超时 + FDV/LP 自动移除） ============
  const tokenWatchdog = new TokenWatchdog({
    tokenRegistry,
    positionManager,
    poolStateCache: executor.poolStateCache || null,
    tradeLogger: tradeLogger, // v3.17.41: 24h no-buy filter
    onTokenRemoved: () => {
      const mints = tokenRegistry.listActive().map((t) => t.mint);
      tickStream.updateSubscription(mints);
      // v2: 同步 EMA 监控列表
    },
  });
  tokenWatchdog.start();

  // Competitor stats periodic logging + cleanup (tracker created earlier, before Server)
  setInterval(() => competitorTracker.cleanupExpiredLots(), 10 * 60_000);
  setInterval(() => {
    const stats = competitorTracker.getAllStats();
    for (const s of stats) {
      if (s.buyCount === 0 && s.sellCount === 0) continue;
      console.log(
        `[CompetitorTracker] 📊 ${s.wallet.slice(0, 8)}..${s.label ? ` (${s.label})` : ''}: ` +
          `${s.closedCount} round-trips, win ${s.winRatePct.toFixed(0)}%, ` +
          `totalPnL=${s.totalPnlSol >= 0 ? '+' : ''}${s.totalPnlSol.toFixed(3)} SOL, ` +
          `avgPnL=${s.avgPnlPct.toFixed(1)}%, avgHold=${(s.avgHoldMs / 1000).toFixed(0)}s, ` +
          `openLots=${s.openLots}`,
      );
      // 进场阈值反推（对照我们自己的 MIN_SELL_SOL / MIN_PRICE_IMPACT_PCT）
      const e = competitorTracker.getEntryStats(s.wallet);
      if (e && e.n > 0) {
        const f = (x) => (x == null ? '?' : x.toFixed(1));
        console.log(
          `[CompetitorTracker] 🔬 entry(n=${e.n}): trigger sell ${f(e.triggerSellSol.min)}/${f(e.triggerSellSol.avg)}/${f(e.triggerSellSol.max)} SOL (min/avg/max), ` +
            `impact ${f(e.triggerImpactPct.min)}/${f(e.triggerImpactPct.avg)}/${f(e.triggerImpactPct.max)}%, ` +
            `poolLP avg ${f(e.poolLpSol.avg)} SOL, FDV avg $${e.fdvUsd.avg ? Math.round(e.fdvUsd.avg) : '?'}, ` +
            `holders avg ${e.avgHolders ? Math.round(e.avgHolders) : '?'}` +
            ` | our thresholds: MIN_SELL=${config.strategy.minSellSol} MIN_IMPACT=${config.strategy.minPriceImpactPct}%`,
        );
      }
    }
  }, 3600_000);

  console.log(
    config.strategy.maxTokenAgeMs > 0
      ? `[main] token AGE filter enabled: remove after ${config.strategy.maxMintAgeMinutes}min ` +
        '(open positions are retained until exit)'
      : '[main] token AGE filter disabled: monitored tokens do not expire by AGE',
  );

  // ============ 定期补缺 pool 信息（每 60 秒扫描一次） ============
  // 防止 onTokenAdded 时 PoolFinder 失败导致代币永远没有 pool
  setInterval(() => {
    const missing = tokenRegistry.listActive().filter(needsPoolRepair);
    if (missing.length === 0) return;
    console.log(`[pool-refill] ${missing.length} token(s) missing pool info, filling...`);
    for (const t of missing) {
      fillPoolForToken(tokenRegistry, t.mint).then(() => {
        const fresh = tokenRegistry.getToken(t.mint);
        if (fresh?.pool_address) {
          console.log(`[pool-refill] ${t.symbol || t.mint.slice(0,8)} pool filled`);
        }
      }).catch(() => {});
    }
  }, 60_000);

  // ============ 健康监控 / 告警 ============
  const alertChecker = new AlertChecker({
    monitor,
    tickStream,
    executor,
    positionManager,
    tokenRegistry,
    config,
  });
  alertChecker.start();

  monitor.on('alert', (alert) => {
    console.error(`[ALERT] [${alert.severity.toUpperCase()}] ${alert.name}: ${alert.message}`);
    server.broadcast({ type: 'alert', alert });
  });
  monitor.on('alertCleared', (alert) => {
    console.log(`[ALERT] cleared: ${alert.name}`);
    server.broadcast({ type: 'alertCleared', alert });
  });

  // ============ 事件连线 ============

  tickStream.on('transaction', (tx, streamMeta) => {
    dumpDetector.handleTransaction(tx, streamMeta);
    setImmediate(() => {
      try {
        competitorTracker.handleTransaction(tx, streamMeta);
      } catch (err) {
        monitor.recordError('CompetitorForensics', err, { phase: 'transactionListener' });
      }
    });
  });

  // ============ v3.17.23: VaultBalanceWatcher ============
  // 直接查链上 vault 余额变化检测砸单，不受 Jupiter 聚合路由影响
  if (!config.DRY_RUN && executor.rpc) {
    const VaultBalanceWatcher = require('./core/VaultBalanceWatcher');
    const vaultWatcher = new VaultBalanceWatcher({
      connection: executor.rpc,
      tokenRegistry,
      poolStateCache: executor.poolStateCache || null,
    });
    vaultWatcher.on('vaultSell', (info) => {
      // v3.17.23: VaultWatcher 检测到的卖单作为辅助信号
      // 不直接触发买入！VaultWatcher 的 impact 计算是基于快照间隔内的累计变化，
      // 无法区分单笔大卖单和多笔小卖单累积，导致 impact 虚高。
      // 只做 priceTick 喂价 + PoolStateCache 预热 + 日志记录
      monitor.inc('VaultWatcher.vaultSellDetected', 1, 'VaultWatcher');

      // 喂价给 PriceTracker
      if (info.priceAfter > 0) {
        priceTracker.update(info.mint, info.priceAfter, info.ts, info.poolAddress, {
          source: 'vault_watcher',
          rawPrice: info.rawPriceAfter,
          virtualQuoteReserveSol: info.virtualQuoteReserveSol,
          effectiveQuoteReserveSol: info.effectiveQuoteReserveSol,
        });
      }

      // 预热 PoolStateCache
      if (executor.poolStateCache && info.poolAddress) {
        executor.poolStateCache.refreshOne(info.poolAddress).catch(() => {});
        // 如果不在 hotMints 里，加进去（低频刷新）
        if (!executor.poolStateCache.hotMints.has(info.mint)) {
          executor.poolStateCache.addHot(info.mint, info.poolAddress, false); // isPosition=false → 信号币低频
        }
      }
    });
    vaultWatcher.start();
    vaultWatcher.setTickStream(tickStream);
    // token 变化时刷新 watch list
    tokenRegistry.on?.('changed', () => vaultWatcher.markDirty());
  }

  // ─────────────────────────────────────────────────────────────────
  // v3.17.17: SS Pre-warm 处理器
  // ─────────────────────────────────────────────────────────────────
  // ShredStream 比 LaserStream 快 50-200ms (实测 ssLeadCounters 已有数据)。
  // SS 解析出 sell instruction 后立即触发 pool state RPC refresh,
  // 等 LaserStream 推完整 tx 触发 BUY 时,Executor 读 cache 几乎一定 hit,
  // 省下 80-150ms 的 RPC 时间 → BUY 提早 1 个 slot 落链。
  //
  // 注意:
  //   - 不触发 buyOrder,只 refresh (SS 来的 tx 无 meta,不能可靠判断 sellSol/impact)
  //   - dedup 1s 内同 pool 不重复 refresh (1 个 pool 1s 内的多笔卖单变化很小)
  // ─────────────────────────────────────────────────────────────────
  const _prewarmDedup = new Map(); // poolAddress → lastRefreshTs
  const PREWARM_DEDUP_MS = parseInt(process.env.SS_PREWARM_DEDUP_MS || '1000', 10);

  tickStream.on('prewarmSignal', (signal) => {
    if (!executor.poolStateCache || !signal.poolAddress) return;
    const now = Date.now();
    const last = _prewarmDedup.get(signal.poolAddress) || 0;
    if (now - last < PREWARM_DEDUP_MS) return;
    _prewarmDedup.set(signal.poolAddress, now);

    const refreshPromise = !executor.poolStateCache.hotMints.has(signal.mint)
      ? executor.poolStateCache.addHot(signal.mint, signal.poolAddress, false)
      : executor.poolStateCache.refreshOne(signal.poolAddress);

    // 异步 refresh,不阻塞 SS loop
    Promise.resolve(refreshPromise).then(() => {
      monitor.inc('main.prewarmHit', 1, 'main');
    }).catch(() => {
      // 静默失败 (cache miss/RPC 暂时不通,后续 5s 轮询也会刷)
      monitor.inc('main.prewarmFail', 1, 'main');
    });

    if (process.env.SS_PREWARM_DEBUG === 'true') {
      console.log(
        `[main] 🔥 SS pre-warm → refresh pool ${signal.poolAddress.slice(0, 6)}.. ` +
        `(${signal.symbol || signal.mint.slice(0, 6)}, min_quote=${signal.minQuoteOutSol.toFixed(2)} SOL)`,
      );
    }
  });

  // v3.34: SS 自动发现新币 — ShredStream 收到未知 mint 的 Pump AMM 卖单时
  // 自动添加到 tokenRegistry + 更新 LS 订阅，让后续信号走实时路径
  // 阈值: 只自动添加卖单 ≥ MIN_SELL_SOL 的新币（避免添加垃圾币）
  const SS_NEW_MINT_MIN_SELL_SOL = parseFloat(
    process.env.SS_NEW_MINT_MIN_SELL_SOL ||
      String(config.strategy.minSellSol),
  );
  const _newMintDedup = new Map(); // mint → lastAddTs
  const NEW_MINT_DEDUP_MS = 60000; // 同一 mint 60s 内不重复 add
  tickStream.on('newMintDiscovered', (info) => {
    if (!config.pumpDiscovery.shredstreamAutoAddEnabled) return;
    if (!info.mint) return;
    // 只自动添加大额砸单（和小额卖单不值得监控）
    if (info.minQuoteOutSol < SS_NEW_MINT_MIN_SELL_SOL) return;
    const now = Date.now();
    const lastAdd = _newMintDedup.get(info.mint) || 0;
    if (now - lastAdd < NEW_MINT_DEDUP_MS) return;
    _newMintDedup.set(info.mint, now);

    // 如果已在 tokenRegistry 里，只更新 LS 订阅（可能没有 pool 信息）
    const existing = tokenRegistry.getToken(info.mint);
    if (existing?.pool_address) {
      // 已有完整信息，不需要重新添加
      return;
    }

    console.log(
      `[main] 🆕 SS discovered new mint: ${info.mint.slice(0, 8)}.. ` +
      `pool=${info.poolAddress?.slice(0, 6)}.. min_quote=${info.minQuoteOutSol.toFixed(2)} SOL slot=${info.slot}`,
    );

    // 立即 prewarm pool cache（不等 addToken 完成）
    // 这样 VaultWatcher 检测到 dump 时，buy 路径已经 ready
    if (info.poolAddress && executor.poolStateCache) {
      executor.poolStateCache.refreshOne(info.poolAddress).catch(() => {});
    }

    // 异步添加到 tokenRegistry
    tokenRegistry.addToken(info.mint, {
      symbol: null, // SS 没有符号信息，addToken 会从 Helius DAS 获取
      source: 'shredstream',
    }).then((token) => {
      if (token) {
        // SS 已从 sell instruction 提取了 pool 信息，直接写入
        if (info.poolAddress) {
          tokenRegistry.setPoolInfo(info.mint, {
            poolAddress: info.poolAddress,
            poolBaseVault: info.poolBaseVault,
            poolQuoteVault: info.poolQuoteVault,
          });
        }
        const freshToken = tokenRegistry.getToken(info.mint);
        console.log(
          `[main] 🆕 SS auto-added ${freshToken?.symbol || info.mint.slice(0, 8)}.. to tokenRegistry ` +
          `(pool=${freshToken?.pool_address?.slice(0, 6)}..)`,
        );
        // 更新 LS 订阅，让后续 dump 信号走实时路径
        const mints = tokenRegistry.listActive().map(t => t.mint);
        tickStream.updateSubscription(mints);
        // 通知 VaultWatcher 刷新
        vaultWatcher?.markDirty?.();
      }
    }).catch((err) => {
      console.warn(`[main] 🆕 SS auto-add failed for ${info.mint.slice(0, 8)}..: ${err.message}`);
    });
  });

  // 定期清理 prewarmDedup + newMintDedup (避免内存泄漏)
  setInterval(() => {
    const now = Date.now();
    for (const [k, ts] of _prewarmDedup) {
      if (now - ts > PREWARM_DEDUP_MS * 5) _prewarmDedup.delete(k);
    }
    for (const [k, ts] of _newMintDedup) {
      if (now - ts > NEW_MINT_DEDUP_MS * 5) _newMintDedup.delete(k);
    }
  }, 30_000);

  // v3.17.21: 事件循环延迟检测（每 60 秒采样一次）
  let _lastLoopTick = Date.now();
  setInterval(() => { _lastLoopTick = Date.now(); }, 1000);

  // v3.17.21: 内存分类监控 — 每 10 秒打印一次,定位泄漏源
  // v3.17.26: 采样间隔 60s→10s（RSS 飙升极快,60s 可能漏检）
  // v3.17.26: 空仓重启阈值 1500MB→800MB（之前 1500 太晚,Rust 泄漏到 2GB 才 OOM kill）
  // v3.17.26: 加 rss>500MB 告警
  setInterval(() => {
    const u = process.memoryUsage();
    const rssMB = Math.round(u.rss / 1e6);
    const posCount = positionManager?.positions?.size ?? 0;
    const loopLagMs = Math.max(0, Date.now() - _lastLoopTick - 1000);  // 预期 1s 内更新,超出即延迟
    console.log(
      `[MEM] rss=${rssMB}MB heap=${(u.heapUsed/1e6).toFixed(0)}MB ` +
      `ext=${(u.external/1e6).toFixed(0)}MB arrBuf=${(u.arrayBuffers/1e6).toFixed(0)}MB ` +
      `poolCache=${executor?.poolStateCache?.cache?.size ?? '?'} ` +
      `hotMints=${executor?.poolStateCache?.hotMints?.size ?? '?'} ` +
      `recentSells=${dumpDetector?._recentSells?.size ?? '?'} ` +
      `slotSells=${dumpDetector?._slotSells?.size ?? '?'} ` +
      `prices=${priceTracker?.prices?.size ?? '?'} ` +
      `suspicious=${priceTracker?.suspicious?.size ?? '?'} ` +
      `dedup=${tickStream?.dedup?.size() ?? '?'} ` +
      `queue=${tickStream?._msgQueue?.length ?? '?'} ` +
      `queueDrop=${tickStream?._queueDropped ?? '?'} ` +
      `openLots=${competitorTracker?.openLots?.size ?? '?'} ` +
      `positions=${posCount} ` +
      `loopLag=${loopLagMs}ms`
    );
    // v3.17.26→v3.27: RSS 阈值调整 — 7个gRPC连接基线~550MB, 旧阈值600MB等于启动即告警
    // 告警阈值 700MB（基线550 + 150MB余量，超过说明Rust泄漏已开始）
    if (rssMB > 700) {
      console.error(`[MEM] ⚠️  rss=${rssMB}MB > 700MB — Rust native 内存可能泄漏,监控中`);
      monitor.fireAlert('main.rss_high', 'warn', `rss=${rssMB}MB > 700MB, Rust native 内存可能泄漏`, { rssMB });
    } else {
      monitor.clearAlert('main.rss_high');
    }
    // 空仓重启阈值 800MB（基线550 + 250MB增长，约3-4小时正常泄漏量）
    // 有持仓硬上限 1000MB（避免OOM kill，重启后从DB恢复持仓）
    if (rssMB > 1000 && posCount > 0) {
      console.log(`[MEM] 🔄 rss=${rssMB}MB > 1000MB 且有 ${posCount} 个持仓,强制优雅重启（OOM 前清零,持仓会从 DB 恢复）`);
      process.exit(0);
    }
    if (rssMB > 800 && posCount === 0) {
      console.log(`[MEM] 🔄 rss=${rssMB}MB > 800MB 且空仓,优雅重启以释放 Rust 堆外内存`);
      process.exit(0);  // systemd Restart=always 会自动拉起
    }
  }, 10_000);

  dumpDetector.on('priceTick', ({
    mint,
    price,
    ts,
    poolAddress,
    side,
    solVolume,
    poolQuoteAfter,
    rawPrice,
    virtualQuoteReserveSol,
    effectiveQuoteReserveSol,
  }) => {
    priceTracker.update(mint, price, ts, poolAddress, {
      source: 'chain_swap',
      rawPrice,
      virtualQuoteReserveSol,
      effectiveQuoteReserveSol,
    });
    // v3.17.41: 采样价格到长窗口缓存 (比 handleDumpSignal 更频繁，覆盖所有 priceTick)
    signalEngine._sampleLongPrice(mint, priceTracker.getPrice(mint));
    // v3.17.17: 喂 RSI - 用 feedTrade 带上 volume,RSI 能做 volume-weighted aggregation
    if (rsiCalculator) {
      // v3.17.38-fix: poolQuoteAfter=0 时用 tokenRegistry.liquidity 推算
      //   CPI/balanceOnly 路径算不出 poolQuoteAfter → 0
      //   导致 RSI 的 lastPoolQuoteSol 永远为 null → rsi_pre_dump 不缓存
      let effectivePoolQuoteSol = effectiveQuoteReserveSol || poolQuoteAfter;
      if ((!effectivePoolQuoteSol || effectivePoolQuoteSol <= 0) && tokenRegistry) {
        const ti = tokenRegistry.getToken(mint);
        if (ti && ti.liquidity) {
          effectivePoolQuoteSol = ti.liquidity / 170; // USD → SOL
        }
      }
      if (side && solVolume > 0) {
        rsiCalculator.feedTrade(mint, price, solVolume, side.toLowerCase(), ts, effectivePoolQuoteSol);
      } else {
        rsiCalculator.feedTick(mint, price, ts);
      }

    }
  });

  // v3.17.17: 旧 sellAnalyzed → feedTrade 接线已经合并到 priceTick 路径(priceTick 包含所有 swap)
  // 不需要单独的 sellAnalyzed → RSI 监听

  // sellAnalyzed: 只记录"接近触发"的（半阈值），避免写入风暴
  dumpDetector.on('sellAnalyzed', (info) => {
    if (activityFlowTracker.enabled && activityFlowTracker.replaceDumpSignal) return;
    if (info.passSize && info.passImpact && info.passLiquidity) return; // 已 dumpSignal
    const halfSize = config.strategy.minSellSol * 0.5;
    const halfImpact = config.strategy.minPriceImpactPct * 0.5;
    if (info.sellSol < halfSize || info.priceImpactPct < halfImpact) return;
    // 构造可读的拒绝原因
    const reasons = [];
    if (!info.passSize) reasons.push(`size:${info.sellSol.toFixed(1)}<${config.strategy.minSellSol}`);
    if (!info.passImpact) {
      if (info.priceImpactPct < config.strategy.minPriceImpactPct) {
        reasons.push(`impact:${info.priceImpactPct.toFixed(1)}%<${config.strategy.minPriceImpactPct}%`);
      } else {
        reasons.push(`impact:${info.priceImpactPct.toFixed(1)}%>${config.strategy.maxPriceImpactPct}% (pool dead?)`);
      }
    }
    if (!info.passLiquidity) {
      const poolSol = info.poolQuoteAfter ?? 0;
      if (poolSol < config.strategy.minPoolQuoteSol) {
        reasons.push(`liq:${poolSol.toFixed(0)} SOL<${config.strategy.minPoolQuoteSol}`);
      } else {
        reasons.push(`liq:${poolSol.toFixed(0)} SOL>=${config.strategy.maxPoolQuoteSol}`);
      }
    }
    tradeLogger.logSignal({
      ts: info.ts,
      mint: info.mint,
      symbol: info.symbol,
      kind: 'DUMP_DETECTED',
      sellSol: info.sellSol,
      priceImpactPct: info.priceImpactPct,
      seller: info.seller,
      sellerTx: info.signature,
      notes: `near-miss: ${reasons.join(', ')}`,
      accepted: false,
      rejectReason: reasons.join('; '),
    });
  });

  dumpDetector.on('dumpSignal', (signal) => {
    // SignalEngine adds accepted V9 pools to the rolling hot set before it
    // emits buyOrder. The current BUY still uses this transaction's exact
    // post-balances; the background refresh prepares later signals.
    activityFlowTracker.noteDumpSignal(signal);
    if (!activityFlowTracker.enabled && activityFlowTracker.entryMode === 'DUMP_BACKRUN_V9') {
      activityFlowTracker.noteSuppressedDumpSignal(signal);
      return;
    }
    if (activityFlowTracker.enabled && activityFlowTracker.replaceDumpSignal) {
      activityFlowTracker.noteSuppressedDumpSignal(signal);
      return;
    }
    if (activityFlowTracker.entryMode === 'DUMP_BACKRUN_V9') {
      signal._dumpBackrunEntry = true;
    }
    Promise.resolve(signalEngine.handleDumpSignal(signal)).catch((err) => {
      console.error(`[DumpBackrun] SignalEngine error: ${err.message}`);
    });
  });

  // V9 only exits on a rug cluster after the position has already crossed
  // the configured loss threshold. Profitable clusters remain under the
  // normal trailing and timeout policy.
  dumpDetector.on('rugSignal', (rug) => {
    positionManager.handleDumpBackrunRugSignal(rug);
  });

  // ============ buyOrder → BUY → register position ============
  signalEngine.on('buyOrder', async (order) => {
    console.log(`[main] buyOrder received: ${order.symbol || order.mint.slice(0,6)} mint=${order.mint.slice(0,8)}.. reason=${order.reason} sig=${order.signature?.slice(0,12)}..`);
    if (order._dumpBackrunEntry) {
      activityFlowTracker.noteDumpAccepted(order.mint, Date.now());
    }
    const _t0 = Date.now();
    const tokenInfo = tokenRegistry.getToken(order.mint);
    const _t1 = Date.now();

    // 用同一个 positionId 贯穿 BUY trade / position 表
    const positionId = crypto.randomUUID();

    // 标记此 mint 正在 buy 中，让后续并发 dumpSignal 看到这个槽位被占
    signalEngine.markBuyInflight(order.mint);

    // Record the current chain slot on BUY for execution metadata.
    const latestStreamSlotAtOrder = Number(tickStream.latestSlot || 0);
    executor.setLatestSlot(latestStreamSlotAtOrder);

    const _t2 = Date.now();
    let buyResult;
    try {
      buyResult = await executor.buy({
        mint: order.mint,
        symbol: order.symbol,
        sizeSol: order.sizeSol,
        priceAfter: order.priceAfter, // 用于 DRY_RUN 模拟
        priceBefore: order.priceBefore,
        baseDecimals: order.baseDecimals ?? tokenInfo?.decimals ?? 6,
        poolAddress: tokenInfo?.pool_address, // Pump SDK 需要 pool address
        signalSlot: order.slot,
        signalTransactionIndex: order.transactionIndex,
        signalTs: order.ts,
        signalReceivedAt: order._signalReceivedAt,
        latestStreamSlotAtSignal: order._latestStreamSlotAtSignal,
        slotGapAtSignal: order._slotGapAtSignal,
        latestStreamSlotAtOrder,
        getLatestStreamSlot: () => Number(tickStream.latestSlot || 0),
        sellerTx: order.signature,
        poolQuoteAfterSignal: order.poolQuoteAfter,
        signalPoolBaseAmountUi: order.signalPoolBaseAmountUi,
        signalRawPoolQuoteSol: order.signalRawPoolQuoteSol,
        signalVirtualQuoteReserveSol: order.signalVirtualQuoteReserveSol,
        signalEffectiveQuoteReserveSol: order.signalEffectiveQuoteReserveSol,
        signalPoolBaseAmountRaw: order.signalPoolBaseAmountRaw,
        signalPoolQuoteAmountRaw: order.signalPoolQuoteAmountRaw,
        signalVirtualQuoteReservesRaw: order.signalVirtualQuoteReservesRaw,
        signalStreamRegion: order.signalStreamRegion,
        signalSource: order.signalSource,
        _dumpBackrunEntry: order._dumpBackrunEntry === true,
      });
    } finally {
      signalEngine.markBuyDone(order.mint);
    }
    const buyForensics = buyResult ? {
      effectiveQuoteReserveRaw: buyResult.effectiveQuoteReserveRaw,
      poolBaseAmountRaw: buyResult.poolBaseAmountRaw,
      poolQuoteAmountRaw: buyResult.poolQuoteAmountRaw,
      poolAddress: buyResult.poolAddress,
      sellerTx: buyResult.sellerTx,
      signalPriceBefore: buyResult.signalPriceBefore,
      signalPoolQuoteSol: buyResult.signalPoolQuoteSol,
      signalPoolBaseAmountUi: buyResult.signalPoolBaseAmountUi,
      signalRawPoolQuoteSol: buyResult.signalRawPoolQuoteSol,
      signalVirtualQuoteReserveSol: buyResult.signalVirtualQuoteReserveSol,
      signalEffectiveQuoteReserveSol: buyResult.signalEffectiveQuoteReserveSol,
      signalPoolBaseAmountRaw: buyResult.signalPoolBaseAmountRaw,
      signalPoolQuoteAmountRaw: buyResult.signalPoolQuoteAmountRaw,
      signalVirtualQuoteReservesRaw: buyResult.signalVirtualQuoteReservesRaw,
      signalStreamRegion: buyResult.signalStreamRegion,
      signalSource: buyResult.signalSource,
      baseDecimals: buyResult.baseDecimals,
      signalSlot: buyResult.signalSlot,
      signalTransactionIndex: buyResult.signalTransactionIndex,
      signalTs: buyResult.signalTs,
      signalReceivedAt: buyResult.signalReceivedAt,
      latestStreamSlotAtSignal: buyResult.latestStreamSlotAtSignal,
      latestStreamSlotAtOrder: buyResult.latestStreamSlotAtOrder,
      latestStreamSlotAtQuote: buyResult.latestStreamSlotAtQuote,
      slotGapAtSignal: buyResult.slotGapAtSignal,
      slotGapAtQuote: buyResult.slotGapAtQuote,
      rpcContextSlot: buyResult.rpcContextSlot,
      rpcPoolContextSlot: buyResult.rpcPoolContextSlot,
      rpcReserveContextSlot: buyResult.rpcReserveContextSlot,
      rpcUserContextSlot: buyResult.rpcUserContextSlot,
      rpcContextSlotApproximate: buyResult.rpcContextSlotApproximate,
      rpcSlotGapFromSignal: buyResult.rpcSlotGapFromSignal,
      rpcFetchedAtMs: buyResult.rpcFetchedAtMs,
      quoteStartedAt: buyResult.quoteStartedAt,
      quoteReadyAt: buyResult.quoteReadyAt,
      quoteLatencyMs: buyResult.quoteLatencyMs,
      signalToQuoteMs: buyResult.signalToQuoteMs,
      streamFastPath: buyResult.streamFastPath,
      streamSignalAgeMs: buyResult.streamSignalAgeMs,
      streamSlotGap: buyResult.streamSlotGap,
      streamStateFallbackReason: buyResult.streamStateFallbackReason,
    } : {};
    if (order._signalReceivedAt && buyResult && buyResult.success) {
      console.log('[main] buyOrder_timing: getToken=%dms preBuy=%dms buy=%dms', _t1-_t0, _t2-_t1, Date.now()-_t2);
    }

    // v3.17.16: 端到端延迟监控 — 这是「能否紧跟着砸单买入」的核心指标
    //   signalToBuyMs: 从砸盘 tx 时间戳到 BUY 提交的总耗时
    //   inEngineMs: 砸盘 tx 进入 SignalEngine 到 emit buyOrder
    //   buyLatencyMs: executor.buy 内部耗时(读 cache + 构造 + 发送)
    //   理想: signalToBuyMs ≤ 400ms (1 slot), buyLatencyMs ≤ 150ms
    if (order._signalReceivedAt && buyResult.success) {
      const signalToBuyMs = Date.now() - order._signalReceivedAt;
      const fromDumpTsMs = order.ts ? Date.now() - order.ts : null;
      console.log(
        `[main] ⏱  ${order.symbol || order.mint.slice(0, 6)} latency: ` +
        `signal→BUY=${signalToBuyMs}ms` +
        (fromDumpTsMs !== null ? ` dumpTs→BUY=${fromDumpTsMs}ms` : '') +
        ` (buy.latency=${buyResult.latencyMs}ms, state=${buyResult.stateLatencyMs}ms, send=${buyResult.sendLatencyMs}ms)`,
      );
    }

    // 记录 BUY trade（用同一 positionId）
    if (order._signalReceivedAt && buyResult) {
      const signalToBuyMs = Date.now() - order._signalReceivedAt;
      const fromDumpTsMs = order.ts ? Date.now() - order.ts : null;
      try {
        featureRecorder.recordLatency({
          ts: Date.now(),
          mint: order.mint,
          symbol: order.symbol,
          signature: buyResult.signature || order.signature,
          phase: 'buy',
          latencyDetectMs: fromDumpTsMs,
          latencyDecisionMs: signalToBuyMs,
          latencySendMs: buyResult.sendLatencyMs,
          latencyConfirmMs: buyResult.latencyMs,
          details: {
            success: !!buyResult.success,
            reason: order.reason,
            stateLatencyMs: buyResult.stateLatencyMs,
            error: buyResult.error || null,
            configuredSlippagePct: buyResult.configuredSlippagePct,
            effectiveSlippagePct: buyResult.effectiveSlippagePct,
            signalPrice: buyResult.signalPrice,
            expectedPrice: buyResult.expectedPrice,
            maxPrice: buyResult.maxPrice,
            maxQuoteSol: buyResult.maxQuoteSol,
            cacheAgeBeforeMs: buyResult.cacheAgeBeforeMs,
            cacheAgeAtBuildMs: buyResult.cacheAgeAtBuildMs,
            stateSource: buyResult.stateSource,
            failureStage: buyResult.failureStage,
            buyMode: buyResult.buyMode,
            minBaseAmountOutRaw: buyResult.minBaseAmountOutRaw,
            virtualQuoteReservesRaw: buyResult.virtualQuoteReservesRaw,
            ...buyForensics,
          },
        });
      } catch (_) { /* analytics only */ }
    }

    if (!order.mint) {
      console.error(`[main] BUG: buyOrder with null mint! order=`, JSON.stringify(order).slice(0, 200));
      return;
    }
    tradeLogger.logTrade({
      positionId,
      ts: Date.now(),
      mint: order.mint,
      symbol: order.symbol,
      side: 'BUY',
      solAmount: buyResult.solIn ?? order.sizeSol,
      tokenAmount: buyResult.tokenAmount,
      price: buyResult.price,
      signature: buyResult.signature,
      success: buyResult.success,
      dryRun: config.DRY_RUN,
      reason: order.reason,
      latencyMs: buyResult.latencyMs,
      error: buyResult.error,
      configuredSlippagePct: buyResult.configuredSlippagePct ?? (config.strategy.buySlippageBps / 100),
      effectiveSlippagePct: buyResult.effectiveSlippagePct,
      signalPrice: buyResult.signalPrice ?? order.priceAfter,
      expectedPrice: buyResult.expectedPrice,
      maxPrice: buyResult.maxPrice,
      maxQuoteSol: buyResult.maxQuoteSol,
      cacheAgeBeforeMs: buyResult.cacheAgeBeforeMs,
      cacheAgeAtBuildMs: buyResult.cacheAgeAtBuildMs,
      stateSource: buyResult.stateSource,
      buyMode: buyResult.buyMode,
      minBaseAmountOutRaw: buyResult.minBaseAmountOutRaw,
      virtualQuoteReservesRaw: buyResult.virtualQuoteReservesRaw,
      ...buyForensics,
    });

    if (!buyResult.success) {
      console.error(
        `[main] BUY failed for ${order.symbol || order.mint.slice(0, 6)}: ${buyResult.error}`,
      );
      // Protect only explicit execution/pool failures. Local price-guard rejects
      // spend no fee and do not create a strategy cooldown.
      const poolFailure = buyResult.poolDead || buyResult.poolLowLiquidity || buyResult.poolMintMismatch;
      if (buyResult.chainFailure || poolFailure) {
        const cooldownMs = buyResult.chainFailure
          ? parseInt(process.env.BUY_FAILED_REBUY_COOLDOWN_MS || '86400000', 10)
          : parseInt(process.env.POOL_FAIL_REBUY_COOLDOWN_MS || '86400000', 10);
        signalEngine._exitCooldowns.set(order.mint, Date.now() + cooldownMs);
        console.log(
          `[main] 🔒 ${buyResult.chainFailure ? 'BUY_CHAIN_FAILED' : 'Pool fail'} cooldown ` +
            `${order.symbol || order.mint.slice(0, 6)} for ${Math.round(cooldownMs / 3600000)}h`,
        );
      }
      return;
    }

    // 用真实成交价初始化 entry_price（关键修复 v1 bug：之前用 trigger 价）
    // v3.17.21: 买入瞬间的 FDV / pool / liquidity（用于事后分析入场质量）
    const entryFdv = tokenInfo?.fdv ?? null;
    const entryLiquidity = tokenInfo?.liquidity ?? null;
    const entryPoolSol = order.poolQuoteAfter ?? tokenInfo?.liquidity ?? null; // dumpSignal.poolQuoteAfter 最准确

    // v3.17.39: 计算首信号到买入的秒数（用于回测入场时机）
    let mintAgeAtBuySec = null;
    try {
      const firstSignal = tradeLogger.db.prepare(
        'SELECT MIN(ts) as ts FROM signals WHERE mint = ?'
      ).get(order.mint);
      if (firstSignal && firstSignal.ts) {
        mintAgeAtBuySec = Math.round((Date.now() - firstSignal.ts) / 1000);
      }
    } catch (_) {}

    positionManager.registerOpen({
      positionId,
      mint: order.mint,
      symbol: order.symbol,
      entrySol: buyResult.solIn ?? order.sizeSol,
      entryPrice: buyResult.price,         // 真实成交价
      tokenAmount: buyResult.tokenAmount,  // 真实买到的数量
      dryRun: config.DRY_RUN,
      signature: buyResult.signature,
      buyFeeLamports: buyResult.priorityFeeLamports || 0,  // v3.4: 用于真实 PnL
      buySlot: buyResult.buySlot || 0,  // v3.17.11: BUY 时的链上 slot
      dumpSlot: order.slot || 0,        // v3.17.19: 砸单的 slot,用于算 BUY 落链领先几个 slot
      entryFdv,                          // v3.17.21: 买入瞬间 FDV
      entryPoolSol,                      // v3.17.21: 买入瞬间池子 SOL
      entryLiquidity,                    // v3.17.21: 买入瞬间流动性 USD
      sellCount10s: order._sellCount10s || 1,   // v3.17.36: 连环拔回测
      totalSellSol10s: order._totalSellSol10s || order.sellSol, // v3.17.36: 连环拔回测
      mintAgeAtBuySec,                           // v3.17.39: 首信号到买入秒数
      rsiPreDump: order.rsiPreDump,              // v3.17.38: 砸单前 RSI5s
      rsi1sPreDump: order.rsi1sPreDump,          // v3.17.38: 砸单前 RSI1s
      rsi30sPreDump: order.rsi30sPreDump,        // v3.17.42: 砸单前 RSI30s
      isEmaStrategy: false,  // EMA removed
      isAddOn: order._isAddOn || false,                 // 加仓标记
    });


    // 立即同步 PriceTracker，用真实成交价做 entry baseline
    // （避免下一笔 LaserStream tx 推一个旧价格触发假 TP）
    priceTracker.forceSet(order.mint, buyResult.price);

    if (buyResult.signature) signalEngine.registerOurSignature(buyResult.signature);
  });

  positionManager.on('opened', (pos) =>
    server.broadcast({ type: 'positionOpened', position: pos }),
  );
  positionManager.on('closed', (pos) => {
    // Start cooldown from confirmed close. Sequential add-on exits extend the
    // same mint cooldown from the latest completed sale.
    signalEngine.lastTriggerTs.set(pos.mint, Date.now());
    if (config.strategy.rebuyCooldownMs > 0) {
      signalEngine._exitCooldowns.set(pos.mint, Date.now() + config.strategy.rebuyCooldownMs);
    }
    if (
      config.strategy.exitMode === 'DUMP_BACKRUN_V9' &&
      typeof pos.exitReason === 'string' &&
      pos.exitReason.startsWith('TIMEOUT')
    ) {
      const newlyBlocked = signalEngine.blockDumpBackrunMintAfterTimeout(pos.mint);
      if (newlyBlocked) {
        console.log(
          `[main] V9 timeout block enabled for ${pos.symbol || pos.mint.slice(0, 6)}; ` +
            'future dump signals remain recorded but cannot buy',
        );
      }
    }
    if (pos.removeAfterExit && !positionManager.hasOpenPosition(pos.mint)) {
      tokenRegistry.removeToken(pos.mint);
      tickStream.updateSubscription(tokenRegistry.listActive().map((token) => token.mint));
      server.broadcast({
        type: 'tokenRemoved',
        mint: pos.mint,
        reason: pos.exitReason,
      });
      console.log(
        `[main] removed ${pos.symbol || pos.mint.slice(0, 6)} after ${pos.exitReason}`,
      );
    }
    server.broadcast({ type: 'positionClosed', position: pos });
  });

  // ============ 启动服务器 ============
  await server.start();

  // ============ 启动前补充 pool 信息（异步后台） ============
  if (config.autoFillPoolsOnStart) {
    backgroundFillPools(tokenRegistry).catch((err) =>
      console.error(`[main] backgroundFillPools error: ${err.message}`),
    );
  }

  // ============ 启动数据流 ============
  const initialMints = tokenRegistry.listActive().map((t) => t.mint);
  console.log(`[main] starting LaserStream with ${initialMints.length} initial tokens`);
  competitorTracker.startForensics();
  await tickStream.start(initialMints);
  if (config.pumpDiscovery.enabled) pumpDiscovery.start();

  // ============ 优雅退出 ============
  const shutdown = async (signal) => {
    console.log(`\n[main] ${signal} received, shutting down gracefully...`);
    try {
      pumpDiscovery.stop();
      competitorTracker.stopForensics();
      await tickStream.stop();
      postExitTracker.shutdown();
      positionManager.stop();
      tokenWatchdog.stop();
      dumpDetector.shutdown && dumpDetector.shutdown();
      alertChecker.stop();
      monitor.stop();
      executor.stop && executor.stop();
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      console.error(`[main] shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    monitor.recordError('main', err, { phase: 'uncaughtException' });
    monitor.inc('main.uncaughtExceptions', 1, 'main');
    console.error('[main] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    monitor.recordError('main', reason instanceof Error ? reason : new Error(String(reason)), {
      phase: 'unhandledRejection',
    });
    monitor.inc('main.unhandledRejections', 1, 'main');
    console.error('[main] unhandledRejection:', reason);
  });

  console.log('[main] startup complete');

  // v3.27: 定时3小时自动重启，防止 Rust native 缓慢泄漏导致 slot gap 恶化
  // 基线RSS ~550MB (7个gRPC连接)，3小时泄漏到 ~800MB 时 slot gap 就开始恶化
  // 重启后 restoreFromDb 恢复持仓，有仓时延迟到空仓或RSS>1000MB再重启
  const MAX_UPTIME_MS = parseInt(process.env.MAX_UPTIME_MS || '10800000', 10); // 默认3小时
  const startTime = Date.now();
  setInterval(() => {
    const uptimeMs = Date.now() - startTime;
    const posCount = positionManager?.positions?.size ?? 0;
    if (uptimeMs > MAX_UPTIME_MS && posCount === 0) {
      console.log(`[MEM] 🔄 uptime=${Math.round(uptimeMs/60000)}min > ${Math.round(MAX_UPTIME_MS/60000)}min 且空仓, 定时重启释放 Rust native 内存`);
      process.exit(0);
    } else if (uptimeMs > MAX_UPTIME_MS && posCount > 0) {
      console.log(`[MEM] ⏳ uptime=${Math.round(uptimeMs/60000)}min > ${Math.round(MAX_UPTIME_MS/60000)}min 但有 ${posCount} 个持仓, 等 RSS 达到阈值或空仓后重启`);
    }
  }, 60_000);
}

/**
 * 后台扫描所有缺失 pool 信息的代币，逐个补上。
 * 节流：每个 250ms。
 */
async function backgroundFillPools(tokenRegistry) {
  const targets = tokenRegistry
    .listAll()
    .filter((t) => t.is_active && needsPoolRepair(t));

  if (targets.length === 0) return;
  console.log(`[main] auto-fill pool for ${targets.length} tokens (background)`);

  const finder = new PoolFinder({});
  let ok = 0;
  let fail = 0;

  for (const t of targets) {
    try {
      const result = await finder.findPoolForMint(t.mint);
      if (result) {
        tokenRegistry.setPoolInfo(t.mint, result);
        ok += 1;
      } else {
        fail += 1;
      }
    } catch (err) {
      fail += 1;
      console.warn(`[fill-pools] ${t.symbol || t.mint.slice(0, 6)}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`[main] auto-fill pool done: ${ok} OK, ${fail} failed`);
}

async function fillPoolForToken(tokenRegistry, mint) {
  try {
    const finder = new PoolFinder({});
    const result = await finder.findPoolForMint(mint);
    if (result) {
      tokenRegistry.setPoolInfo(mint, result);
      console.log(
        `[fill-pools] ${mint.slice(0, 6)}: pool=${result.poolAddress.slice(0, 6)}..`,
      );
    }
  } catch (err) {
    console.warn(`[fill-pools] ${mint.slice(0, 6)}: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('[main] fatal error:', err);
  process.exit(1);
});

// v3.32b: 堆外内存监控 — 区分 heap vs external vs arrayBuffers
setInterval(() => {
  const m = process.memoryUsage();
  console.log(`[MEM] rss=${(m.rss/1048576)|0}MB heapUsed=${(m.heapUsed/1048576)|0}MB external=${(m.external/1048576)|0}MB arrayBuffers=${(m.arrayBuffers/1048576)|0}MB`);
}, 30000);
