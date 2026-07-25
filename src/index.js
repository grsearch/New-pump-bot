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
const ActivityFlowTracker = require('./core/OrderFlowTracker');
const PumpGraduationDiscovery = require('./core/PumpGraduationDiscovery');
const FeatureRecorder = require('./core/FeatureRecorder');

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
  console.log('ðŸŽ¯ Dump Sniper V3.17.20 starting...');
  console.log(`Mode: ${config.DRY_RUN ? 'DRY_RUN' : 'âš ï¸  LIVE TRADING âš ï¸'}`);
  console.log(`Position: ${config.strategy.positionSizeSol} SOL`);
  console.log(`Fixed TP: ${config.strategy.takeProfitPct > 0 ? `+${config.strategy.takeProfitPct}%` : 'disabled'}`);
  console.log(`Trailing: arm at +${config.strategy.trailingActivatePct}% / drawdown ${config.strategy.trailingDrawdownPct}%`);
  console.log('RSI exit: disabled');
  if (config.activityFlow.entryMode === 'ONE_SECOND_REBOUND_V8') {
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
  console.log(`Legacy dumpSignal: ${config.activityFlow.replaceDumpSignal ? 'suppressed' : 'allowed fallback'}`);
  console.log(`Rebuy cooldown: ${config.strategy.rebuyCooldownMs > 0 ? config.strategy.rebuyCooldownMs / 60_000 + 'min after close' : 'disabled'}`);
  console.log(
    `Watchdog: FDV=${watchdogFdvRange}, liquidity>=$${config.strategy.minLiquidityUsd}, ` +
      `migrationAge<=${config.strategy.maxMintAgeMinutes}min ` +
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
  console.log(`Max hold: ${config.strategy.maxHoldMs > 0 ? config.strategy.maxHoldMs / 1000 + 's' : 'disabled'}`);
  console.log(
    `Buy execution: buy_exact_quote_in, fixed SOL, virtual-reserve-aware, ` +
      `signal<=+${config.strategy.buyMaxPriceDeviationPct}%, forced pool refresh`,
  );
  console.log('Add-on: disabled');
  console.log(`Executor: Pump AMM SDK direct (no Jupiter)`);
  console.log(`Pump graduation discovery: ${config.pumpDiscovery.enabled ? 'enabled' : 'disabled'}`);
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

  // ============ æ•°æ®å±‚ ============
  const tokenRegistry = new TokenRegistry();
  const tradeLogger = new TradeLogger(tokenRegistry.db);

  // ============ æ ¸å¿ƒå¼•æ“Ž ============
  const priceTracker = new PriceTracker();
  const dumpDetector = new DumpDetector(tokenRegistry);
  const executor = new Executor();

  // v3.5: PoolStateCache - åŽå°é¢„çƒ­æ‰€æœ‰ç›‘æŽ§ä»£å¸çš„ Pump pool state
  // BUY è·¯å¾„ä¸å†é˜»å¡ž swapSolanaStateï¼ˆ80-150ms RPCï¼‰ï¼Œä»Žå†…å­˜è¯» 0ms
  // v3.15: ç”¨ executor.cacheSdkï¼ˆç‹¬ç«‹å®žä¾‹ï¼Œèµ°æ™®é€š RPCï¼‰ï¼Œä¸å ç”¨ stakedRpc é€šé“
  if (!config.DRY_RUN && executor.cacheSdk && executor.keypair) {
    const PoolStateCache = require('./core/PoolStateCache');
    const poolStateCache = new PoolStateCache({
      onlineSdk: executor.cacheSdk,  // v3.15: ç”¨ cacheSdk è€Œä¸æ˜¯ onlineSdk
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

  // v3.17.31: å¹³ä»“åŽ 5 åˆ†é’Ÿä»·æ ¼è¿½è¸ª(æ—è·¯,ä¸å½±å“ä¸»è·¯å¾„)
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
  // v3.17.7: tickStream å¿…é¡»å…ˆäºŽ signalEngine åˆ›å»ºï¼ˆsignalEngine éœ€è¦å®ƒçš„ latestSlot getterï¼‰
  const tickStream = new TickStream();
  // Keep latest slot available for buy metadata and downstream execution.
  positionManager.tickStream = tickStream;
  // v3.17.12: DumpDetector æŸ¥è¯¢ sig çš„é¦–æ¬¡æ¥æºï¼ˆSS vs LSï¼‰
  dumpDetector._tickStream = tickStream;
  // v3.17.17: SS pre-warm éœ€è¦ tokenRegistry åš base_vault â†’ mint åæŸ¥
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

  // ============ EMA Serviceï¼ˆEMA ç ¸å•ä¹°å…¥ç­–ç•¥ï¼‰ ============
      // EMA watch removed

  // ============ Competitor Trackerï¼ˆç«žäº‰å¯¹æ‰‹é’±åŒ…åˆ†æžï¼‰ ============
  //   v3.17.32: ç§»åˆ° DailyReport ä¹‹å‰ï¼Œä»¥ä¾¿æ³¨å…¥ competitorTracker
  //   è¿½è¸ªæŒ‡å®šé’±åŒ…åœ¨æˆ‘ä»¬ç›‘æŽ§ä»£å¸ä¸Šçš„ä¹°å–ï¼Œé…å¯¹æˆ round-trip ç»Ÿè®¡ç›ˆäº/èƒœçŽ‡/æŒä»“æ—¶é•¿ã€‚
  //   æ•°æ®å¤ç”¨ DumpDetector çš„ swapParsed äº‹ä»¶ï¼Œé›¶é¢å¤– RPCã€ä¸å½±å“ BUY å»¶è¿Ÿã€‚
  //   åœ°å€å¯åœ¨ .env COMPETITOR_WALLETSï¼ˆé€—å·åˆ†éš”ï¼‰é…ç½®ï¼›é»˜è®¤å†…ç½®ç”¨æˆ·ç»™çš„ä¸¤ä¸ªã€‚
  const competitorWallets = (process.env.COMPETITOR_WALLETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const defaultCompetitors = [
    'BSHdFzWq6BfXpTx49LcCuvF4FVZakEZTibkKgjBcJqLD',
    '3fZftz6m8d37X5pBhnF4rHhgrG5hW8rsCKgdhtuPBf6u',
  ];
  const competitorTracker = new CompetitorTracker({
    db: tokenRegistry.db,
    addresses: competitorWallets.length > 0 ? competitorWallets : defaultCompetitors,
    dumpDetector,                              // é›¶æˆæœ¬è¿›åœºç‰¹å¾ï¼ˆè§¦å‘ç ¸å•ä¸Šä¸‹æ–‡ï¼‰
    poolStateCache: executor.poolStateCache || null, // ä¹°å…¥çž¬é—´æ± å­ SOL æµåŠ¨æ€§
    fetchTokenInfo: async (mint) => {          // ä»£å¸ä¾§ç‰¹å¾ï¼ˆFDV/æµåŠ¨æ€§/24hé‡ï¼‰ï¼Œå¼‚æ­¥ä¸é˜»å¡ž
      try {
        const { fetchTokenFullInfo } = require('./utils/tokenMeta');
        const info = await fetchTokenFullInfo(mint);
        return { fdv: info.fdv, liquidity: info.liquidity, holders: info.holders ?? null, volume24h: info.volume24h };
      } catch (_) { return null; }
    },
    enrichEntry: (process.env.COMPETITOR_ENRICH ?? 'true').toLowerCase() === 'true',
    // è·Ÿå–é»˜è®¤å…³é—­ï¼ˆç”¨æˆ·é€‰æ‹©"åªè®°å½•åˆ†æž"ï¼‰ã€‚çœ‹å®Œæ•°æ®åŽè®¾ COMPETITOR_FOLLOW_SELL=true å³å¯ç”¨ã€‚
    followSell: (process.env.COMPETITOR_FOLLOW_SELL ?? 'false').toLowerCase() === 'true',
    followSellMinWinRate: parseFloat(process.env.COMPETITOR_FOLLOW_SELL_MIN_WINRATE || '60'),
    followSellMinClosed: parseInt(process.env.COMPETITOR_FOLLOW_SELL_MIN_CLOSED || '10', 10),
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
  const activityFlowDescription = activityFlowTracker.entryMode === 'ONE_SECOND_REBOUND_V8'
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

  // ============ æŠ¥å‘Š ============
  const dailyReport = new Dailï¾7¶‰žËkºwµçZHÉ•¥ÍÑ•ÈÁ½Í¥Ñ¥½¸€ôôôôôôôôôôôô4(€Í¥¹…±¹¥¹”¹½¸ ‰Õå=É‘•Èœ°…Íå¹Œ€¡½É‘•È¤€ôøì4(€€€½¹Í½±”¹±½œ¡mµ…¥¹t‰Õå=É‘•ÈÉ••¥Ù•è€‘í½É‘•È¹Íåµ‰½°ñð½É‘•È¹µ¥¹Ð¹Í±¥” À°Ø¥ôµ¥¹Ðô‘í½É‘•È¹µ¥¹Ð¹Í±¥” À°à¥ô¸¸É•…Í½¸ô‘í½É‘•È¹É•…Í½¹ôÍ¥œô‘í½É‘•È¹Í¥¹…ÑÕÉ”ü¹Í±¥” À°ÄÈ¥ô¸¹€¤ì4(€€€½¹ÍÐ}ÐÀ€ô…Ñ”¹¹½Ü ¤ì4(€€€½¹ÍÐÑ½­•¹%¹™¼€ôÑ½­•¹I•¥ÍÑÉä¹•ÑQ½­•¸¡½É‘•È¹µ¥¹Ð¤ì4(€€€½¹ÍÐ}ÐÄ€ô…Ñ”¹¹½Ü ¤ì4(4(€€€€¼¼ƒžR£–B3’â’â¨Á½Í¥Ñ¥½¹%ƒ¢Ò¿ž¦ü	UdÑÉ…‘”€¼Á½Í¥Ñ¥½¸ƒ¢† 4(€€€½¹ÍÐÁ½Í¥Ñ¥½¹%€ôÉåÁÑ¼¹É…¹‘½µUU% ¤ì4(4(€€€€¼¼ƒš‚¢ºÃš¶µ¥¹Ðƒš¶–r ‰Õäƒ’â·¾ò3¢º§–B;žî·–æÛ–>D‘ÕµÁM¥¹…°ƒžr/–"Ã¢þg’â«šž÷’ö7¢Š¯–6€4(€€€Í¥¹…±¹¥¹”¹µ…É­	Õå%¹™±¥¡Ð¡½É‘•È¹µ¥¹Ð¤ì4(4(€€€€¼¼I•½ÉÑ¡”ÕÉÉ•¹Ð¡…¥¸Í±½Ð½¸	Ud™½È•á•ÕÑ¥½¸µ•Ñ…‘…Ñ„¸4(€€€•á•ÕÑ½È¹Í•Ñ1…Ñ•ÍÑM±½Ð¡Ñ¥­MÑÉ•…´¹±…Ñ•ÍÑM±½Ðñð€À¤ì4(4(€€€½¹ÍÐ}ÐÈ€ô…Ñ”¹¹½Ü ¤ì4(€€€±•Ð‰ÕåI•ÍÕ±Ðì4(€€€ÑÉäì4(€€€€€‰ÕåI•ÍÕ±Ð€ô…Ý…¥Ð•á•ÕÑ½È¹‰Õä¡ì4(€€€€€€€µ¥¹Ðè½É‘•È¹µ¥¹Ð°4(€€€€€€€Íåµ‰½°è½É‘•È¹Íåµ‰½°°4(€€€€€€€Í¥é•M½°è½É‘•È¹Í¥é•M½°°4(€€€€€€€ÁÉ¥•™Ñ•Èè½É‘•È¹ÁÉ¥•™Ñ•È°€¼¼ƒžR£’ê8Ie}IU8ƒš¢‡š.|4(€€€€€€€‰…Í••¥µ…±Ìè½É‘•È¹‰…Í••¥µ…±Ì€üüÑ½­•¹%¹™¼ü¹‘•¥µ…±Ì€üü€Ø°4(€€€€€€€Á½½±‘‘É•ÍÌèÑ½­•¹%¹™¼ü¹Á½½±}…‘‘É•ÍÌ°€¼¼AÕµÀM,ƒ¦r¢šÁ½½°…‘‘É•ÍÌ4(€€€€€ô¤ì4(€€€ô™¥¹…±±äì4(€€€€€Í¥¹…±¹¥¹”¹µ…É­	Õå½¹”¡½É‘•È¹µ¥¹Ð¤ì4(€€€ô4(€€€¥˜€¡½É‘•È¹}Í¥¹…±I••¥Ù•‘Ð€˜˜‰ÕåI•ÍÕ±Ð€˜˜‰ÕåI•ÍÕ±Ð¹ÍÕ•ÍÌ¤ì4(€€€€€½¹Í½±”¹±½œ mµ…¥¹t‰Õå=É‘•É}Ñ¥µ¥¹œè•ÑQ½­•¸ô•‘µÌÁÉ•	Õäô•‘µÌ‰Õäô•‘µÌœ°}ÐÄµ}ÐÀ°}ÐÈµ}ÐÄ°…Ñ”¹¹½Ü ¤µ}ÐÈ¤ì4(€€€ô4(4(€€€€¼¼ØÌ¸ÄÜ¸ÄØèƒž®¿–"Ãž®¿–îÛ¢þžnGš:œƒŠPƒ¢þgšb¿Ž3¢÷–B›žÒŸ¢Þžvž‚ã–6W’æÃ–—Ž7žjš‚ã–þš2š‚4(€€€€¼¼€€Í¥¹…±Q½	Õå5Ìèƒ’î;ž‚ãžn`Ñàƒš^Û¦^Óš"Ï–"À	Udƒš>C’ê“žjšï¢_š^Ø4(€€€€¼¼€€¥¹¹¥¹•5Ìèƒž‚ãžn`Ñàƒ¢þo–”M¥¹…±¹¥¹”ƒ–"À•µ¥Ð‰Õå=É‘•È4(€€€€¼¼€€‰Õå1…Ñ•¹å5Ìè•á•ÕÑ½È¹‰Õäƒ–¦£¢_š^Ø£¢¾ì…¡”€¬ƒšz¦€€¬ƒ–>G¦¤4(€€€€¼¼€€ƒžBšÌèÍ¥¹…±Q½	Õå5ÌƒŠ&€ÐÀÁµÌ€ ÄÍ±½Ð¤°‰Õå1…Ñ•¹å5ÌƒŠ&€ÄÔÁµÌ4(€€€¥˜€¡½É‘•È¹}Í¥¹…±I••¥Ù•‘Ð€˜˜‰ÕåI•ÍÕ±Ð¹ÍÕ•ÍÌ¤ì4(€€€€€½¹ÍÐÍ¥¹…±Q½	Õå5Ì€ô…Ñ”¹¹½Ü ¤€´½É‘•È¹}Í¥¹…±I••¥Ù•‘Ðì4(€€€€€½¹ÍÐ™É½µÕµÁQÍ5Ì€ô½É‘•È¹ÑÌ€ü…Ñ”¹¹½Ü ¤€´½É‘•È¹ÑÌ€è¹Õ±°ì4(€€€€€½¹Í½±”¹±½œ 4(€€€€€€€mµ…¥¹tƒŠ>Ä€€‘í½É‘•È¹Íåµ‰½°ñð½É‘•È¹µ¥¹Ð¹Í±¥” À°€Ø¥ô±…Ñ•¹äè€€¬4(€€€€€€€Í¥¹…³ŠI	Udô‘íÍ¥¹…±Q½	Õå5ÍõµÍ€€¬4(€€€€€€€€¡™É½µÕµÁQÍ5Ì€„ôô¹Õ±°€ü€‘ÕµÁQÏŠI	Udô‘í™É½µÕµÁQÍ5ÍõµÍ€€è€œœ¤€¬4(€€€€€€€€€¡‰Õä¹±…Ñ•¹äô‘í‰ÕåI•ÍÕ±Ð¹±…Ñ•¹å5ÍõµÌ°ÍÑ…Ñ”ô‘í‰ÕåI•ÍÕ±Ð¹ÍÑ…Ñ•1…Ñ•¹å5ÍõµÌ°Í•¹ô‘í‰ÕåI•ÍÕ±Ð¹Í•¹‘1…Ñ•¹å5ÍõµÌ¥€°4(€€€€€€¤ì4(€€€ô4(4(€€€€¼¼ƒ¢ºÃ–öT	UdÑÉ…‘—¾ò#žR£–B3’â Á½Í¥Ñ¥½¹%“¾ò$4(€€€¥˜€¡½É‘•È¹}Í¥¹…±I••¥Ù•‘Ð€˜˜‰ÕåI•ÍÕ±Ð¤ì4(€€€€€½¹ÍÐÍ¥¹…±Q½	Õå5Ì€ô…Ñ”¹¹½Ü ¤€´½É‘•È¹}Í¥¹…±I••¥Ù•‘Ðì4(€€€€€½¹ÍÐ™É½µÕµÁQÍ5Ì€ô½É‘•È¹ÑÌ€ü…Ñ”¹¹½Ü ¤€´½É‘•È¹ÑÌ€è¹Õ±°ì4(€€€€€ÑÉäì4(€€€€€€€™•…ÑÕÉ•I•½É‘•È¹É•½É‘1…Ñ•¹ä¡ì4(€€€€€€€€€ÑÌè…Ñ”¹¹½Ü ¤°4(€€€€€€€€€µ¥¹Ðè½É‘•È¹µ¥¹Ð°4(€€€€€€€€€Íåµ‰½°è½É‘•È¹Íåµ‰½°°4(€€€€€€€€€Í¥¹…ÑÕÉ”è‰ÕåI•ÍÕ±Ð¹Í¥¹…ÑÕÉ”ñð½É‘•È¹Í¥¹…ÑÕÉ”°4(€€€€€€€€€Á¡…Í”è€‰Õäœ°4(€€€€€€€€€±…Ñ•¹å•Ñ•Ñ5Ìè™É½µÕµÁQÍ5Ì°4(€€€€€€€€€±…Ñ•¹å•¥Í¥½¹5ÌèÍ¥¹…±Q½	Õå5Ì°4(€€€€€€€€€±…Ñ•¹åM•¹‘5Ìè‰ÕåI•ÍÕ±Ð¹Í•¹‘1…Ñ•¹å5Ì°4(€€€€€€€€€±…Ñ•¹å½¹™¥Éµ5Ìè‰ÕåI•ÍÕ±Ð¹±…Ñ•¹å5Ì°4(€€€€€€€€€‘•Ñ…¥±Ìèì4(€€€€€€€€€€€ÍÕ•ÍÌè€„…‰ÕåI•ÍÕ±Ð¹ÍÕ•ÍÌ°4(€€€€€€€€€€€É•…Í½¸è½É‘•È¹É•…Í½¸°4(€€€€€€€€€€€ÍÑ…Ñ•1…Ñ•¹å5Ìè‰ÕåI•ÍÕ±Ð¹ÍÑ…Ñ•1…Ñ•¹å5Ì°4(€€€€€€€€€€€•ÉÉ½Èè‰ÕåI•ÍÕ±Ð¹•ÉÉ½Èñð¹Õ±°°4(€€€€€€€€€€€½¹™¥ÕÉ•‘M±¥ÁÁ…•AÐè‰ÕåI•ÍÕ±Ð¹½¹™¥ÕÉ•‘M±¥ÁÁ…•AÐ°4(€€€€€€€€€€€•™™•Ñ¥Ù•M±¥ÁÁ…•AÐè‰ÕåI•ÍÕ±Ð¹•™™•Ñ¥Ù•M±¥ÁÁ…•AÐ°4(€€€€€€€€€€€Í¥¹…±AÉ¥”è‰ÕåI•ÍÕ±Ð¹Í¥¹…±AÉ¥”°4(€€€€€€€€€€€•áÁ•Ñ•‘AÉ¥”è‰ÕåI•ÍÕ±Ð¹•áÁ•Ñ•‘AÉ¥”°4(€€€€€€€€€€€µ…áAÉ¥”è‰ÕåI•ÍÕ±Ð¹µ…áAÉ¥”°4(€€€€€€€€€€€µ…áEÕ½Ñ•M½°è‰ÕåI•ÍÕ±Ð¹µ…áEÕ½Ñ•M½°°4(€€€€€€€€€€€…¡••	•™½É•5Ìè‰ÕåI•ÍÕ±Ð¹…¡••	•™½É•5Ì°4(€€€€€€€€€€€…¡••Ñ	Õ¥±‘5Ìè‰ÕåI•ÍÕ±Ð¹…¡••Ñ	Õ¥±‘5Ì°4(€€€€€€€€€€€ÍÑ…Ñ•M½ÕÉ”è‰ÕåI•ÍÕ±Ð¹ÍÑ…Ñ•M½ÕÉ”°4(€€€€€€€€€€€™…¥±ÕÉ•MÑ…”è‰ÕåI•ÍÕ±Ð¹™…¥±ÕÉ•MÑ…”°4(€€€€€€€€€€€‰Õå5½‘”è‰ÕåI•ÍÕ±Ð¹‰Õå5½‘”°4(€€€€€€€€€€€µ¥¹	…Í•µ½Õ¹Ñ=ÕÑI…Üè‰ÕåI•ÍÕ±Ð¹µ¥¹	…Í•µ½Õ¹Ñ=ÕÑI…Ü°4(€€€€€€€€€€€Ù¥ÉÑÕ…±EÕ½Ñ•I•Í•ÉÙ•ÍI…Üè‰ÕåI•ÍÕ±Ð¹Ù¥ÉÑÕ…±EÕ½Ñ•I•Í•ÉÙ•ÍI…Ü°4(€€€€€€€€€ô°4(€€€€€€€ô¤ì4(€€€€€ô…Ñ €¡|¤ì€¼¨…¹…±åÑ¥Ì½¹±ä€¨¼ô4(€€€ô4(4(€€€¥˜€ …½É‘•È¹µ¥¹Ð¤ì4(€€€€€½¹Í½±”¹•ÉÉ½È¡mµ…¥¹t	Uè‰Õå=É‘•ÈÝ¥Ñ ¹Õ±°µ¥¹Ð„½É‘•Èõ€°)M=8¹ÍÑÉ¥¹¥™ä¡½É‘•È¤¹Í±¥” À°€ÈÀÀ¤¤ì4(€€€€€É•ÑÕÉ¸ì4(€€€ô4(€€€ÑÉ…‘•1½•È¹±½QÉ…‘”¡ì4(€€€€€Á½Í¥Ñ¥½¹%°4(€€€€€ÑÌè…Ñ”¹¹½Ü ¤°4(€€€€€µ¥¹Ðè½É‘•È¹µ¥¹Ð°4(€€€€€Íåµ‰½°è½É‘•È¹Íåµ‰½°°4(€€€€€Í¥‘”è€	Udœ°4(€€€€€Í½±µ½Õ¹Ðè‰ÕåI•ÍÕ±Ð¹Í½±%¸€üü½É‘•È¹Í¥é•M½°°4(€€€€€Ñ½­•¹µ½Õ¹Ðè‰ÕåI•ÍÕ±Ð¹Ñ½­•¹µ½Õ¹Ð°4(€€€€€ÁÉ¥”è‰ÕåI•ÍÕ±Ð¹ÁÉ¥”°4(€€€€€Í¥¹…ÑÕÉ”è‰ÕåI•ÍÕ±Ð¹Í¥¹…ÑÕÉ”°4(€€€€€ÍÕ•ÍÌè‰ÕåI•ÍÕ±Ð¹ÍÕ•ÍÌ°4(€€€€€‘ÉåIÕ¸è½¹™¥œ¹Ie}IU8°4(€€€€€É•…Í½¸è½É‘•È¹É•…Í½¸°4(€€€€€±…Ñ•¹å5Ìè‰ÕåI•ÍÕ±Ð¹±…Ñ•¹å5Ì°4(€€€€€•ÉÉ½Èè‰ÕåI•ÍÕ±Ð¹•ÉÉ½È°4(€€€€€½¹™¥ÕÉ•‘M±¥ÁÁ…•AÐè‰ÕåI•ÍÕ±Ð¹½¹™¥ÕÉ•‘M±¥ÁÁ…•AÐ€üü€¡½¹™¥œ¹ÍÑÉ…Ñ•ä¹‰ÕåM±¥ÁÁ…•	ÁÌ€¼€ÄÀÀ¤°4(€€€€€•™™•Ñ¥Ù•M±¥ÁÁ…•AÐè‰ÕåI•ÍÕ±Ð¹•™™•Ñ¥Ù•M±¥ÁÁ…•AÐ°4(€€€€€Í¥¹…±AÉ¥”è‰ÕåI•ÍÕ±Ð¹Í¥¹…±AÉ¥”€üü½É‘•È¹ÁÉ¥•™Ñ•È°4(€€€€€•áÁ•Ñ•‘AÉ¥”è‰ÕåI•ÍÕ±Ð¹•áÁ•Ñ•‘AÉ¥”°4(€€€€€µ…áAÉ¥”è‰ÕåI•ÍÕ±Ð¹µ…áAÉ¥”°4(€€€€€µ…áEÕ½Ñ•M½°è‰ÕåI•ÍÕ±Ð¹µ…áEÕ½Ñ•M½°°4(€€€€€…¡••	•™½É•5Ìè‰ÕåI•ÍÕ±Ð¹…¡••	•™½É•5Ì°4(€€€€€…¡••Ñ	Õ¥±‘5Ìè‰ÕåI•ÍÕ±Ð¹…¡••Ñ	Õ¥±‘5Ì°4(€€€€€ÍÑ…Ñ•M½ÕÉ”è‰ÕåI•ÍÕ±Ð¹ÍÑ…Ñ•M½ÕÉ”°4(€€€€€‰Õå5½‘”è‰ÕåI•ÍÕ±Ð¹‰Õå5½‘”°4(€€€€€µ¥¹	…Í•µ½Õ¹Ñ=ÕÑI…Üè‰ÕåI•ÍÕ±Ð¹µ¥¹	…Í•µ½Õ¹Ñ=ÕÑI…Ü°4(€€€€€Ù¥ÉÑÕ…±EÕ½Ñ•I•Í•ÉÙ•ÍI…Üè‰ÕåI•ÍÕ±Ð¹Ù¥ÉÑÕ…±EÕ½Ñ•I•Í•ÉÙ•ÍI…Ü°4(€€€ô¤ì4(4(€€€¥˜€ …‰ÕåI•ÍÕ±Ð¹ÍÕ•ÍÌ¤ì4(€€€€€½¹Í½±”¹•ÉÉ½È 4(€€€€€€€mµ…¥¹t	Ud™…¥±•™½È€‘í½É‘•È¹Íåµ‰½°ñð½É‘•È¹µ¥¹Ð¹Í±¥” À°€Ø¥ôè€‘í‰ÕåI•ÍÕ±Ð¹•ÉÉ½Éõ€°4(€€€€€€¤ì4(€€€€€€¼¼AÉ½Ñ•Ð½¹±ä•áÁ±¥¥Ð•á•ÕÑ¥½¸½Á½½°™…¥±ÕÉ•Ì¸1½…°ÁÉ¥”µÕ…ÉÉ•©•ÑÌ4(€€€€€€¼¼ÍÁ•¹¹¼™•”…¹‘¼¹½ÐÉ•…Ñ”„ÍÑÉ…Ñ•ä½½±‘½Ý¸¸4(€€€€€½¹ÍÐÁ½½±…¥±ÕÉ”€ô‰ÕåI•ÍÕ±Ð¹Á½½±•…ñð‰ÕåI•ÍÕ±Ð¹Á½½±1½Ý1¥ÅÕ¥‘¥Ñäñð‰ÕåI•ÍÕ±Ð¹Á½½±5¥¹Ñ5¥Íµ…Ñ ì4(€€€€€¥˜€¡‰ÕåI•ÍÕ±Ð¹¡…¥¹…¥±ÕÉ”ñðÁ½½±…¥±ÕÉ”¤ì4(€€€€€€€½¹ÍÐ½½±‘½Ý¹5Ì€ô‰ÕåI•ÍÕ±Ð¹¡…¥¹…¥±ÕÉ”4(€€€€€€€€€€üÁ…ÉÍ•%¹Ð¡ÁÉ½•ÍÌ¹•¹Ø¹	Ue}%1}I	Ue}==1=]9}5Lñð€œàØÐÀÀÀÀÀœ°€ÄÀ¤4(€€€€€€€€€€èÁ…ÉÍ•%¹Ð¡ÁÉ½•ÍÌ¹•¹Ø¹A==1}%1}I	Ue}==1=]9}5Lñð€œàØÐÀÀÀÀÀœ°€ÄÀ¤ì4(€€€€€€€Í¥¹…±¹¥¹”¹}•á¥Ñ½½±‘½Ý¹Ì¹Í•Ð¡½É‘•È¹µ¥¹Ð°…Ñ”¹¹½Ü ¤€¬½½±‘½Ý¹5Ì¤ì4(€€€€€€€½¹Í½±”¹±½œ 4(€€€€€€€€€mµ…¥¹tƒÂ~RH€‘í‰ÕåI•ÍÕ±Ð¹¡…¥¹…¥±ÕÉ”€ü€	Ue}!%9}%1œ€è€A½½°™…¥°ô½½±‘½Ý¸€€¬4(€€€€€€€€€€€€‘í½É‘•È¹Íåµ‰½°ñð½É‘•È¹µ¥¹Ð¹Í±¥” À°€Ø¥ô™½È€‘í5…Ñ ¹É½Õ¹¡½½±‘½Ý¹5Ì€¼€ÌØÀÀÀÀÀ¥õ¡€°4(€€€€€€€€¤ì4(€€€€€ô4(€€€€€É•ÑÕÉ¸ì4(€€€ô4(4(€€€€¼¼ƒžR£žr–º{š"C’ê“’îß–"w–ž/–2X•¹ÑÉå}ÁÉ¥—¾ò#–Ï¦R»’þ»–’4ØÄ‰ÕŸ¾òk’æ/–&7žR ÑÉ¥•Èƒ’îß¾ò$4(€€€€¼¼ØÌ¸ÄÜ¸ÈÄèƒ’æÃ–—žz³¦^ÓžjX€¼Á½½°€¼±¥ÅÕ¥‘¥Ñç¾ò#žR£’ê;’ê/–B;–"šzC–—–rë¢Ò£¦?¾ò$4(€€€½¹ÍÐ•¹ÑÉå‘Ø€ôÑ½­•¹%¹™¼ü¹™‘Ø€üü¹Õ±°ì4(€€€½¹ÍÐ•¹ÑÉå1¥ÅÕ¥‘¥Ñä€ôÑ½­•¹%¹™¼ü¹±¥ÅÕ¥‘¥Ñä€üü¹Õ±°ì4(€€€½¹ÍÐ•¹ÑÉåA½½±M½°€ô½É‘•È¹Á½½±EÕ½Ñ•™Ñ•È€üüÑ½­•¹%¹™¼ü¹±¥ÅÕ¥‘¥Ñä€üü¹Õ±°ì€¼¼‘ÕµÁM¥¹…°¹Á½½±EÕ½Ñ•™Ñ•Èƒšr–ž†¸4(4(€€€€¼¼ØÌ¸ÄÜ¸Ìäèƒ¢º‡žº_¦š[’þ‡–>ß–"Ã’æÃ–—žjžžKšVÃ¾ò#žR£’ê;–n{šÖ/–—–rëš^Ûšrë¾ò$4(€€€±•Ðµ¥¹Ñ•Ñ	ÕåM•Œ€ô¹Õ±°ì4(€€€ÑÉäì4(€€€€€½¹ÍÐ™¥ÉÍÑM¥¹…°€ôÑÉ…‘•1½•È¹‘ˆ¹ÁÉ•Á…É” 4(€€€€€€€€M1P5%8¡ÑÌ¤…ÌÑÌI=4Í¥¹…±Ì]!Iµ¥¹Ð€ô€üœ4(€€€€€€¤¹•Ð¡½É‘•È¹µ¥¹Ð¤ì4(€€€€€¥˜€¡™¥ÉÍÑM¥¹…°€˜˜™¥ÉÍÑM¥¹…°¹ÑÌ¤ì4(€€€€€€€µ¥¹Ñ•Ñ	ÕåM•Œ€ô5…Ñ ¹É½Õ¹ ¡…Ñ”¹¹½Ü ¤€´™¥ÉÍÑM¥¹…°¹ÑÌ¤€¼€ÄÀÀÀ¤ì4(€€€€€ô4(€€€ô…Ñ €¡|¤íô4(4(€€€Á½Í¥Ñ¥½¹5…¹…•È¹É•¥ÍÑ•É=Á•¸¡ì4(€€€€€Á½Í¥Ñ¥½¹%°4(€€€€€µ¥¹Ðè½É‘•È¹µ¥¹Ð°4(€€€€€Íåµ‰½°è½É‘•È¹Íåµ‰½°°4(€€€€€•¹ÑÉåM½°è‰ÕåI•ÍÕ±Ð¹Í½±%¸€üü½É‘•È¹Í¥é•M½°°4(€€€€€•¹ÑÉåAÉ¥”è‰ÕåI•ÍÕ±Ð¹ÁÉ¥”°€€€€€€€€€¼¼ƒžr–º{š"C’ê“’îÜ4(€€€€€Ñ½­•¹µ½Õ¹Ðè‰ÕåI•ÍÕ±Ð¹Ñ½­•¹µ½Õ¹Ð°€€¼¼ƒžr–º{’æÃ–"ÃžjšVÃ¦<4(€€€€€‘ÉåIÕ¸è½¹™¥œ¹Ie}IU8°4(€€€€€Í¥¹…ÑÕÉ”è‰ÕåI•ÍÕ±Ð¹Í¥¹…ÑÕÉ”°4(€€€€€‰Õå••1…µÁ½ÉÑÌè‰ÕåI•ÍÕ±Ð¹ÁÉ¥½É¥Ñå••1…µÁ½ÉÑÌñð€À°€€¼¼ØÌ¸ÐèƒžR£’ê;žr–ºxA¹04(€€€€€‰ÕåM±½Ðè‰ÕåI•ÍÕ±Ð¹‰ÕåM±½Ðñð€À°€€¼¼ØÌ¸ÄÜ¸ÄÄè	Udƒš^Ûžj¦Nû’â(Í±½Ð4(€€€€€‘ÕµÁM±½Ðè½É‘•È¹Í±½Ðñð€À°€€€€€€€€¼¼ØÌ¸ÄÜ¸Ääèƒž‚ã–6WžjÍ±½Ð³žR£’ê;žº\	Udƒ¢B÷¦Nû¦Š–#–ƒ’â¨Í±½Ð4(€€€€€•¹ÑÉå‘Ø°€€€€€€€€€€€€€€€€€€€€€€€€€€¼¼ØÌ¸ÄÜ¸ÈÄèƒ’æÃ–—žz³¦^ÐX4(€€€€€•¹ÑÉåA½½±M½°°€€€€€€€€€€€€€€€€€€€€€€¼¼ØÌ¸ÄÜ¸ÈÄèƒ’æÃ–—žz³¦^ÓšÆƒ–¶@M=04(€€€€€•¹ÑÉå1¥ÅÕ¥‘¥Ñä°€€€€€€€€€€€€€€€€€€€€¼¼ØÌ¸ÄÜ¸ÈÄèƒ’æÃ–—žz³¦^ÓšÖ–*£šœUM4(€€€€€Í•±±½Õ¹ÐÄÁÌè½É‘•È¹}Í•±±½Õ¹ÐÄÁÌñð€Ä°€€€¼¼ØÌ¸ÄÜ¸ÌØèƒ¢þ{ž:¿š.S–n{šÖ,4(€€€€€Ñ½Ñ…±M•±±M½°ÄÁÌè½É‘•È¹}Ñ½Ñ…±M•±±M½°ÄÁÌñð½É‘•È¹Í•±±M½°°€¼¼ØÌ¸ÄÜ¸ÌØèƒ¢þ{ž:¿š.S–n{šÖ,4(€€€€€µ¥¹Ñ•Ñ	ÕåM•Œ°€€€€€€€€€€€€€€€€€€€€€€€€€€€¼¼ØÌ¸ÄÜ¸Ìäèƒ¦š[’þ‡–>ß–"Ã’æÃ–—žžKšVÀ4(€€€€€ÉÍ¥AÉ•ÕµÀè½É‘•È¹ÉÍ¥AÉ•ÕµÀ°€€€€€€€€€€€€€€¼¼ØÌ¸ÄÜ¸Ìàèƒž‚ã–6W–&4IM$ÕÌ4(€€€€€ÉÍ¤ÅÍAÉ•ÕµÀè½É‘•È¹ÉÍ¤ÅÍAÉ•ÕµÀ°€€€€€€€€€€¼¼ØÌ¸ÄÜ¸Ìàèƒž‚ã–6W–&4IM$ÅÌ4(€€€€€ÉÍ¤ÌÁÍAÉ•ÕµÀè½É‘•È¹ÉÍ¤ÌÁÍAÉ•ÕµÀ°€€€€€€€€¼¼ØÌ¸ÄÜ¸ÐÈèƒž‚ã–6W–&4IM$ÌÁÌ4(€€€€€¥Íµ…MÑÉ…Ñ•äè™…±Í”°€€¼¼5É•µ½Ù•4(€€€€€¥Í‘‘=¸è½É‘•È¹}¥Í‘‘=¸ñð™…±Í”°€€€€€€€€€€€€€€€€€¼¼ƒ–*ƒ’îOš‚¢ºÀ4(€€€ô¤ì4(4(4(€€€€¼¼ƒž®/–6Ï–B3š¶”AÉ¥•QÉ…­•Ë¾ò3žR£žr–º{š"C’ê“’îß–h•¹ÑÉä‰…Í•±¥¹”4(€€€€¼¼ƒ¾ò#¦ÿ–7’â/’âž²P1…Í•ÉMÑÉ•…´Ñàƒš:£’â’â«š^Ÿ’îßš‚ó¢ž›–>G–QC¾ò$4(€€€ÁÉ¥•QÉ…­•È¹™½É•M•Ð¡½É‘•È¹µ¥¹Ð°‰ÕåI•ÍÕ±Ð¹ÁÉ¥”¤ì4(4(€€€¥˜€¡‰ÕåI•ÍÕ±Ð¹Í¥¹…ÑÕÉ”¤Í¥¹…±¹¥¹”¹É•¥ÍÑ•É=ÕÉM¥¹…ÑÕÉ”¡‰ÕåI•ÍÕ±Ð¹Í¥¹…ÑÕÉ”¤ì4(€ô¤ì4(4(€Á½Í¥Ñ¥½¹5…¹…•È¹½¸ ½Á•¹•œ°€¡Á½Ì¤€ôø4(€€€Í•ÉÙ•È¹‰É½…‘…ÍÐ¡ìÑåÁ”è€Á½Í¥Ñ¥½¹=Á•¹•œ°Á½Í¥Ñ¥½¸èÁ½Ìô¤°4(€€¤ì4(€Á½Í¥Ñ¥½¹5…¹…•È¹½¸ ±½Í•œ°€¡Á½Ì¤€ôøì(€€€€¼¼MÑ…ÉÐ½½±‘½Ý¸™É½´½¹™¥Éµ•±½Í”¸M•ÅÕ•¹Ñ¥…°…‘µ½¸•á¥ÑÌ•áÑ•¹Ñ¡”4(€€€€¼¼Í…µ”µ¥¹Ð½½±‘½Ý¸™É½´Ñ¡”±…Ñ•ÍÐ½µÁ±•Ñ•Í…±”¸4(€€€Í¥¹…±¹¥¹”¹±…ÍÑQÉ¥•ÉQÌ¹Í•Ð¡Á½Ì¹µ¥¹Ð°…Ñ”¹¹½Ü ¤¤ì4(€€€¥˜€¡½¹™¥œ¹ÍÑÉ…Ñ•ä¹É•‰Õå½½±‘½Ý¹5Ì€ø€À¤ì(€€€€€Í¥¹…±¹¥¹”¹}•á¥Ñ½½±‘½Ý¹Ì¹Í•Ð¡Á½Ì¹µ¥¹Ð°…Ñ”¹¹½Ü ¤€¬½¹™¥œ¹ÍÑÉ…Ñ•ä¹É•‰Õå½½±‘½Ý¹5Ì¤ì(€€€ô(€€€¥˜€¡Á½Ì¹É•µ½Ù•™Ñ•Éá¥Ð€˜˜€…Á½Í¥Ñ¥½¹5…¹…•È¹¡…Í=Á•¹A½Í¥Ñ¥½¸¡Á½Ì¹µ¥¹Ð¤¤ì(€€€€€Ñ½­•¹I•¥ÍÑÉä¹É•µ½Ù•Q½­•¸¡Á½Ì¹µ¥¹Ð¤ì(€€€€€Ñ¥­MÑÉ•…´¹ÕÁ‘…Ñ•MÕ‰ÍÉ¥ÁÑ¥½¸¡Ñ½­•¹I•¥ÍÑÉä¹±¥ÍÑÑ¥Ù” ¤¹µ…À ¡Ñ½­•¸¤€ôøÑ½­•¸¹µ¥¹Ð¤¤ì(€€€€€Í•ÉÙ•È¹‰É½…‘…ÍÐ¡ì(€€€€€€€ÑåÁ”è€Ñ½­•¹I•µ½Ù•œ°(€€€€€€€µ¥¹ÐèÁ½Ì¹µ¥¹Ð°(€€€€€€€É•…Í½¸èÁ½Ì¹•á¥ÑI•…Í½¸°(€€€€€ô¤ì(€€€€€½¹Í½±”¹±½œ (€€€€€€€mµ…¥¹tÉ•µ½Ù•€‘íÁ½Ì¹Íåµ‰½°ñðÁ½Ì¹µ¥¹Ð¹Í±¥” À°€Ø¥ô…™Ñ•È€‘íÁ½Ì¹•á¥ÑI•…Í½¹õ€°(€€€€€€¤ì(€€€ô(€€€Í•ÉÙ•È¹‰É½…‘…ÍÐ¡ìÑåÁ”è€Á½Í¥Ñ¥½¹±½Í•œ°Á½Í¥Ñ¥½¸èÁ½Ìô¤ì(€ô¤ì(4(€€¼¼€ôôôôôôôôôôôôƒ–B¿–*£šr7–*‡–f €ôôôôôôôôôôôô4(€Í•ÉÙ•È¹ÍÑ…ÉÐ ¤ì4(4(€€¼¼€ôôôôôôôôôôôôƒ–B¿–*£–&7¢†—–Á½½°ƒ’þ‡š¿¾ò#–òš¶—–B;–>Ã¾ò$€ôôôôôôôôôôôô4(€¥˜€¡½¹™¥œ¹…ÕÑ½¥±±A½½±Í=¹MÑ…ÉÐ¤ì4(€€€‰…­É½Õ¹‘¥±±A½½±Ì¡Ñ½­•¹I•¥ÍÑÉä¤¹…Ñ  ¡•ÉÈ¤€ôø4(€€€€€½¹Í½±”¹•ÉÉ½È¡mµ…¥¹t‰…­É½Õ¹‘¥±±A½½±Ì•ÉÉ½Èè€‘í•ÉÈ¹µ•ÍÍ…•õ€¤°4(€€€€¤ì4(€ô4(4(€€¼¼€ôôôôôôôôôôôôƒ–B¿–*£šVÃš6»šÖ€ôôôôôôôôôôôô4(€½¹ÍÐ¥¹¥Ñ¥…±5¥¹ÑÌ€ôÑ½­•¹I•¥ÍÑÉä¹±¥ÍÑÑ¥Ù” ¤¹µ…À ¡Ð¤€ôøÐ¹µ¥¹Ð¤ì4(€½¹Í½±”¹±½œ¡mµ…¥¹tÍÑ…ÉÑ¥¹œ1…Í•ÉMÑÉ•…´Ý¥Ñ €‘í¥¹¥Ñ¥…±5¥¹ÑÌ¹±•¹Ñ¡ô¥¹¥Ñ¥…°Ñ½­•¹Í€¤ì4(€…Ý…¥ÐÑ¥­MÑÉ•…´¹ÍÑ…ÉÐ¡¥¹¥Ñ¥…±5¥¹ÑÌ¤ì4(€ÁÕµÁ¥Í½Ù•Éä¹ÍÑ…ÉÐ ¤ì4(4(€€¼¼€ôôôôôôôôôôôôƒ’òc¦n¦–è€ôôôôôôôôôôôô4(€½¹ÍÐÍ¡ÕÑ‘½Ý¸€ô…Íå¹Œ€¡Í¥¹…°¤€ôøì4(€€€½¹Í½±”¹±½œ¡q¹mµ…¥¹t€‘íÍ¥¹…±ôÉ••¥Ù•°Í¡ÕÑÑ¥¹œ‘½Ý¸É…•™Õ±±ä¸¸¹€¤ì4(€€€ÑÉäì4(€€€€€ÁÕµÁ¥Í½Ù•Éä¹ÍÑ½À ¤ì4(€€€€€…Ý…¥ÐÑ¥­MÑÉ•…´¹ÍÑ½À ¤ì4(€€€€€Á½ÍÑá¥ÑQÉ…­•È¹Í¡ÕÑ‘½Ý¸ ¤ì4(€€€€€Á½Í¥Ñ¥½¹5…¹…•È¹ÍÑ½À ¤ì4(€€€€€Ñ½­•¹]…Ñ¡‘½œ¹ÍÑ½À ¤ì4(€€€€€‘ÕµÁ•Ñ•Ñ½È¹Í¡ÕÑ‘½Ý¸€˜˜‘ÕµÁ•Ñ•Ñ½È¹Í¡ÕÑ‘½Ý¸ ¤ì4(€€€€€…±•ÉÑ¡•­•È¹ÍÑ½À ¤ì4(€€€€€µ½¹¥Ñ½È¹ÍÑ½À ¤ì4(€€€€€•á•ÕÑ½È¹ÍÑ½À€˜˜•á•ÕÑ½È¹ÍÑ½À ¤ì4(€€€€€…Ý…¥Ð¹•ÜAÉ½µ¥Í” ¡È¤€ôøÍ•ÑQ¥µ•½ÕÐ¡È°€ÈÀÀ¤¤ì4(€€€ô…Ñ €¡•ÉÈ¤ì4(€€€€€½¹Í½±”¹•ÉÉ½È¡mµ…¥¹tÍ¡ÕÑ‘½Ý¸•ÉÉ½Èè€‘í•ÉÈ¹µ•ÍÍ…•õ€¤ì4(€€€ô4(€€€ÁÉ½•ÍÌ¹•á¥Ð À¤ì4(€ôì4(€ÁÉ½•ÍÌ¹½¸ M%%9Pœ°€ ¤€ôøÍ¡ÕÑ‘½Ý¸ M%%9Pœ¤¤ì4(€ÁÉ½•ÍÌ¹½¸ M%QI4œ°€ ¤€ôøÍ¡ÕÑ‘½Ý¸ M%QI4œ¤¤ì4(4(€ÁÉ½•ÍÌ¹½¸ Õ¹…Õ¡Ñá•ÁÑ¥½¸œ°€¡•ÉÈ¤€ôøì4(€€€¥˜€¡•ÉÈ¹½‘”€ôôô€I%9UMœ¤ì½¹Í½±”¹Ý…É¸ mµ…¥¹tÁ½ÉÐ½¹™±¥Ð°‘…Í¡‰½…É‘¥Í…‰±•€´½¹Ñ¥¹Õ¥¹œœ¤ìÉ•ÑÕÉ¸ìô4(€€€µ½¹¥Ñ½È¹É•½É‘ÉÉ½È µ…¥¸œ°•ÉÈ°ìÁ¡…Í”è€Õ¹…Õ¡Ñá•ÁÑ¥½¸œô¤ì4(€€€µ½¹¥Ñ½È¹¥¹Œ µ…¥¸¹Õ¹…Õ¡Ñá•ÁÑ¥½¹Ìœ°€Ä°€µ…¥¸œ¤ì4(€€€½¹Í½±”¹•ÉÉ½È mµ…¥¹tÕ¹…Õ¡Ñá•ÁÑ¥½¸èœ°•ÉÈ¤ì4(€ô¤ì4(€ÁÉ½•ÍÌ¹½¸ Õ¹¡…¹‘±•‘I•©•Ñ¥½¸œ°€¡É•…Í½¸¤€ôøì4(€€€µ½¹¥Ñ½È¹É•½É‘ÉÉ½È µ…¥¸œ°É•…Í½¸¥¹ÍÑ…¹•½˜ÉÉ½È€üÉ•…Í½¸€è¹•ÜÉÉ½È¡MÑÉ¥¹œ¡É•…Í½¸¤¤°ì4(€€€€€Á¡…Í”è€Õ¹¡…¹‘±•‘I•©•Ñ¥½¸œ°4(€€€ô¤ì4(€€€µ½¹¥Ñ½È¹¥¹Œ µ…¥¸¹Õ¹¡…¹‘±•‘I•©•Ñ¥½¹Ìœ°€Ä°€µ…¥¸œ¤ì4(€€€½¹Í½±”¹•ÉÉ½È mµ…¥¹tÕ¹¡…¹‘±•‘I•©•Ñ¥½¸èœ°É•…Í½¸¤ì4(€ô¤ì4(4(€½¹Í½±”¹±½œ mµ…¥¹tÍÑ…ÉÑÕÀ½µÁ±•Ñ”œ¤ì4(4(€€¼¼ØÌ¸ÈÜèƒ–ºkš^ØÏ–Â?š^Û¢«–*£¦7–B¿¾ò3¦bËš¶ˆIÕÍÐ¹…Ñ¥Ù”ƒžòOš‹šÎšò?–¾ó¢ÐÍ±½Ð…ÀƒšÛ–2X4(€€¼¼ƒ–~ëžêýIMLøÔÔÁ5€ ß’â©IA¢þ{š:”§¾ò0Ï–Â?š^ÛšÎšò?–"ÀøàÀÁ5ƒš^ØÍ±½Ð…Àƒ–ÂÇ–ò–ž/šÛ–2X4(€€¼¼ƒ¦7–B¿–B8É•ÍÑ½É•É½µˆƒš‹–’7š2’îO¾ò3šr'’îOš^Û–îÛ¢þ–"Ãž¦ë’îOš"YIMLøÄÀÀÁ5–7¦7–B¼4(€½¹ÍÐ5a}UAQ%5}5L€ôÁ…ÉÍ•%¹Ð¡ÁÉ½•ÍÌ¹•¹Ø¹5a}UAQ%5}5Lñð€œÄÀàÀÀÀÀÀœ°€ÄÀ¤ì€¼¼ƒ¦îc¢ºÏ–Â?š^Ø4(€½¹ÍÐÍÑ…ÉÑQ¥µ”€ô…Ñ”¹¹½Ü ¤ì4(€Í•Ñ%¹Ñ•ÉÙ…°  ¤€ôøì4(€€€½¹ÍÐÕÁÑ¥µ•5Ì€ô…Ñ”¹¹½Ü ¤€´ÍÑ…ÉÑQ¥µ”ì4(€€€½¹ÍÐÁ½Í½Õ¹Ð€ôÁ½Í¥Ñ¥½¹5…¹…•Èü¹Á½Í¥Ñ¥½¹Ìü¹Í¥é”€üü€Àì4(€€€¥˜€¡ÕÁÑ¥µ•5Ì€ø5a}UAQ%5}5L€˜˜Á½Í½Õ¹Ð€ôôô€À¤ì4(€€€€€½¹Í½±”¹±½œ¡m55tƒÂ~RÕÁÑ¥µ”ô‘í5…Ñ ¹É½Õ¹¡ÕÁÑ¥µ•5Ì¼ØÀÀÀÀ¥õµ¥¸€ø€‘í5…Ñ ¹É½Õ¹¡5a}UAQ%5}5L¼ØÀÀÀÀ¥õµ¥¸ƒ’âSž¦ë’îL°ƒ–ºkš^Û¦7–B¿¦+šRøIÕÍÐ¹…Ñ¥Ù”ƒ––¶a€¤ì4(€€€€€ÁÉ½•ÍÌ¹•á¥Ð À¤ì4(€€€ô•±Í”¥˜€¡ÕÁÑ¥µ•5Ì€ø5a}UAQ%5}5L€˜˜Á½Í½Õ¹Ð€ø€À¤ì4(€€€€€½¹Í½±”¹±½œ¡m55tƒŠ>ÌÕÁÑ¥µ”ô‘í5…Ñ ¹É½Õ¹¡ÕÁÑ¥µ•5Ì¼ØÀÀÀÀ¥õµ¥¸€ø€‘í5…Ñ ¹É½Õ¹¡5a}UAQ%5}5L¼ØÀÀÀÀ¥õµ¥¸ƒ’öšr$€‘íÁ½Í½Õ¹Ñôƒ’â«š2’îL°ƒž¶$IMLƒ¢úû–"Ã¦b#–óš"[ž¦ë’îO–B;¦7–B½€¤ì4(€€€ô4(€ô°€ØÁ|ÀÀÀ¤ì4)ô4(4(¼¨¨4(€¨ƒ–B;–>Ãš&¯š>?š&šr'žòë–’ÄÁ½½°ƒ’þ‡š¿žj’î–â¾ò3¦C’â«¢†—’â+Ž4(€¨ƒ¢*šÖ¾òkš¾?’â¨€ÈÔÁµÏŽ4(€¨¼4)…Íå¹Œ™Õ¹Ñ¥½¸‰…­É½Õ¹‘¥±±A½½±Ì¡Ñ½­•¹I•¥ÍÑÉä¤ì4(€½¹ÍÐÑ…É•ÑÌ€ôÑ½­•¹I•¥ÍÑÉä4(€€€€¹±¥ÍÑ±° ¤4(€€€€¹™¥±Ñ•È ¡Ð¤€ôøÐ¹¥Í}…Ñ¥Ù”€˜˜¹••‘ÍA½½±I•Á…¥È¡Ð¤¤ì4(4(€¥˜€¡Ñ…É•ÑÌ¹±•¹Ñ €ôôô€À¤É•ÑÕÉ¸ì4(€½¹Í½±”¹±½œ¡mµ…¥¹t…ÕÑ¼µ™¥±°Á½½°™½È€‘íÑ…É•ÑÌ¹±•¹Ñ¡ôÑ½­•¹Ì€¡‰…­É½Õ¹¥€¤ì4(4(€½¹ÍÐ™¥¹‘•È€ô¹•ÜA½½±¥¹‘•È¡íô¤ì4(€±•Ð½¬€ô€Àì4(€±•Ð™…¥°€ô€Àì4(4(€™½È€¡½¹ÍÐÐ½˜Ñ…É•ÑÌ¤ì4(€€€ÑÉäì4(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð™¥¹‘•È¹™¥¹‘A½½±½É5¥¹Ð¡Ð¹µ¥¹Ð¤ì4(€€€€€¥˜€¡É•ÍÕ±Ð¤ì4(€€€€€€€Ñ½­•¹I•¥ÍÑÉä¹Í•ÑA½½±%¹™¼¡Ð¹µ¥¹Ð°É•ÍÕ±Ð¤ì4(€€€€€€€½¬€¬ô€Äì4(€€€€€ô•±Í”ì4(€€€€€€€™…¥°€¬ô€Äì4(€€€€€ô4(€€€ô…Ñ €¡•ÉÈ¤ì4(€€€€€™…¥°€¬ô€Äì4(€€€€€½¹Í½±”¹Ý…É¸¡m™¥±°µÁ½½±Ít€‘íÐ¹Íåµ‰½°ñðÐ¹µ¥¹Ð¹Í±¥” À°€Ø¥ôè€‘í•ÉÈ¹µ•ÍÍ…•õ€¤ì4(€€€ô4(€€€…Ý…¥Ð¹•ÜAÉ½µ¥Í” ¡È¤€ôøÍ•ÑQ¥µ•½ÕÐ¡È°€ÈÔÀ¤¤ì4(€ô4(€½¹Í½±”¹±½œ¡mµ…¥¹t…ÕÑ¼µ™¥±°Á½½°‘½¹”è€‘í½­ô=,°€‘í™…¥±ô™…¥±•‘€¤ì4)ô4(4)…Íå¹Œ™Õ¹Ñ¥½¸™¥±±A½½±½ÉQ½­•¸¡Ñ½­•¹I•¥ÍÑÉä°µ¥¹Ð¤ì4(€ÑÉäì4(€€€½¹ÍÐ™¥¹‘•È€ô¹•ÜA½½±¥¹‘•È¡íô¤ì4(€€€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð™¥¹‘•È¹™¥¹‘A½½±½É5¥¹Ð¡µ¥¹Ð¤ì4(€€€¥˜€¡É•ÍÕ±Ð¤ì4(€€€€€Ñ½­•¹I•¥ÍÑÉä¹Í•ÑA½½±%¹™¼¡µ¥¹Ð°É•ÍÕ±Ð¤ì4(€€€€€½¹Í½±”¹±½œ 4(€€€€€€€m™¥±°µÁ½½±Ít€‘íµ¥¹Ð¹Í±¥” À°€Ø¥ôèÁ½½°ô‘íÉ•ÍÕ±Ð¹Á½½±‘‘É•ÍÌ¹Í±¥” À°€Ø¥ô¸¹€°4(€€€€€€¤ì4(€€€ô4(€ô…Ñ €¡•ÉÈ¤ì4(€€€½¹Í½±”¹Ý…É¸¡m™¥±°µÁ½½±Ít€‘íµ¥¹Ð¹Í±¥” À°€Ø¥ôè€‘í•ÉÈ¹µ•ÍÍ…•õ€¤ì4(€ô4)ô4(4)µ…¥¸ ¤¹…Ñ  ¡•ÉÈ¤€ôøì4(€½¹Í½±”¹•ÉÉ½È mµ…¥¹t™…Ñ…°•ÉÉ½Èèœ°•ÉÈ¤ì4(€ÁÉ½•ÍÌ¹•á¥Ð Ä¤ì4)ô¤ì4(4(¼¼ØÌ¸ÌÉˆèƒ–‚–’[––¶cžnGš:œƒŠPƒ–2ë–"¡•…ÀÙÌ•áÑ•É¹…°ÙÌ…ÉÉ…å	Õ™™•ÉÌ4)Í•Ñ%¹Ñ•ÉÙ…°  ¤€ôøì4(€½¹ÍÐ´€ôÁÉ½•ÍÌ¹µ•µ½ÉåUÍ…” ¤ì4(€½¹Í½±”¹±½œ¡m55tÉÍÌô‘ì¡´¹ÉÍÌ¼ÄÀÐàÔÜØ¥ðÁõ5¡•…ÁUÍ•ô‘ì¡´¹¡•…ÁUÍ•¼ÄÀÐàÔÜØ¥ðÁõ5•áÑ•É¹…°ô‘ì¡´¹•áÑ•É¹…°¼ÄÀÐàÔÜØ¥ðÁõ5…ÉÉ…å	Õ™™•ÉÌô‘ì¡´¹…ÉÉ…å	Õ™™•ÉÌ¼ÄÀÐàÔÜØ¥ðÁõ5	€¤ì4)ô°€ÌÀÀÀÀ¤ì4(