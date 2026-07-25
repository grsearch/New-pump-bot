'use strict';

/**
 * PositionManager (v2)
 * ====================
 * ç»´æŠ¤å½“å‰æŒä»“ã€‚æ¯æ¬¡ PriceTracker æ›´æ–°ä»·æ ¼æ—¶æ£€æŸ¥æ˜¯å¦æ­¢ç›ˆ/ç´§æ€¥æ­¢æŸ/è¶…æ—¶ã€‚
 * 100ms tick å…œåº•ï¼Œé˜²æ­¢ä»·æ ¼ä¸æ›´æ–°æ—¶æ— æ³•è§¦å‘è¶…æ—¶é€€å‡ºã€‚
 *
 * å…³é”®ä¿®å¤ï¼ˆv2ï¼‰ï¼š
 *
 * 1. åŒç¡®è®¤æ­¢ç›ˆï¼šè¿ç»­ N æ¬¡ï¼ˆé»˜è®¤ 2ï¼‰æ»¡è¶³ TP æ¡ä»¶ï¼Œä¸”é¦–æ¬¡å’Œæœ€è¿‘ä¸€æ¬¡é—´éš”
 *    >= tpConfirmMinGapMsï¼ˆé»˜è®¤ 300msï¼‰ï¼Œæ‰çœŸæ­£è§¦å‘å–å‡ºã€‚æŒ¡ä½å•æ¬¡ä»·æ ¼æ±¡æŸ“ã€‚
 *
 * 2. ç´§æ€¥æ­¢æŸï¼šè·Œå¹… <= emergencyStopLossPctï¼ˆé»˜è®¤ -15%ï¼‰ç«‹å³å‡ºåœºã€‚
 *    é˜²æ­¢ PRATT/Goblin/COMPUTA é‚£ç§ -97% ç¾éš¾ã€‚
 *
 * 3. PnL ç”¨çœŸå®æˆäº¤ä»·è®¡ç®—ï¼šsellResult.solOut æ¥è‡ªé’±åŒ…çœŸå®ä½™é¢å˜åŒ–ï¼ˆLIVEï¼‰
 *    æˆ– Jupiter quote çš„ outAmountã€‚entry_price æ¥è‡ª BUY çœŸå®æˆäº¤æ¯”ç‡ã€‚
 *    ä¸å†ç”¨"trigger æ—¶çš„ price tracker ä»·æ ¼"åš PnL åˆ†æ¯ã€‚
 *
 * 4. SELL å¤±è´¥æŒ‰æŒ‡æ•°é€€é¿é‡è¯•ï¼Œä¸”é‡è¯•æ—¶ä½¿ç”¨æœ€æ–°ä»·æ ¼åš sanity æ£€æŸ¥
 *
 * 5. registerOpen æ¥å—å¤–éƒ¨ positionIdï¼ˆä¸ BUY trade é…å¯¹ï¼‰
 *
 * 6. restoreFromDb å¯åŠ¨æ—¶æ¢å¤æœªå¹³ä»“æŒä»“
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');
const { priceDetailsFromRawState } = require('../utils/pumpSwapPricing');
const { evaluateFlowTurnExit } = require('./FlowCandleStrategy');
const { normalizeUnixMs } = require('../utils/migrationTime');

const monitor = getMonitor();
monitor.registerModule('PositionManager', { staleMs: 10_000, label: 'Position Manager' });

const SELL_RETRY_DELAYS_MS = [500, 1500, 3000, 5000, 10_000, 20_000]; // ä¹‹åä¿æŒ 30s

const DEDICATED_EXIT_MODES = new Set([
  'AGE3_TRAILING_V7',
  'ONE_SECOND_REBOUND_V8',
]);

function usesDedicatedExitPolicy() {
  return DEDICATED_EXIT_MODES.has(config.strategy.exitMode);
}

class PositionManager extends EventEmitter {
  constructor({ tradeLogger, executor, priceTracker, tokenRegistry, tickStream, postExitTracker }) {
    super();
    this.tradeLogger = tradeLogger;
    this.executor = executor;
    this.priceTracker = priceTracker;
    this.tokenRegistry = tokenRegistry;
    this.tickStream = tickStream;  // v3.17.11: ç”¨äºè¯» latestSlot
    this._recentlyClosed = [];  // v3.30: æœ€è¿‘å¹³ä»“ç¼“å­˜ï¼ˆcooldown ç”¨ï¼‰
    this.postExitTracker = postExitTracker || null; // v3.17.31


    // v3.17.13: åŒå¸å¤šä»“å–å‡ºé˜Ÿåˆ—
    //   åŒä¸€ mint çš„å–å‡ºè¯·æ±‚æ’é˜Ÿï¼Œç­‰ä¸Šä¸€ç¬”ç¡®è®¤åå†å–ä¸‹ä¸€ç¬”
    //   é˜²æ­¢å¤šä»“å¹¶å‘å–å¯¼è‡´æ»‘ç‚¹ä¸å¤Ÿå…¨éƒ¨å¤±è´¥
    this._sellQueues = new Map();    // mint â†’ [{pos, exitPrice}, ...]
    this._sellInProgress = new Set(); // æ­£åœ¨å–å‡ºçš„ mint
    this._tickCount = 0;  // v3.26: tick counter for PoolStateCache price check
    this._flowExitEvents = new Map(); // mint -> recent BUY/SELL swaps while holding
    this._rsiExitSkipLogAt = new Map(); // mint -> { ts, reason }; throttle diagnostic logs

    this.positions = new Map(); // positionId â†’ position obj
    this.byMint = new Map();    // mint â†’ Set<positionId> (v3.17.13: åŒå¸å¤šä»“)

    this.tickTimer = setInterval(() => {
      monitor.beat('PositionManager', 'tick');
      monitor.inc('PositionManager.ticks', 1, 'PositionManager');
      this._tick();
    }, 100);

    // v3.3: é‡è¯• reconciler â€” æ¯ 5 ç§’æ‰«æ DB æ‰¾åˆ°æœŸçš„ pending sell å’Œ stuck position
    // å¤„ç†é‡å¯åœºæ™¯ï¼ˆsetTimeout ä¸¢å¤±ï¼‰+ é•¿æ—¶é—´é”™è¿‡çš„é‡è¯•
    this.reconcilerTimer = setInterval(() => {
      this._reconcileRetries().catch((err) => {
        monitor.recordError('PositionManager', err, { phase: 'reconciler' });
      });
    }, 5000);

    // v3.4: ä¸»åŠ¨æ± å­è½®è¯¢ â€” æŒä»“æœŸé—´æ¯ 500ms æ‹‰ä¸€æ¬¡æ¯ä¸ª token çš„ pool state ç®—ä»·æ ¼
    // ä¿®å¤ï¼šåŸæ¥ PriceTracker åªåœ¨å¤–éƒ¨ç ¸ç›˜äº¤æ˜“è§¦å‘æ—¶æ›´æ–°ï¼›å¾®ç›˜å¸ 15s å†…å¯èƒ½æ²¡æœ‰ä»»ä½• swap
    // â†’ ä»·æ ¼æ°¸è¿œæ˜¯ entryPrice â†’ æ°¸è¿œä¸æ­¢ç›ˆä¹Ÿä¸æ­¢æŸ â†’ å…¨éƒ¨ TIMEOUT å‡ºåœº
    this.poolPollIntervalMs = parseInt(process.env.POOL_POLL_INTERVAL_MS || '500', 10);
    this.poolPollTimer = setInterval(() => {
      this._pollPoolPrices().catch((err) => {
        monitor.recordError('PositionManager', err, { phase: 'pool_poll' });
      });
    }, this.poolPollIntervalMs);

    // v3.23: ä»·æ ¼é‡‡æ · â€” æŒä»“å¸æ¯10ç§’å†™ä¸€æ¡price_samplesï¼Œæé«˜åŒºé—´æ•°æ®è¦†ç›–ç‡
    this._priceSampleLastTs = new Map(); // mint â†’ lastSampleTs
    this._priceSampleIntervalMs = parseInt(process.env.PRICE_SAMPLE_INTERVAL_MS || '10000', 10);

    this.priceTracker.on('update', ({
      mint,
      price,
      ts,
      source,
      rawPrice,
      virtualQuoteReserveSol,
      effectiveQuoteReserveSol,
    }) => {
      const pids = this.byMint.get(mint);

      // ä»·æ ¼é‡‡æ ·ï¼šæŒä»“å¸æ‰é‡‡æ ·ï¼ŒæŒ‰é—´éš”å†™å…¥DB
      if (pids && pids.size > 0 && this.tradeLogger) {
        const now = Date.now();
        const lastTs = this._priceSampleLastTs.get(mint) || 0;
        if (now - lastTs >= this._priceSampleIntervalMs) {
          try {
            this.tradeLogger.savePriceSample(mint, now, price);
            this._priceSampleLastTs.set(mint, now);
          } catch (_) {}
        }
      }

      if (!pids || pids.size === 0) return;
      for (const pid of pids) {
        this._checkExit(pid, price, {
          marketTs: Number(ts) || null,
          source: source || 'price_tick',
          rawPrice: Number(rawPrice) || null,
          virtualQuoteReserveSol: Number(virtualQuoteReserveSol) || 0,
          effectiveQuoteReserveSol: Number(effectiveQuoteReserveSol) || 0,
        });
      }
    });
  }

  stop() {
    clearInterval(this.tickTimer);
    clearInterval(this.reconcilerTimer);
    clearInterval(this.poolPollTimer);
  }

  hasOpenPosition(mint) {
    const pids = this.byMint.get(mint);
    return pids != null && pids.size > 0;
  }

  handleSwapForExit(swap) {
    const s = config.strategy;
    if (!s.flowReversalExitEnabled || !swap || !swap.mint) return;

    const pids = this.byMint.get(swap.mint);
    if (!pids || pids.size === 0) return;

    const side = String(swap.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return;

    const price = Number(swap.price);
    const solVolume = Number(swap.solVolume);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(solVolume) || solVolume <= 0) return;

    const ev = {
      side,
      price,
      solVolume,
      signer: swap.signer || null,
      ts: Number.isFinite(swap.ts) ? swap.ts : Date.now(),
      slot: swap.slot || 0,
      signature: swap.signature || null,
    };

    let events = this._flowExitEvents.get(swap.mint);
    if (!events) {
      events = [];
      this._flowExitEvents.set(swap.mint, events);
    }
    events.push(ev);
    this._pruneFlowExitEvents(swap.mint, ev.ts);

    for (const pid of pids) {
      const pos = this.positions.get(pid);
      if (pos && !pos.exiting && pos.status !== 'stuck') {
        this._maybeFlowReversalExit(pos, price, ev.ts);
      }
    }
  }

  _pruneFlowExitEvents(mint, now) {
    const events = this._flowExitEvents.get(mint);
    if (!events) return;

    const maxWindowMs = 60_000 + 1_000;
    const cutoff = now - maxWindowMs;
    const kept = events.filter((ev) => ev.ts >= cutoff);
    if (kept.length > 0) this._flowExitEvents.set(mint, kept);
    else this._flowExitEvents.delete(mint);
  }

  _recentNetFlow(mint, now, windowMs) {
    const cutoff = now - windowMs;
    const events = this._flowExitEvents.get(mint) || [];
    let netFlow = 0;
    for (const event of events) {
      if (event.ts < cutoff || event.ts > now) continue;
      if (event.side === 'BUY') netFlow += event.solVolume;
      else if (event.side === 'SELL') netFlow -= event.solVolume;
    }
    return netFlow;
  }

  _maybeFlowReversalExit(pos, price, now) {
    const s = config.strategy;
    if (!s.flowReversalExitEnabled) return;
    if (!pos || pos.exiting || pos.status === 'stuck') return;
    if (!pos.reconciled && !pos.dryRun) return;
    if (!Number.isFinite(price) || price <= 0 || !pos.entryPrice || pos.entryPrice <= 0) return;

    const holdStart = pos.reconciledAt || pos.openedAt || now;
    const events = this._flowExitEvents.get(pos.mint) || [];
    const observedSince = events.length > 0 ? Math.max(holdStart, events[0].ts) : holdStart;
    const pattern = evaluateFlowTurnExit(events, now, {
      sinceTs: observedSince,
      requireSellerBreadth: s.flowReversalExitRequireSellerBreadth,
    });
    if (!pattern.matched) return;

    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    console.log(
      `[PositionManager] FLOW_REVERSAL_EXIT ${pos.symbol || pos.mint.slice(0, 6)} ` +
        `mode=FLOW_TURN_15S pnl=${pnlPct.toFixed(2)}% ` +
        `netFlow=${pattern.previousNetFlow.toFixed(2)}->${pattern.currentNetFlow.toFixed(2)}SOL ` +
        `wallets=${pattern.currentUniqueBuyers}B/${pattern.currentUniqueSellers}S`,
    );
    monitor.inc('PositionManager.flowReversalExit', 1, 'PositionManager');
    this._exitForCondition(pos, price, 'FLOW_REVERSAL_EXIT');
  }

  // v3.17.40b: åŠ ä»“ç­–ç•¥ â€” è‡ªæœ€è¿‘ä¸€ç¬”ä¹°å…¥ä»·è·Œ15%ä»¥ä¸Šæ‰å…è®¸åŠ ä»“
  //   é¦–ä»“åï¼šå½“å‰ä»· < é¦–ä»“entryPrice * 0.85 â†’ å…è®¸ç¬¬1æ¬¡åŠ ä»“
  //   ç¬¬1æ¬¡åŠ ä»“åï¼šå½“å‰ä»· < åŠ ä»“entryPrice * 0.85 â†’ å…è®¸ç¬¬2æ¬¡åŠ ä»“
  //   æœ€å¤šåŠ ä»“2æ¬¡ï¼ˆåŒå¸3ä»“ï¼‰
  canAddOn(mint) {
    return { allowed: false, reason: 'addon_removed' };
  }

  /**
   * v3.17.13: è·å–åŒå¸æŒä»“æ•°é‡
   */
  openPositionCountByMint(mint) {
    const pids = this.byMint.get(mint);
    return pids ? pids.size : 0;
  }

  /**
   * v3.17.13: æ·»åŠ  mint â†’ positionId æ˜ å°„ï¼ˆæ”¯æŒåŒå¸å¤šä»“ï¼‰
   */
  _addByMint(mint, positionId) {
    let pids = this.byMint.get(mint);
    if (!pids) {
      pids = new Set();
      this.byMint.set(mint, pids);
    }
    pids.add(positionId);
  }

  /**
   * v3.17.13: ç§»é™¤ mint â†’ positionId æ˜ å°„ï¼ˆSet ä¸ºç©ºæ—¶åˆ é™¤ keyï¼‰
   */
  _removeByMint(mint, positionId) {
    const pids = this.byMint.get(mint);
    if (!pids) return;
    pids.delete(positionId);
    if (pids.size === 0) {
      this.byMint.delete(mint);
      this._flowExitEvents.delete(mint);
      this._rsiExitSkipLogAt.delete(mint);
    }
  }

  /**
   * v3.17.15: å–å‡ºåŒå¸æ‰€æœ‰æŒä»“ï¼ˆRSI è¶…ä¹°ç­‰åœºæ™¯ï¼‰
   * æ‰€æœ‰ä»“ä½æ’é˜Ÿå–å‡ºï¼ˆ_exit å†…éƒ¨æœ‰ sellQueue æœºåˆ¶é˜²å¹¶å‘ï¼‰
   */
  _exitAllByMint(mint, price, reason) {
    const pids = this.byMint.get(mint);
    if (!pids || pids.size === 0) return;
    let count = 0;
    for (const pid of pids) {
      const pos = this.positions.get(pid);
      if (pos && !pos.exiting) {
        count++;
        this._exit(pos, price, reason);
      }
    }
    console.log(
      `[PositionManager] _exitAllByMint ${mint.slice(0, 8)}: triggered ${count} exits (${reason})`,
    );
  }

  /**
   * è‡ªåŠ¨é€€å‡ºæ¡ä»¶ç»Ÿä¸€å…¥å£ã€‚åŒå¸å­˜åœ¨åŠ ä»“æ—¶ï¼Œä»»ä¸€ä»“ä½è§¦å‘éƒ½ä¼šè®©å…¨éƒ¨ä»“ä½
   * è¿›å…¥ç°æœ‰çš„åŒå¸ä¸²è¡Œå–å‡ºé˜Ÿåˆ—ï¼›å•ä»“è¡Œä¸ºä¿æŒä¸å˜ã€‚
   */
  _exitForCondition(pos, price, reason) {
    if (!pos || pos.exiting) return;
    const pids = this.byMint.get(pos.mint);
    if (pids && pids.size > 1) {
      this._exitAllByMint(pos.mint, price, reason);
      return;
    }
    this._exit(pos, price, reason);
  }

  /**
   * æ¯ç¬” swap æ›´æ–° RSI åè°ƒç”¨ã€‚RSI ä½¿ç”¨å½“å‰ 1 åˆ†é’Ÿå®æ—¶å€¼ï¼›ç§»åŠ¨æ­¢ç›ˆä¸€æ—¦
   * åœ¨åŒå¸ä»»ä¸€ä»“ä½ä¸Šæ¿€æ´»ï¼Œä¾¿æ¥ç®¡æ•´ç»„ä»“ä½ï¼Œåç»­ä¸å†èµ° RSI è¶…ä¹°é€€å‡ºã€‚
   */
  _logRsiExitSkip(mint, active, snapshot, reason, details = '') {
    const now = Date.now();
    const last = this._rsiExitSkipLogAt.get(mint);
    const throttleMs = 5000;
    if (last && last.reason === reason && now - last.ts < throttleMs) return;
    this._rsiExitSkipLogAt.set(mint, { ts: now, reason });

    const liveRsi = snapshot?.rsi1mLive == null ? NaN : Number(snapshot.rsi1mLive);
    const closedRsi = snapshot?.rsi1mClosed == null ? NaN : Number(snapshot.rsi1mClosed);
    const bars = Number(snapshot?.rsi1mClosedBars || 0);
    const symbol = active?.[0]?.symbol || mint.slice(0, 6);
    console.log(
      `[PositionManager] RSI_EXIT_SKIPPED ${symbol} ` +
        `live=${Number.isFinite(liveRsi) ? liveRsi.toFixed(1) : 'n/a'} ` +
        `closed=${Number.isFinite(closedRsi) ? closedRsi.toFixed(1) : 'n/a'} ` +
        `bars=${bars} positions=${active?.length || 0} reason=${reason}` +
        `${details ? ` ${details}` : ''}`,
    );
    monitor.inc(`PositionManager.rsi1mExitSkipped.${reason}`, 1, 'PositionManager');
  }

  handleRsiForExit(mint, price, snapshot) {
    return false;
  }

  openPositionCount() {
    return this.positions.size;
  }

  /**
   * v3.17.13: ä» PoolStateCache è·å–ä»£å¸å½“å‰ä»·æ ¼
   *   ç”¨äº PriceTracker æ²¡æœ‰ä»·æ ¼æ—¶çš„ fallback
   */
  _getPoolPrice(mint) {
    try {
      const token = this.tokenRegistry.getToken(mint);
      if (!token || !token.pool_address) return null;
      // PoolStateCache åœ¨ Executor ä¸Š
      const cache = this.executor?.poolStateCache;
      if (!cache) return null;
      const state = cache.get(token.pool_address);
      return this._priceFromState(state, token.decimals || 6);
    } catch (_) {
      return null;
    }
  }

  listOpen() {
    // v3.26: æ’é™¤ stuck ä»“ä½ï¼ˆpoolå·²æ­»/å–ä¸å‡ºï¼Œå•ç‹¬æ˜¾ç¤ºåœ¨ stuck åˆ—è¡¨ï¼‰
    return Array.from(this.positions.values()).filter(p => p.status !== 'stuck');
  }

  /**
   * v3.29: æŸ¥è¯¢æŒ‡å®š mint æœ€è¿‘ N ms å†…å¹³ä»“çš„è®°å½•ï¼ˆç”¨äº EMA å†·å´åˆ¤æ–­ï¼‰
   */
  listRecentlyClosed(mint, withinMs) {
    const cutoff = Date.now() - withinMs;
    const results = [];
    // å…ˆæŸ¥å†…å­˜ç¼“å­˜
    if (this._recentlyClosed) {
      for (const pos of this._recentlyClosed) {
        if (pos.mint === mint && pos.closed_at && pos.closed_at >= cutoff) {
          results.push(pos);
        }
      }
    }
    // å§‹ç»ˆæŸ¥ DBï¼ˆé˜²æ­¢å†…å­˜ç¼“å­˜ä¸å®Œæ•´ï¼Œç‰¹åˆ«æ˜¯åœ¨é‡å¯åï¼‰
    if (this.tradeLogger) {
      try {
        const rows = this.tradeLogger.db.prepare(
          'SELECT * FROM positions WHERE mint = ? AND status = ? AND closed_at >= ? ORDER BY closed_at DESC LIMIT 10'
        ).all(mint, 'closed', cutoff);
        // åˆå¹¶å»é‡
        for (const row of rows) {
          if (!results.some(r => r.position_id === row.position_id)) {
            results.push(row);
          }
        }
      } catch (_) {}
    }
    return results;
  }

  /**
   * å¯åŠ¨æ—¶ä» DB æ¢å¤æœªå¹³ä»“çš„æŒä»“ã€‚
   * å¯¹æ¯ä¸ªæ¢å¤çš„æŒä»“ï¼š
   *   - å¦‚æœ openedAt + maxHoldMs å·²è¿‡ï¼ß¼ÒÚ$z{-®éÜj×öÂçFôf—†VBƒB—Ò4ôÂ‚G·æÅ7BçFôf—†VBƒ"—ÒR–ÀĞ¢“°Ğ Ğ¢F†—2æVÖ—B‚v6Æ÷6VBrÂ°Ğ¢ââç÷2ÀĞ¢W†—E&–6RÀĞ¢W†—E6öÂÀĞ¢æÅ6öÂÀĞ¢æÅ7BÀĞ¢W†—E&V6öã¢f–æÅ&V6öâÀĞ¢w&÷75æÅ6öÃ¢w&÷75æÂÀĞ¢fVU6öÂÀĞ¢Ò“°Ğ Ğ¢òòYÎ[ˆXªK¹>K¹>KØŞYÊŠznXù™‹një^[{.{¸ş{¹şKˆ‹ù¾XZ^K‹.ŠÎXÙnX{®™‰şX‰~ûÈÎ‹ù˜xÎXú®ZèÎh‰[Ù>X˜ŞK¹>KØŞ{¹>zé~8 Ğ¢ĞĞ Ğ¢÷66†VGVÆU&WG'”÷%7GV6²‡÷2ÂG&–vvW%&–6RÂW'$×6r’°Ğ¢Ööæ—F÷"æ–æ2‚u÷6—F–öäÖævW"ç6VÆÅ&WG&–W2rÂÂu÷6—F–öäÖævW"r“°Ğ Ğ¢òòc2ãrãC¢Zh.iéÎ™IŠúşiŠò7W7FöÓ£cS2h‰b7W7FöÓ£„–ç7Vff–6–VçBFö¶Vç2ûÈÎŠûNiˆîKº>[ˆ[{.Š*¾X[nK¹nK¹>KØŞXÙnXXĞ¢òòKˆŞXhÒ&WG'ûÈÎy»Nhê^X[>™zŞ˜şXXŞz›®‹ÚÂ"jÊĞ¢òòc2ãrãC²†÷Ff—ƒ¢¥4ôâW'&÷"f÷&ÖB—2²$7W7FöÒ#£Òæ÷B7W7FöÓ£Ğ¢òò×W7BÖF6‚&÷F‚¥4ôâ×V÷FVB$7W7FöÒ#£æBÆ–â7W7FöÓ£Ğ¢6öç7B†5Fö¶VävöæScS2ÒW'$×6rbb†W'$×6ræ–æ6ÇVFW2‚t7W7FöÓ£cS2r’ÇÂW'$×6ræ–æ6ÇVFW2‚t7W7FöÒ#£cS2r’“°Ğ¢6öç7B†5Fö¶VävöæSÒW'$×6rbb†W'$×6ræ–æ6ÇVFW2‚t7W7FöÓ£Òr’ÇÂW'$×6ræ–æ6ÇVFW2‚t7W7FöÒ#£Òr’“°Ğ¢–b††5Fö¶VävöæScS2ÇÂ†5Fö¶VävöæS’°Ğ¢Ööæ—F÷"æ–æ2‚u÷6—F–öäÖævW"ç6VÆÄ&æFöæVE÷Fö¶VävöæRrÂÂu÷6—F–öäÖævW"r“°Ğ¢6öç7BW'%G—RÒ†5Fö¶VävöæScS2òt7W7FöÓ£cS2r¢t7W7FöÓ£s°Ğ¢6öç6öÆRçv&â€Ğ¢µ÷6—F–öäÖævW%Ò	ùª²4TÄÂ&æFöæVBG·÷2ç7–Ö&öÂÇÂ÷2æÖ–çBç6Æ–6RƒÂb—Ó¢°Ğ¢G¶W'%G—WÒ‡Fö¶Vâ&Ææ6R’(	BÆ–¶VÇ’6öÆB'’æ÷F†W"÷6—F–öâÂf÷&6R6Æ÷6–ævÀĞ¢“°Ğ¢F†—2çG&FTÆövvW"æ6Æ÷6U÷6—F–öâ‡÷2ç÷6—F–öä–BÂ°Ğ¢6Æ÷6VDC¢FFRææ÷r‚’ÀĞ¢W†—E&–6S¢G&–vvW%&–6RÀĞ¢W†—E6öÃ¢ÀĞ¢æÅ6öÃ¢×÷2æVçG'•6öÂÀĞ¢æÅ7C¢ÓÀĞ¢W†—E&V6öã¢÷2æW†—E&V6öâ²uõDô´TåôtôäRrÀĞ¢6VÆÅ6–væGW&S¢÷2åöÆ7E6VÆÅ6–væGW&RÇÂçVÆÂÀĞ¢Ò“°Ğ¢òòc2ã#c¢Dô´TåôtôäR‡'Vr’Yâ#F‚Xk~XÛNûÈÎ™‹.jÚ.{º~{ºŞK›XZ^[Ù.™»n[ˆĞ¢–b‡F†—2ç6–væÄVæv–æRbbF†—2ç6–væÄVæv–æRåöW†—D6ööÆF÷vç2’°Ğ¢6öç7B'Vt6ööÆF÷vä×2Ò'6T–çB‡&ö6W72æVçbå%Tuõ$T%U•ô4ôôÄDõtåôÕ2ÇÂsƒcCrÂ“°Ğ¢F†—2ç6–væÄVæv–æRåöW†—D6ööÆF÷vç2ç6WB‡÷2æÖ–çBÂFFRææ÷r‚’²'Vt6ööÆF÷vä×2“°Ğ¢6öç6öÆRæÆör€Ğ¢µ÷6—F–öäÖævW%Ò	ùI"%Tr6ööÆF÷vâG·÷2ç7–Ö&öÂÇÂ÷2æÖ–çBç6Æ–6RƒÂb—Òf÷"G´ÖF‚ç&÷VæB‡'Vt6ööÆF÷vä×2ò3c—Ö‚‡Fö¶VâvöæRÂæò&V'W’–ÀĞ¢“°Ğ¢ĞĞ¢F†—2ç÷6—F–öç2æFVÆWFR‡÷2ç÷6—F–öä–B“°Ğ¢F†—2å÷&VÖ÷fT'”Ö–çB‡÷2æÖ–çBÂ÷2ç÷6—F–öä–B“°Ğ¢–b‡F†—2æW†V7WF÷#òçööÅ7FFT66†R’F†—2æW†V7WF÷"çööÅ7FFT66†Rç&VÖ÷fT†÷B‡÷2æÖ–çB“°Ğ¢Ööæ—F÷"ç6WB‚u÷6—F–öäÖævW"æ÷Vä6÷VçBrÂF†—2ç÷6—F–öç2ç6—¦RÂu÷6—F–öäÖævW"r“°Ğ¢&WGW&ã°Ğ¢ĞĞ Ğ¢òò˜xŞŠù^Kˆ®™™ûÉ®›¹ŠêB"jÊûÈ…4TÄÅõ$UE%•ôDTÄ•5ôÕ29r.ûÈ8.‹h^‹ø~jr7GV6°Ğ¢6öç7BÔ…õ$UE$”U2Ò4TÄÅõ$UE%•ôDTÄ•5ôÕ2æÆVæwF‚¢#°Ğ¢–b‡÷2ç6VÆÄGFV×G2ãÒÔ…õ$UE$”U2’°Ğ¢Ööæ—F÷"æ–æ2‚u÷6—F–öäÖævW"ç6VÆÅ7GV6²rÂÂu÷6—F–öäÖævW"r“°Ğ¢F†—2çG&FTÆövvW"æÖ&µ7GV6²€Ğ¢÷2ç÷6—F–öä–BÀĞ¢vfRWgFW"G·÷2ç6VÆÄGFV×G7ÒGFV×G3¢G¶W'$×6wÖÀĞ¢“°Ğ¢6öç6öÆRæW'&÷"€Ğ¢µ÷6—F–öäÖævW%Ò)ªûˆò5ET4²G·÷2ç7–Ö&öÂÇÂ÷2æÖ–çBç6Æ–6RƒÂb—Ó¢°Ğ¢G·÷2ç6VÆÄGFV×G7ÒjÊ˜xŞŠù^YØ~ZK‹JR(	BFö¶VâyYYÊ™+XÈ^KŠŞûÈÎ™ÈK«®[z^[›.š(FÀĞ¢“°Ğ¢òòX[>™JîûÉ®KùŞhÈW†—F–æs×G'VR™‹.jÚ"F–6²÷&–6UWFFRXhŞjÊŠznXùöW†—B‹ù¾XZ^iz™™[ê®xêğĞ¢òòK™şKˆŞK¸âF†—2ç÷6—F–öç2XŠ™šNûÉ®KùŞyYKº^Këò&V6öæ6–ÆW"y¹hê~8F6†&ö&Bi‹îzK®ŠÚnY Ğ¢÷2æW†—F–ærÒG'VS°Ğ¢÷2ç7FGW2Òw7GV6²s°Ğ¢&WGW&ã°Ğ¢ĞĞ Ğ¢6öç7BFVÆ”–G‚ÒÖF‚æÖ–â‡÷2ç6VÆÄGFV×G2ÒÂ4TÄÅõ$UE%•ôDTÄ•5ôÕ2æÆVæwF‚Ò“°Ğ¢6öç7BFVÆ’Ò4TÄÅõ$UE%•ôDTÄ•5ôÕ5¶FVÆ”–G…ÒÇÂ3ó°Ğ¢6öç7BæW‡E&WG'”BÒFFRææ÷r‚’²FVÆ“°Ğ Ğ¢òòhÈK˜^XÉnKˆ¾jÊ˜xŞŠù^i{n™{NûÈÎ˜xŞY
şYâ&V6öæ6–ÆW"KÉ®hÈi{nYJN˜i Ğ¢F†—2çG&FTÆövvW"æÖ&µ6VÆÄf–ÆVEVæF–æu&WG'’€Ğ¢÷2ç÷6—F–öä–BÀĞ¢æW‡E&WG'”BÀĞ¢W'$×6rÀĞ¢÷2æW†—E&V6öâÀĞ¢“°Ğ Ğ¢6öç6öÆRçv&â€Ğ¢µ÷6—F–öäÖævW%Ò4TÄÂ&WG'’66†VGVÆVC¢G·÷2ç7–Ö&öÂÇÂ÷2æÖ–çBç6Æ–6RƒÂb—Ò°Ğ¢†GFV×BG·÷2ç6VÆÄGFV×G7ÒòG´Ô…õ$UE$”U7Ò’–âG¶FVÆ—Ö×2(	BG¶W'$×6wÖÀĞ¢“°Ğ Ğ¢6WEF–ÖV÷WB‚‚’Óâ°Ğ¢–b‚F†—2ç÷6—F–öç2æ†2‡÷2ç÷6—F–öä–B’’&WGW&ã°Ğ¢6öç7BÆFW7E&–6RÒF†—2ç&–6UG&6¶W"ævWE&–6R‡÷2æÖ–çB’ÇÂG&–vvW%&–6S°Ğ¢F†—2åöGFV×E6VÆÂ‡÷2ÂÆFW7E&–6R’æ6F6‚‚†W'"’Óâ°Ğ¢Ööæ—F÷"ç&V6÷&DW'&÷"‚u÷6—F–öäÖævW"rÂW'"Â°Ğ¢†6S¢w6VÆÅ÷&WG'•ö7&6‚rÀĞ¢Ö–çC¢÷2æÖ–çBÀĞ¢Ò“°Ğ¢Ò“°Ğ¢ÒÂFVÆ’“°Ğ¢ĞĞ Ğ¢ò¢ Ğ¢¢c2ã2˜xŞŠùR&V6öæ6–ÆW Ğ¢¢ÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓĞĞ¢¢jøòRzy.hš¾Kˆ˜ÒD.ûÈÎh›îX{®h˜iÈ’7FGW3Òw6VÆÅ÷VæF–ærrK‰BæW‡E÷&WG'•öBÃÒæ÷ry¨B÷6—F–öàĞ¢¢‹ùŠhny¹nKŠNzxŞYË®išşûÉ Ğ¢¢â˜xŞY
şYâ6WEF–ÖV÷WBKŠ.ZK(i"h›îY¹îh˜iÈ‹ø~iÉşy¨B&WG'Ğ¢¢"â6öæf—&Õö7–æ2ZK‹J^KØb6WEF–ÖV÷WBK™şiÊ®ŠznXùûÈ†VFvR66^ûÈĞ¢ Ğ¢¢YÎi{nj8iúR6VÆÅö6öæf—&Ö–ærx«nhûÉ®Zh.iéÎiÈYîKˆjÊhùKªN‹h^‹ør32‹ùYÊ‚6VÆÅö6öæf—&Ö–æ~ûÈÀĞ¢¢K‹¾Xª‹>KˆjÊ6öæf—&ÕGûÈÎk*zîŠêN[ŠznXù˜xŞŠù^8 Ğ¢¢ğĞ¢ò¢ Ğ¢¢c2ãBK‹¾Xª‹ÚîŠú.hÈK¹2Fö¶Vây¨BööÂ7FF^ûÈÎzé~X{®[Ù>X˜ŞZéîi{nK»~jÎ8 Ğ¢¢KúîZHÒD”ÔTõUBK‹¾ZûÎ™zîš)ûÉ®[êîy¹[ˆW2Xh^Xúşˆ;Şk*iÈK»¾KÙ^ZIn˜:‚7v(i"&–6UG&6¶W"k‹ùÎKˆŞi»Nik Ğ¢¢(i"k‹ùÎKˆŞŠznXùjÚ.y¸jÚ.hÙò(i"XZ˜:[Ë®[›>8 Ğ¢ Ğ¢¢ZéîxëûÉ®yJ‚W†V7WF÷"y¨BöæÆ–æU6F²y»Nhê^h¸’ööÂ7FF^ûÈÎK¸â&W6W'fW2zérÖ–B&–6^8 Ğ¢¢š)xè~ûÉ®jøòööÅöÆÄ–çFW'fÄ×2›¹ŠêBS×2Ğ¢¢K¸^hÈK¹>iÉş™{N‹ÚîŠú.ûÈhÈK¹>K‹®z›®i{nKˆŞXù%>ûÈĞ¢¢ğĞ¢7–æ2÷öÆÅööÅ&–6W2‚’°Ğ¢–b‡F†—2ç÷6—F–öç2ç6—¦RÓÓÒ’&WGW&ã°Ğ¢–b‡F†—2å÷öÆÆ–ær’&WGW&ã²òò™‹.jÚ.Kˆ®Kˆ‹Úî‹ùk*‹yZèÀĞ¢F†—2å÷öÆÆ–ærÒG'VS°Ğ¢G'’°Ğ¢òòiKn™¸nh˜iÈ™ÈŠhiú^y¨B†Ö–çBÂööÄFG&W72’{¸NY€Ğ¢6öç7BVW&–W2ÒµÓ°Ğ¢f÷"†6öç7B÷2öbF†—2ç÷6—F–öç2çfÇVW2‚’’°Ğ¢–b‡÷2æW†—F–ær’6öçF–çVS²òòjÚ>YÊXÙny¨NKˆŞ™ÈŠhXhŞ‹ÚîŠú Ğ¢6öç7BFö¶Vä–æfòÒF†—2çFö¶Vå&Vv—7G'’ævWEFö¶Vâ‡÷2æÖ–çB“°Ğ¢–b‚Fö¶Vä–æfóòçööÅöFG&W72’°Ğ¢òòc2ãrã#s¢Y®ŠÚn(	N(	Nk*iÈ’ööÅöFG&W72y¨NhÈK¹>iŠò.yèîK¹2.ûÈÎKŠNiÚK»~jÎ™;î‹zş˜;ŞYh.KˆŞK¨`Ğ¢–b‚÷2åöæõööÅv&æVB’°Ğ¢6öç6öÆRçv&â€Ğ¢µ÷6—F–öäÖævW%Ò)ªûˆò÷6—F–öâG·÷2ç7–Ö&öÂÇÂ÷2æÖ–çBç6Æ–6RƒÂb—Ò†2æòööÅöFG&W72Â°Ğ¢6¶—–ær&–6RöÆÂ(	BG&–Æ–ær7F÷v–ÆÂäõBv÷&²f÷"F†—2÷6—F–öâÀĞ¢“°Ğ¢÷2åöæõööÅv&æVBÒG'VS°Ğ¢ĞĞ¢6öçF–çVS°Ğ¢ĞĞ¢VW&–W2çW6‚‡²Ö–çC¢÷2æÖ–çBÂööÄFG&W73¢Fö¶Vä–æfòçööÅöFG&W72ÂFV6–ÖÇ3¢Fö¶Vä–æfòæFV6–ÖÇ2óòbÒ“°Ğ¢ĞĞ¢–b‡VW&–W2æÆVæwF‚ÓÓÒ’&WGW&ã°Ğ Ğ¢6öç7BÔ…ô44„UôtUôÕ2Ò²òò{É>ZÙ‹h^‹ørzy.ŠxnK‹®‹ø~iÉşûÈÆfÆÆ&6²X‹%0Ğ Ğ¢òò[›nŠÎh¸ûÈÎKˆŞ™‹¾ZàĞ¢v—B&öÖ—6RæÆÂ€Ğ¢VW&–W2æÖ†7–æ2‡’Óâ°Ğ¢G'’°Ğ¢òòc2ãrã#s¢KÉXXK¸âööÅ7FFT66†RŠû¾{É>ZÙûÈyÈã“"R%>ûÈĞ¢òòKùŞhªC¢66†RÖ—72(i"fÆÆ&6²X‹xëiúR%>ûÈKùŞKØşZûiÊ®‹ù²†÷DÖ–çG2hÈK¹>y¨NXYÎ[©^ûÈĞ¢òòKùŞhªC#¢{É>ZÙZJ®izrƒã2’(i"fÆÆ&6²X‹xëiúR%>ûÈ˜şXXŞ‹ø~iÉşi[hÚî[ÛY8ÒG&–Æ–æ~ûÈĞ¢ÆWB&–6RÒçVÆÃ°¢ÆWB&–6U6÷W&6RÒwööÅ÷öÆÅ÷'2s°¢ÆWB&u&–6RÒçVÆÃ°¢ÆWBf—'GVÅV÷FU&W6W'fU6öÂÒ°¢ÆWBVffV7F—fUV÷FU&W6W'fU6öÂÒ°¢6öç7B66†RÒF†—2æW†V7WF÷#òçööÅ7FFT66†S°¢–b†66†R’°Ğ¢6öç7B66†VE7FFRÒ66†RævWB‡çööÄFG&W72“°Ğ¢6öç7B66†TvRÒ66†RævWDvR‡çööÄFG&W72“°Ğ¢–b†66†VE7FFRbb66†TvRÓÒçVÆÂbb66†TvRÃÒÔ…ô44„UôtUôÕ2’°Ğ¢6öç7B&–6–ærÒ&–6TFWF–Ç4g&öÕ&u7FFR†66†VE7FFRÂæFV6–ÖÇ2“°¢&–6RÒ&–6–æsòæVffV7F—fU&–6RÇÂçVÆÃ°¢&u&–6RÒ&–6–æsòç&u&–6RÇÂçVÆÃ°¢f—'GVÅV÷FU&W6W'fU6öÂÒ&–6–æsòçf—'GVÅV÷FUV’ÇÂ°¢VffV7F—fUV÷FU&W6W'fU6öÂÒ&–6–æsòæVffV7F—fUV÷FUV’ÇÂ°¢&–6U6÷W&6RÒwööÅ÷öÆÅö66†Rs°¢Ööæ—F÷"æ–æ2‚u÷6—F–öäÖævW"çööÅöÆÄ66†T†—BrÂÂu÷6—F–öäÖævW"r“°Ğ¢ĞĞ¢ĞĞ¢òòfÆÆ&6³¢66†RÖ—72h‰n{É>ZÙZJ®izr(i"‹[%0Ğ¢–b‚&–6R’°Ğ¢6öç7B&–6–ærÒv—BF†—2åöfWF6…ööÅ&–6–ær‡çööÄFG&W72ÂæFV6–ÖÇ2“°¢&–6RÒ&–6–æsòæVffV7F—fU&–6RÇÂçVÆÃ°¢&u&–6RÒ&–6–æsòç&u&–6RÇÂçVÆÃ°¢f—'GVÅV÷FU&W6W'fU6öÂÒ&–6–æsòçf—'GVÅV÷FUV’ÇÂ°¢VffV7F—fUV÷FU&W6W'fU6öÂÒ&–6–æsòæVffV7F—fUV÷FUV’ÇÂ°¢Ööæ—F÷"æ–æ2‚u÷6—F–öäÖævW"çööÅöÆÅ'4fÆÆ&6²rÂÂu÷6—F–öäÖævW"r“°Ğ¢ĞĞ¢–b‡&–6Rbb&–6Râ’°Ğ¢F†—2ç&–6UG&6¶W"çWFFR‡æÖ–çBÂ&–6RÂFFRææ÷r‚’ÂçööÄFG&W72Â°¢6÷W&6S¢&–6U6÷W&6RÀ¢&u&–6RÀ¢f—'GVÅV÷FU&W6W'fU6öÂÀ¢VffV7F—fUV÷FU&W6W'fU6öÂÀ¢Ò“°¢Ööæ—F÷"æ–æ2‚u÷6—F–öäÖævW"çööÅöÆÄö²rÂÂu÷6—F–öäÖævW"r“°Ğ¢òòy»Nhê^j8iú^˜X{®ûÈÎKˆŞzØ’&–6UG&6¶W"K¨¾K»b(	BXxş[	[»n‹ùğĞ¢6öç7B–G2ÒF†—2æ'”Ö–çBævWB‡æÖ–çB“°Ğ¢–b‡–G2’°Ğ¢f÷"†6öç7B–Böb–G2’°Ğ¢F†—2åö6†V6´W†—B‡–BÂ&–6RÂ°¢6÷W&6S¢&–6U6÷W&6RÀ¢&u&–6RÀ¢f—'GVÅV÷FU&W6W'fU6öÂÀ¢VffV7F—fUV÷FU&W6W'fU6öÂÀ¢Ò“°¢ĞĞ¢ĞĞ¢ĞĞ¢Ò6F6‚†W'"’°Ğ¢Ööæ—F÷"æ–æ2‚u÷6—F–öäÖævW"çööÅöÆÄf–ÂrÂÂu÷6—F–öäÖævW"r“°Ğ¢ĞĞ¢Ò’ÀĞ¢“°Ğ¢Òf–æÆÇ’°Ğ¢F†—2å÷öÆÆ–ærÒfÇ6S°Ğ¢ĞĞ¢ĞĞ Ğ¢ò¢ Ğ¢¢c2ãrã#s¢K¸âööÅ7FFT66†Ry¨B7FFRzé~K»~jÎûÈ{ªşXh^ZÙûÈÎ™»b%>ûÈĞ¢¢ğĞ¢÷&–6Tg&öÕ7FFR‡7FFRÂ&6TFV6–ÖÇ2’°¢&WGW&â&–6TFWF–Ç4g&öÕ&u7FFR‡7FFRÂ&6TFV6–ÖÇ2“òæVffV7F—fU&–6RÇÂçVÆÃ°¢Ğ Ğ¢ò¢ Ğ¢¢K¸âööÂy¨B&W6W'fW2zérÖ–B&–6RÒV÷FU&W6W'fRò&6U&W6W'f^ûÈhÈ’FV6–ÖÇ2‹>i[NûÈĞ¢¢yJ‚W†V7WF÷"[{.Xª‹ÛŞy¨BöæÆ–æU6F¾ûÈ†fÆÆ&6³¢K¸R66†RÖ—72i{n‹>yJûÈĞ¢¢ğĞ¢7–æ2öfWF6…ööÄÖ–E&–6R‡ööÄFG&W72Â&6TFV6–ÖÇ2’°¢&WGW&â†v—BF†—2åöfWF6…ööÅ&–6–ær‡ööÄFG&W72Â&6TFV6–ÖÇ2’“òæVffV7F—fU&–6RÇÂçVÆÃ°¢Ğ ¢7–æ2öfWF6…ööÅ&–6–ær‡ööÄFG&W72Â&6TFV6–ÖÇ2’°¢–b‚F†—2æW†V7WF÷"æöæÆ–æU6F²ÇÂF†—2æW†V7WF÷"æ¶W——"’&WGW&âçVÆÃ°¢6öç7B²V&Æ–4¶W’ÒÒ&WV—&R‚t6öÆæ÷vV#2æ§2r“°Ğ¢6öç7BööÄ¶W’ÒæWrV&Æ–4¶W’‡ööÄFG&W72“°¢6öç7B7FFRÒv—BF†—2æW†V7WF÷"æöæÆ–æU6F²ç7v6öÆæ7FFR‡ööÄ¶W’ÂF†—2æW†V7WF÷"æ¶W——"çV&Æ–4¶W’“°¢&WGW&â&–6TFWF–Ç4g&öÕ&u7FFR‡7FFRÂ&6TFV6–ÖÇ2“°¢Ğ Ğ¢7–æ2÷&V6öæ6–ÆU&WG&–W2‚’°Ğ¢–b‡F†—2å÷&V6öæ6–Æ–ær’&WGW&ã²òò™‹.jÚ.Kˆ®Kˆ‹Úî‹ùk*‹yZèÎûÈÎik‹Úî[Y
şXª€Ğ¢F†—2å÷&V6öæ6–Æ–ærÒG'VS°Ğ¢G'’°Ğ¢v—BF†—2å÷&V6öæ6–ÆU&WG&–W4–ææW"‚“°Ğ¢Òf–æÆÇ’°Ğ¢F†—2å÷&V6öæ6–Æ–ærÒfÇ6S°Ğ¢ĞĞ¢ĞĞ Ğ¢7–æ2÷&V6öæ6–ÆU&WG&–W4–ææW"‚’°Ğ¢6öç7Bæ÷rÒFFRææ÷r‚“°Ğ¢6öç7BGVRÒF†—2çG&FTÆövvW"ævWDGVUVæF–æu&WG&–W2†æ÷r“°Ğ Ğ¢f÷"†6öç7B&÷röbGVR’°Ğ¢6öç7B÷2ÒF†—2ç÷6—F–öç2ævWB‡&÷rç÷6—F–öåö–B“°Ğ¢–b‚÷2’6öçF–çVS²òò[{.Š*¾XŠ™š@Ğ Ğ¢òò‹{>‹ør7GV6²y¨NûÈKˆŞXhŞˆz®Xª˜xŞŠù^ûÈÎzØK«®[z^[›.š(NûÈĞ¢–b‡&÷rç7FGW2ÓÓÒw7GV6²rÇÂ÷2ç7FGW2ÓÓÒw7GV6²r’6öçF–çVS°Ğ Ğ¢òò6VÆÅö6öæf—&Ö–æ~ûÉ®‹ùYÊzØ™;îKˆ®zîŠêNûÉ¾Xú®iÈ’Æ7E÷&WG'•öB[{.{¸ş‹h^‹ør32h˜ŞK‹¾Xª˜xŞŠùPĞ¢–b‡&÷rç7FGW2ÓÓÒw6VÆÅö6öæf—&Ö–ærr’°Ğ¢6öç7BÆ7E&WG'’Ò&÷ræÆ7E÷&WG'•öBÇÂ°Ğ¢–b†æ÷rÒÆ7E&WG'’Â3ó’6öçF–çVS°Ğ Ğ¢òò[{.{¸ò32²k*Xª™ÙûÈÎK‹¾Xª‚6öæf—&ÕG‚KˆjÊĞ¢6öç7B6–rÒ&÷rçVæF–æu÷6VÆÅ÷6–væGW&RÇÂ÷2åöÆ7E6VÆÅ6–væGW&S°Ğ¢–b‡6–r’°Ğ¢6öç7B&W7VÇBÒv—BF†—2æW†V7WF÷"æ6öæf—&ÕG‚‡6–rÂ²F–ÖV÷WD×3¢3ÂöÆÄ–çFW'fÄ×3¢SÒ“°Ğ¢–b‡&W7VÇBæ6öæf—&ÖVB’°Ğ¢Ööæ—F÷"æ–æ2‚u÷6—F–öäÖævW"ç&V6öæ6–ÆW$6öæf—&ÖVBrÂÂu÷6—F–öäÖævW"r“°Ğ Ğ¢òòc2ãrKúîZHÒäÂ'V~ûÉ Ğ¢òòK˜¾X˜ŞyJ‚÷2æVçG'•&–6RKÙÎK‹¢W†—E&–6RXÚKØÒ(i"öf–æÆ—¦U7V66W72˜xÂW†—E6öÀĞ¢òò˜XÉnK‹¢Fö¶VäÖ÷VçB¢VçG'•&–6RÒVçG'•6öÂ(i"XxäÂ(˜‚ÖfVU6öÎûÈŠúşi‹îzK®K¨şhÙşûÈ8 Ğ¢òòxëYÊK¸î™;îKˆ¢fWF6‚yÉşZéâ4ôÂiKnXZ^ûÈÎhÈyÉşZéîh‰KªNK»~Y¹îXi8 Ğ¢ÆWBW†—E&–6RÒ÷2æVçG'•&–6S°Ğ¢ÆWB6öÄ÷WBÒçVÆÃ°Ğ¢G'’°Ğ¢6öç7B7vÒv—BF†—2æW†V7WF÷"æfWF6…G…7v&W7VÇB‡6–rÂ÷2æÖ–çB“°Ğ¢òò4TÄÂy¨B&VÅ6öÄFVÇFiŠşjÚ>i[ûÈ™+XÈR4ôÂZ)îXªûÈûÈÎ™Èâh˜ŞiÈiX€Ğ¢–b‡7vbb7vç&VÅ6öÄFVÇFâbb÷2çFö¶VäÖ÷VçBâ’°Ğ¢6öÄ÷WBÒ7vç&VÅ6öÄFVÇF°Ğ¢W†—E&–6RÒ6öÄ÷WBò÷2çFö¶VäÖ÷VçC°Ğ¢òòYÎi{n{JşXª4TÄÂG‚y¨B&6RfV^ûÈ‡&–÷&—G’fVR[{.XÈ^Y
¾YÊ‚&VÅ6öÄFVÇF˜xÎûÈĞ¢–b‡7væfVRbb÷2å÷&V6öæ6–ÆW%6VÆÄfVT66÷VçFVB’°Ğ¢òò&VÅ6öÄFVÇF[{.{¸şhš>‹ør&–÷&—G’fVR²&6RfV^ûÉ¾‹ù˜xÎKˆŞXhŞXúXª Ğ¢òòûÈ˜şXXŞXøÎ˜xŞhš>XxşûÈĞ¢÷2å÷&V6öæ6–ÆW%6VÆÄfVT66÷VçFVBÒG'VS°Ğ¢ĞĞ¢6öç6öÆRæÆör€Ğ¢µ÷6—F–öäÖævW%Ò	ùHB&V6öæ6–ÆW"f÷VæBÆæFVB6VÆÃ¢G·÷2ç7–Ö&öÂÇÂ÷2æÖ–çBç6Æ–6RƒÂb—ÒÂ°Ğ¢6öÄ÷WCÒG·6öÄ÷WBçFôf—†VBƒB—Ò4ôÂÂW†—E&–6SÒG¶W†—E&–6RçFôW‡öæVçF–ÂƒB—ÖÀĞ¢“°Ğ¢ÒVÇ6R°Ğ¢6öç6öÆRçv&â€Ğ¢µ÷6—F–öäÖævW%Ò	ùHB&V6öæ6–ÆW"f÷VæBÆæFVB6VÆÃ¢G·÷2ç7–Ö&öÂÇÂ÷2æÖ–çBç6Æ–6RƒÂb—ÒÂ°Ğ¢KØbfWF6…G…7v&W7VÇBh»şKˆŞX‹&VÅ6öÄFVÇF(	BfÆÆ&6²yJ‚VçG'•&–6RXÚKØŞûÈ…äÂ[nKˆŞXxnûÈ–ÀĞ¢“°Ğ¢ĞĞ¢Ò6F6‚†W'"’°Ğ¢Ööæ—F÷"ç&V6÷&DW'&÷"‚u÷6—F–öäÖævW"rÂW'"Â°Ğ¢†6S¢w&V6öæ6–ÆW%öfWF6…÷7vrÀĞ¢Ö–çC¢÷2æÖ–çBÀĞ¢6–væGW&S¢6–rÀĞ¢Ò“°Ğ¢ĞĞ Ğ¢F†—2åöf–æÆ—¦U7V66W72‡÷2ÂW†—E&–6RÂ6öÄ÷WBÂ6–rÂçVÆÂ“²òòc2ãrãC3¢&V6öæ6–ÆW"F‚Âæò7GVÅ6VÆÄÖ÷Vç@Ğ¢6öçF–çVS°Ğ¢ĞĞ¢ĞĞ¢òòk*zîŠêNûÈÎŠznXù˜xŞŠùPĞ¢Ööæ—F÷"æ–æ2‚u÷6—F–öäÖævW"ç&V6öæ6–ÆW%&WG&–VBrÂÂu÷6—F–öäÖævW"r“°Ğ¢ĞĞ Ğ¢òò6VÆÅ÷VæF–æ~ûÈiˆîzîzØ[è^˜xŞŠù^ûÈûÉ®y»Nhê^ŠznXùĞ¢6öç7BÆFW7E&–6RÒF†—2ç&–6UG&6¶W"ævWE&–6R‡÷2æÖ–çB’ÇÂ÷2æVçG'•&–6S°Ğ¢6öç6öÆRæÆör€Ğ¢µ÷6—F–öäÖævW%Ò	ùHB&V6öæ6–ÆW"&WG'––ærG·÷2ç7–Ö&öÂÇÂ÷2æÖ–çBç6Æ–6RƒÂb—Ò°Ğ¢‡7FGW3ÒG·&÷rç7FGW7ÒÂGFV×G3ÒG·÷2ç6VÆÄGFV×G7Ò–ÀĞ¢“°Ğ¢òòKˆÒv—NûÈÎŠêZI®KŠ¢&WG'’[›nŠÎûÈKØnYÎKˆ÷2KˆŞKÉ®[›nXùûÈÎYºK‹¢7FGW2ZÙ~jëR²Æö6¾ûÈĞ¢F†—2åöGFV×E6VÆÂ‡÷2ÂÆFW7E&–6R’æ6F6‚‚†W'"’Óâ°Ğ¢Ööæ—F÷"ç&V6÷&DW'&÷"‚u÷6—F–öäÖævW"rÂW'"Â°Ğ¢†6S¢w&V6öæ6–ÆW%÷&WG'’rÀĞ¢Ö–çC¢÷2æÖ–çBÀĞ¢Ò“°Ğ¢Ò“°Ğ¢ĞĞ¢ĞĞ§ĞĞ Ğ¦ÖöGVÆRæW‡÷'G2Ò÷6—F–öäÖævW#°Ğ