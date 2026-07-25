'use strict';

/**
 * Executor (v3.1)
 * ===============
 * ç›´æŽ¥è°ƒç”¨ Pump.fun AMM (PumpSwap) ç¨‹åºï¼Œä¸èµ° Jupiter aggregatorã€‚
 *
 * v3.1 vs v3.0 ä¿®å¤ï¼š
 *   - ä¿®æ­£ SDK APIï¼šæ—§çš„ swapAutocompleteBaseFromQuote/swapInstructions/Direction å·²ç§»é™¤
 *     æ–° API: OnlinePumpAmmSdk.swapSolanaState(poolKey, user) + buyQuoteInput / sellBaseInput
 *   - æ–°å¢ž blockhash é¢„ç¼“å­˜ï¼ˆæ¯ 5s åŽå°åˆ·æ–°ï¼‰ï¼Œä¸‹å•æ—¶ç›´æŽ¥ç”¨ï¼Œçœ ~30ms RPC
 *   - æ–°å¢ž Sell è·¯å¾„å¹¶å‘ï¼šé“¾ä¸Šä½™é¢æŸ¥è¯¢ + swapSolanaState å¹¶è¡Œ
 *
 * SDK è°ƒç”¨æµç¨‹ï¼š
 *   Buy:  OnlinePumpAmmSdk.swapSolanaState(poolKey, user) â†’ state
 *         PumpAmmSdk.buyQuoteInput(state, quoteIn, slippagePct) â†’ ix[]
 *   Sell: OnlinePumpAmmSdk.swapSolanaState(poolKey, user) â†’ state
 *         PumpAmmSdk.sellBaseInput(state, baseIn, slippagePct) â†’ ix[]
 */

const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  SystemProgram,
} = require('@solana/web3.js');
const bs58Lib = require('bs58');
const bs58 = bs58Lib.default || bs58Lib;
const BN = require('bn.js');
const path = require('path');

// v3.25: ATA æŒ‡ä»¤ â€” BUY å‰ç¡®ä¿ ATA å­˜åœ¨
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');
const { estimateBuySlippagePct } = require('./ExecutionMath');
const {
  calculateExactQuoteBuyGuard,
  extractBuyInstructionAmounts,
  replaceBuyWithExactQuoteIn,
  resolveFreshPoolState,
} = require('./BuyExecutionGuard');
const { classifyChainFailure, parseInstructionError } = require('./ChainFailureDiagnostics');

// AllenHark Slipstream SDK (lazy load)
let SlipstreamClient = null;
let slipstreamConfigBuilder = null;
let slipstreamPriorityFeeSpeed = null;
let slipstreamPriorityFeeConfig = null;
try {
  const slipstreamModule = require('@allenhark/slipstream');
  SlipstreamClient = slipstreamModule.SlipstreamClient;
  slipstreamConfigBuilder = slipstreamModule.configBuilder;
  const types = slipstreamModule;
  slipstreamPriorityFeeSpeed = types.PriorityFeeSpeed || null;
  slipstreamPriorityFeeConfig = types.PriorityFeeConfig || null;
} catch (_) {
  // @allenhark/slipstream not installed â€” Slipstream disabled
}

const monitor = getMonitor();
monitor.registerModule('Executor', { staleMs: 24 * 60 * 60_000, label: 'Trade Executor' });

class Executor {
  constructor() {
    this.dryRun = config.DRY_RUN;
    this._latestBuySlot = 0;  // BUY æäº¤æ—¶çš„é“¾ä¸Š slot
    // v3.15 é€šé“åˆ†æµï¼ˆOpenclaw å‘çŽ°ï¼šstaked RPC é™æµä¸¥æ ¼ï¼Œ70 token åˆ·æ–°ä¼šæ‰“çˆ†ï¼‰
    //   - this.rpcï¼šæ™®é€šå…¬å…± RPCï¼ˆç”¨äºŽ PoolStateCache åŽå°åˆ·æ–° + getTransaction / getSignatureStatuses ç­‰æŸ¥è¯¢ï¼‰
    //   - this.stakedRpcï¼šstaked ç«¯ç‚¹ï¼Œ**åªç”¨äºŽ sendTransaction**ï¼ˆä¸å‚ä¸Žç¼“å­˜åˆ·æ–°ï¼‰
    //   - this.senderEndpointï¼šHelius Senderï¼ˆå¸¦ Jito é€šé“ï¼‰
    this.rpc = new Connection(config.helius.rpcUrl, 'confirmed');
    this.stakedRpc = config.helius.stakedRpcUrl
      ? new Connection(config.helius.stakedRpcUrl, 'confirmed')
      : this.rpc;
    // v3.17: å¤š region Sender â€” config.helius.senderEndpoints å·²ç»Ÿä¸€ä¸ºæ•°ç»„
    //   å• endpoint é…ç½®ä¹Ÿä¼šè¢«æ”¶è¿›æ•°ç»„ï¼ˆå‘åŽå…¼å®¹ï¼‰
    //   _submitTx ç”¨ Promise.race å–æœ€å¿«è¿”å›žï¼Œå…¶ä½™ region ä¼šè¢«å¿½ç•¥
    this.senderEndpoints = (config.helius.senderEndpoints || []).slice();
    // ä¿ç•™ senderEndpoint å­—æ®µå…¼å®¹è€ä»£ç å¼•ç”¨ï¼ˆå–æ•°ç»„ç¬¬ä¸€ä¸ªï¼‰
    this.senderEndpoint = this.senderEndpoints[0] || config.helius.senderEndpoint || null;
    if (this.senderEndpoints.length > 1) {
      console.log(
        `[Executor] Helius Sender multi-region enabled: ${this.senderEndpoints.length} endpoints`,
      );
      this.senderEndpoints.forEach((ep) => console.log(`  - ${ep}`));
    } else if (this.senderEndpoint) {
      console.log(`[Executor] Helius Sender single endpoint: ${this.senderEndpoint}`);
    }

    if (!this.dryRun && config.wallet.privateKeyBs58) {
      const secret = bs58.decode(config.wallet.privateKeyBs58);
      this.keypair = Keypair.fromSecretKey(secret);
      console.log(`[Executor] wallet loaded: ${this.keypair.publicKey.toBase58()}`);
    } else {
      this.keypair = null;
    }

    // SDK åœ¨ LIVE æ¨¡å¼æ‰éœ€è¦
    this.pumpSdk = null;       // PumpAmmSdkï¼ˆæŒ‡ä»¤æž„é€ ï¼‰
    this.onlineSdk = null;     // OnlinePumpAmmSdkï¼ˆstate æ‹‰å–ï¼‰ â€” èµ°æ™®é€š RPC
    this.cacheSdk = null;      // v3.15 ç»™ PoolStateCache ç”¨ï¼Œèµ°æ™®é€š RPCï¼ˆä¸Ž onlineSdk å®žä¾‹åˆ†å¼€é¿å…å…±äº« socket pool é™æµï¼‰
    if (!this.dryRun) {
      try {
        const pumpModule = require('@pump-fun/pump-swap-sdk');
        const { PumpAmmSdk, OnlinePumpAmmSdk } = pumpModule;
        if (!PumpAmmSdk || !OnlinePumpAmmSdk) {
          throw new Error('SDK exports missing PumpAmmSdk / OnlinePumpAmmSdk');
        }
        this.pumpSdk = new PumpAmmSdk();
        const sdkPackagePath = path.join(
          path.dirname(require.resolve('@pump-fun/pump-swap-sdk')),
          '..',
          'package.json',
        );
        this.pumpSdkVersion = require(sdkPackagePath).version;
        if (this.pumpSdkVersion !== '1.19.0') {
          throw new Error(`PumpSwap SDK 1.19.0 required, loaded ${this.pumpSdkVersion || 'unknown'}`);
        }
        // v3.15: onlineSdk æ”¹ç”¨ this.rpcï¼ˆæ™®é€šèŠ‚ç‚¹ï¼‰ï¼Œä¸å†èµ° stakedRpc
        // åŽŸå› ï¼šstakedRpcï¼ˆä½ çš„ donetta ä¸“å±žç«¯ç‚¹ï¼‰é™æµä¸¥æ ¼ï¼Œ70 token åˆ·æ–°ä¼šæ‰“çˆ†
        this.onlineSdk = new OnlinePumpAmmSdk(this.rpc);
        // v3.15: cacheSdk ç‹¬ç«‹å®žä¾‹ï¼Œä¸“ç»™ PoolStateCache ç”¨
        // å³ä½¿ onlineSdk å›  BUY çŸ­æ—¶å ç”¨ä¹Ÿä¸å½±å“åŽå°åˆ·æ–°
        this.cacheSdk = new OnlinePumpAmmSdk(this.rpc);
        console.log(
          `[Executor] Pump AMM SDK ${this.pumpSdkVersion} ready ` +
            '(virtual_quote_reserves + buy_exact_quote_in)',
        );
        if (process.env.BUY_MIN_EFFECTIVE_SLIPPAGE_PCT != null) {
          console.warn(
            '[Executor] BUY_MIN_EFFECTIVE_SLIPPAGE_PCT is deprecated and ignored; ' +
              'BUY_MAX_PRICE_DEVIATION_PCT controls the exact-quote output floor',
          );
        }
        console.log('[Executor] Pump AMM SDK loaded (onlineSdk + cacheSdk éƒ½èµ°æ™®é€š RPCï¼ŒstakedRpc ä»…ç”¨äºŽ sendTx)');
      } catch (err) {
        console.error(`[Executor] failed to load @pump-fun/pump-swap-sdk: ${err.message}`);
      }
    }

    this.maxPriorityFeeLamports = config.maxPriorityFeeLamports;
    // v3.17.9 å®žæˆ˜æ ¡æ­£:CU limit 111K â†’ 250K
    //   èƒŒæ™¯:v3.17.8 æŠŠ CU é™åˆ° 111K(å¯¹æ ‡ BABYTROLL slot æŽ’å1çš„ 93kgxYKe)
    //         ä½† openclaw å®žæˆ˜ 5 ç¬” BUY å…¨éƒ¨ ProgramFailedToComplete:
    //           Nigga:    CU limit 150K, consumed 150K â†’ çˆ†
    //           GKC #1:   CU limit 150K, consumed 150K â†’ çˆ†
    //           GKC #2:   CU limit 170K, consumed 170K â†’ çˆ†
    //           CROWDCAM: CU limit 150K, consumed 149,403 â†’ 99.6% å·®ç‚¹çˆ†
    //           BABYTROLL: CU limit 150K, consumed 144,912 â†’ 96.6% å·®ç‚¹çˆ†
    //         æ€»æŸå¤±:5 Ã— 0.04 SOL priority fee = 0.2 SOL ç™½èŠ±,token æ²¡ä¹°åˆ°
    //   çœŸç›¸:Pump swap å®žé™… CU æ¶ˆè€—æœ‰å¾ˆå¤§æ–¹å·®(137K-200K+),ä¸æ˜¯å›ºå®š 111K-150K
    //         BABYTROLL slot é‚£ä¸€æ¬¡ 93kgxYKe ç”¨ 111K æˆåŠŸåªæ˜¯å·§åˆ(é‚£ç¬” swap çŠ¶æ€ç®€å•)
    //         å®žæˆ˜å¿…é¡»è®¾åˆ° 250K ç»™è¶³ä½™é‡,é¿å… BUY_CHAIN_FAILED
    //   ä»£ä»·:CU 250K åŽ Î¼L/CU æŽ’åä¼šä¸‹é™ â†’ éœ€è¦æ‹‰é«˜ priority fee è¡¥å¿
    //         é…åˆ BUY_MIN_PRIORITY_FEE 0.04 â†’ 0.067 SOL,Î¼L/CU ä»ä¸º 267M
    //   ROI ç®—æ³•:æ¯ç¬”å¤šèŠ± 0.027 SOL priority fee æ¯”æ¯ç¬”ç™½èŠ± 0.04 fee åˆæ²¡ä¹°åˆ°åˆ’ç®—å¤ªå¤š
    //   æœªæ¥ä¼˜åŒ–:ä¸åŒä»£å¸ä¸åŒ CU(æ ¹æ®åŽ†å²æ¶ˆè€—è‡ªåŠ¨è°ƒ) â€” å¤æ‚åº¦é«˜,æš‚ä¸åš
    this.computeUnitLimit = parseInt(process.env.COMPUTE_UNIT_LIMIT || '250000', 10);

    // v3.5: é€šè¿‡ setPoolStateCache ç”±å¤–éƒ¨æ³¨å…¥ï¼ˆé¿å…å¾ªçŽ¯ä¾èµ– TokenRegistryï¼‰
    this.poolStateCache = null;

    // v3.17.8 å®žæˆ˜è°ƒä¼˜:Jito tip 0 â†’ 0.003 SOL(3M lamports)
    //   èƒŒæ™¯:BABYTROLL æ•°æ®æ˜¾ç¤º leader æŽ’åºçœ‹ Î¼L/CU,Jito tip ä¸ç®—å…¶ä¸­
    //         é¡¶çº§å¯¹æ‰‹ 93kgxYKe / 3fZftz6m éƒ½æ²¡ç”¨ tip
    //   ä½†ä¿ç•™ 0.003 ä½œä¸º Jito é€šé“æœ€ä½Žå…œåº•:
    //     - Helius Sender èµ° Jito é€šé“éœ€è¦ tip â‰¥ 0.001 SOL(å®žé™…æŽ¨è 0.003 æ›´ç¨³)
    //     - ä¸é… â†’ tx åªèµ° staked validator é€šé“,é”™è¿‡ Jito å• tx æ‹å–æœºä¼š
    //     - é…ä½Ž â†’ åŒé€šé“(staked + Jito),0.003 SOL = å¾®å°æˆæœ¬ä½†ä¿ç•™å¯èƒ½æ€§
    //   ä¸å†åŠ å¤§ tip:å› ä¸º leader æŽ’åºçœ‹ Î¼L/CU,åŠ å¤§ tip ä¸æå‡ slot å†…æŽ’å
    //   8 ä¸ª Jito tip è´¦æˆ·,æ¯ç¬” BUY éšæœºé€‰ä¸€ä¸ª(é¿å…è´¦æˆ·å†™é”ç«žäº‰)
    this.jitoTipLamports = parseInt(process.env.JITO_TIP_LAMPORTS || '1000000', 10);  // v3.17.20: 0.003 â†’ 0.001 SOL
    // v3.16: Helius Sender å®˜æ–¹ tip è´¦æˆ·åˆ—è¡¨ï¼ˆ10 ä¸ªï¼‰
    // âš ï¸ ä¹‹å‰ç”¨çš„ Jito å®˜æ–¹ 8 ä¸ªè´¦æˆ·æ˜¯é”™çš„ â€” Helius Sender æ‹’ç»å®ƒä»¬
    // æ¥æº: https://www.helius.dev/docs/sending-transactions/sender (2026)
    // é”™è¯¯ä¿¡æ¯: "transaction must send a tip of at least 200000 lamports to one of
    //          the following Helius wallets"
    this.jitoTipAccounts = [
      '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
      'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
      '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
      '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
      '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
      '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
      'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
      '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
      '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
      '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
    ];

    // ============ Priority fee oracle ============
    const PriorityFeeOracle = require('../utils/priorityFeeOracle');
    this.feeOracle = new PriorityFeeOracle({ cuLimit: this.computeUnitLimit });
    if (config.priorityFee.dynamic) {
      console.log(
        `[Executor] priority fee: dynamic (BUY=${config.priorityFee.buyLevel}, SELL=${config.priorityFee.sellLevel})`
      );
      console.log(
        `[Executor] BUY range: [${config.priorityFee.buyMinLamports} - ${config.priorityFee.buyCapLamports}] lamports`
      );
      console.log(
        `[Executor] SELL range: [${config.priorityFee.sellMinLamports} - ${config.priorityFee.sellCapLamports}] lamports`
      );
    } else {
      console.log(
        `[Executor] priority fee: static (BUY=${config.priorityFee.buyMaxLamports}, SELL=${config.priorityFee.sellMaxLamports})`
      );
    }

    // ============ Blockhash é¢„ç¼“å­˜ ============
    // æ¯ 5s åŽå°æ‹‰ä¸€æ¬¡ latestBlockhashï¼Œä¸‹å•æ—¶ç›´æŽ¥ç”¨ï¼Œçœ ~30ms RPC
    // Solana blockhash æœ‰æ•ˆæœŸ ~150 ä¸ª slot â‰ˆ 60sï¼Œ5s ç¼“å­˜éžå¸¸å®‰å…¨
    this._cachedBlockhash = null;
    this._cachedBlockhashAt = 0;
    this._blockhashTimer = null;
    if (!this.dryRun) {
      this._startBlockhashCache();
    }

    // ============ AllenHark Slipstream ============
    // leader-proximity-aware äº¤æ˜“ä¸­ç»§ï¼Œè‡ªåŠ¨è·¯ç”±åˆ°ç¦»å½“å‰ leader æœ€è¿‘çš„ sender
    // BUY æ—¶ä¼˜å…ˆèµ° Slipstreamï¼ˆå¤š region + å¤š sender ç«žäº‰ï¼‰ï¼Œå¤±è´¥ fallback Helius Sender + staked RPC
    // SELL ä»èµ° staked RPCï¼ˆä¸éœ€è¦æŠ¢ slotï¼‰
    this.slipstreamClient = null;
    this._slipstreamReady = false;
    this._slipstreamInitAttempted = false;
    if (!this.dryRun && config.allenhark.slipstreamEnabled && config.allenhark.slipstreamApiKey) {
      // å»¶è¿Ÿåˆå§‹åŒ– Slipstreamï¼šç­‰ main å¯åŠ¨å®ŒæˆåŽå†è¿ž
      // SDK å¯èƒ½åœ¨ connect è¿‡ç¨‹ä¸­å°±è§¦å‘ error event å¯¼è‡´æœªæ•èŽ·å¼‚å¸¸
      // å»¶è¿Ÿ + ä¸´æ—¶ uncaught handler ä¿æŠ¤
      setTimeout(() => this._initSlipstream(), 5000);
    } else if (!this.dryRun && config.allenhark.slipstreamEnabled) {
      console.warn('[Executor] Slipstream enabled but no API key (ALLENHARK_SLIPSTREAM_API_KEY) â€” disabled');
    }
  }

  _startBlockhashCache() {
    const refresh = async () => {
      try {
        const t0 = Date.now();
        const bh = await this.rpc.getLatestBlockhash('confirmed');
        this._cachedBlockhash = bh;
        this._cachedBlockhashAt = Date.now();
        monitor.set('Executor.blockhashAgeMs', 0, 'Executor');
        monitor.inc('Executor.blockhashRefreshOk', 1, 'Executor');
      } catch (err) {
        monitor.recordError('Executor', err, { phase: 'blockhash_refresh' });
      }
    };
    // ç«‹å³æ‹‰ä¸€æ¬¡
    refresh();
    // æ¯ 5s åˆ·æ–°
    this._blockhashTimer = setInterval(refresh, 5000);
  }

  /**
   * åˆå§‹åŒ– AllenHark Slipstream å®¢æˆ·ç«¯ã€‚
   *
   * Slipstream ç‰¹æ€§ï¼š
   *   - è‡ªåŠ¨ discovery æ‰¾æœ€è¿‘ workerï¼ˆæŒ‰å»¶è¿ŸæŽ’åï¼‰
   *   - åè®® fallback: QUIC â†’ gRPC â†’ WebSocket â†’ HTTP
   *   - leader-proximity è·¯ç”±ï¼šå®žæ—¶ leader hint æŒ‡å¼• tx åˆ°æœ€è¿‘ sender
   *   - æ¯ç¬” tx æ¶ˆè€— 1 token (0.00005 SOL / 50K lamports)
   *   - æ”¯æŒ broadcast_modeï¼šåŒä¸€ç¬” tx åŒæ—¶å‘å¤šä¸ª region
   */
  async _initSlipstream() {
    if (this._slipstreamInitAttempted) return; // é˜²æ­¢å¹¶å‘åˆå§‹åŒ–
    this._slipstreamInitAttempted = true;
    if (!SlipstreamClient || !slipstreamConfigBuilder) {
      console.error('[Executor:Slipstream] SDK not available â€” @allenhark/slipstream not installed or failed to load');
      return;
    }

    // ä¸´æ—¶ uncaught exception handlerï¼šSlipstream SDK åœ¨ connect() è¿‡ç¨‹ä¸­å¯èƒ½å†…éƒ¨è§¦å‘
    // 'error' eventï¼ˆä¾‹å¦‚ WS è®¤è¯å¤±è´¥ï¼‰ï¼Œæ­¤æ—¶ client è¿˜æ²¡è¿”å›žï¼Œæˆ‘ä»¬çš„ on('error') æ¥ä¸åŠæ³¨å†Œã€‚
    // è¿™ä¸ªä¸´æ—¶ handler ä¼šæ•èŽ·è¿™ç§æƒ…å†µï¼Œ60s åŽè‡ªåŠ¨ç§»é™¤ã€‚
    let slipstreamInitError = null;
    const tempHandler = (err) => {
      if (err && err.message && (err.message.includes('API key') || err.message.includes('SlipstreamError'))) {
        slipstreamInitError = err;
        console.error(`[Executor:Slipstream] caught SDK error during init: ${err.message}`);
        return; // åžæŽ‰ï¼Œä¸è®©è¿›ç¨‹å´©æºƒ
      }
      // å…¶ä»– uncaught exception ä¸åžï¼Œè®©å®ƒèµ°æ­£å¸¸æµç¨‹
      throw err;
    };
    process.on('uncaughtException', tempHandler);
    // 60s åŽç§»é™¤ä¸´æ—¶ handler
    const tempHandlerTimer = setTimeout(() => {
      process.off('uncaughtException', tempHandler);
    }, 60_000);

    try {
      const builder = slipstreamConfigBuilder()
        .apiKey(config.allenhark.slipstreamApiKey);

      // é¦–é€‰ region
      if (config.allenhark.slipstreamRegi×~õÖÚ$z{-®éÜj×&6SÒG¶'W”F–væ÷7F–72æÖ–ä&6TÖ÷VçD÷WE&wÒ°Ð¢÷WGWEFöÆW&æ6SÒG¶wV&BæVffV7F—fU6Æ—vU7BçFôf—†VBƒ"—ÒR°Ð¢f—'GVÅV÷FSÒG¶'W”F–væ÷7F–72çf—'GVÅV÷FU&W6W'fW5&wÒ°Ð¢66†SÒG¶&Vf÷&TvWÒÓâG¶D'V–ÆDvWÕ²G¶'W”F–væ÷7F–72ç7FFU6÷W&6WÕÖÀÐ¢“°Ð Ð¢6öç7BFö¶VäÖ÷VçBÒwV&BæW‡V7FVEFö¶VäÖ÷VçC°Ð¢6öç7B&VÅ&–6RÒwV&BæW‡V7FVE&–6S°Ð¢6öç7BW7F–ÖFVE6Æ—vU7BÒF†—2åöW7F–ÖFT'W•6Æ—vU7B€Ð¢7v7FFRÀÐ¢6—¦U6öÂÀÐ¢Fö¶VäÖ÷VçBÀÐ¢&6TFV6–ÖÇ2ÀÐ¢“°Ð¢–b‚çVÖ&W"æ—4f–æ—FR†W7F–ÖFVE6Æ—vU7B’’°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"æ'W•6Æ—vTW7F–ÖFUVæf–Æ&ÆRrÂÂtW†V7WF÷"r“°Ð¢&WGW&â°Ð¢7V66W73¢fÇ6RÀÐ¢W'&÷#¢vW7F–ÖFVEö'W•÷6Æ—vU÷Væf–Æ&ÆRrÀÐ¢ââæ'W”F–væ÷7F–72ÀÐ¢ÆFVæ7”×3¢FFRææ÷r‚’ÒCÀÐ¢Ó°Ð¢ÐÐ Ð¢òò2âièN˜
8zÛîYÞ8hùKª@Ð¢'W•7FvRÒv'V–ÆE÷G&ç67F–öâs°Ð¢òòc2ã3#¢KÊXZR&6UFö¶Vå&öw&ÒiJþhÈFö¶VâÓ##"[ˆÐ¢6öç7B²6W&–Æ—¦VBÂfVT–æfòÒÒv—BF†—2åö'V–ÆDæE6–våG‚‡7v—‡2Ât%U’rÂ÷&FW"æÖ–çBÂ7v7FFRæ&6UFö¶Vå&öw&Ò“°Ð Ð¢òòc2ãrãC¢K¸î[{.zÛîYÒG‚hùXùnyÉþZéî™;îKˆ¢6–væGW&PÐ¢òò6Æ—7G&VÒzØžKŠÞ{º~‹ùNY¹îy¨B6–rXúþˆ;ÞiŠþXh^˜:‚”NûÈÎKˆÞiŠþ™;îKˆ®yÉþZéâ6–pÐ¢òòXú®iÈžK¸â6W&–Æ—¦VBG‚iÊÎ‹ª¾hùXùny¨Nh˜ÞiŠò6öÆæ™;îKˆ®ˆ;Þiú^X‹y¨@Ð¢òòfW'6–öæVEG&ç67F–öâ[¨þX‰~XÉnjÎ[Èó¢³ÓÖçVÕ÷6–w2†6ö×7B×Sb’Â³âãcUÓ×6–væGW&U³ÐÐ¢6öç7B'3S‚Ò&WV—&R‚v'3S‚r’æFVfVÇC°Ð¢6öç7B&VÅ6–rÒ'3S‚æVæ6öFR‡6W&–Æ—¦VBç6Æ–6RƒÂcR’“°Ð Ð¢6öç7BE6VæCÒFFRææ÷r‚“°Ð¢'W•7FvRÒw7V&Ö—Bs°Ð¢v—BF†—2å÷7V&Ö—EG‚‡6W&–Æ—¦VBÂt%U’r“°Ð¢'W•7FvRÒw7V&Ö—GFVBs°Ð¢6öç7B6VæDÆFVæ7”×2ÒFFRææ÷r‚’ÒE6VæC°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"æ'W•7V66W72rÂÂtW†V7WF÷"r“°Ð Ð¢6öç7B6–rÒ&VÅ6–s²òòyJŽ™;îKˆ®yÉþZéâ6–pÐ¢6öç6öÆRæÆör€Ð¢´W†V7WF÷#¤Ä•dUÒ%U’7V&Ö—GFVC¢G²‡6–rÇÂrr’ç6Æ–6RƒÂ‚—Òââ°Ð¢‡7FFSÒG·7FFTÆFVæ7”×7Ö×5²G¶'W”F–væ÷7F–72ç7FFU6÷W&6WÕÒ'V–ÆCÒG¶'V–ÆDÆFVæ7”×7Ö×26VæCÒG·6VæDÆFVæ7”×7Ö×2F÷FÃÒG°Ð¢FFRææ÷r‚’ÒC Ð¢Ö×2ÂfVSÒG¶fVT–æfòçF÷FÄÆ×÷'G7ÔÂG¶fVT–æfòç6÷W&6WÒ–ÀÐ¢“°Ð Ð¢&WGW&â°Ð¢7V66W73¢G'VRÀÐ¢6–væGW&S¢6–rÀÐ¢Fö¶VäÖ÷VçBÀÐ¢6öÄ–ã¢6—¦U6öÂÀÐ¢&–6S¢&VÅ&–6RÀÐ¢W7F–ÖFVE6Æ—vU7BÀÐ¢ââæ'W”F–væ÷7F–72ÀÐ¢ÆFVæ7”×3¢FFRææ÷r‚’ÒCÀÐ¢7FFTÆFVæ7”×2ÀÐ¢'V–ÆDÆFVæ7”×2ÀÐ¢&–÷&—G”fVTÆ×÷'G3¢fVT–æfòçF÷FÄÆ×÷'G2ÀÐ¢&–÷&—G”fVU6÷W&6S¢fVT–æfòç6÷W&6RÀÐ¢6VæDÆFVæ7”×2ÀÐ¢'W•6Æ÷C¢F†—2åöÆFW7D'W•6Æ÷BÇÂçVÆÂÂòòhùKªNi{ny¨N™;îKˆ¢6Æ÷@Ð¢Ó°Ð¢Ò6F6‚†W'"’°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"æ'W”f–ÂrÂÂtW†V7WF÷"r“°Ð¢Ööæ—F÷"ç&V6÷&DW'&÷"‚tW†V7WF÷"rÂW'"Â°Ð¢6–FS¢t%U’rÀÐ¢Ö–çC¢÷&FW"æÖ–çBÀÐ¢7–Ö&öÃ¢÷&FW"ç7–Ö&öÂÀÐ¢6—¦U6öÂÀÐ¢'W•7FvRÀÐ¢ââæ'W”F–væ÷7F–72ÀÐ¢Ò“°Ð¢6öç6öÆRæW'&÷"†´W†V7WF÷#¤Ä•dUÒ%U’f–ÆVC¢G¶W'"æÖW76vWÖ“°Ð¢&WGW&â°Ð¢7V66W73¢fÇ6RÀÐ¢W'&÷#¢W'"æÖW76vRÀÐ¢6†–äf–ÇW&S¢'W•7FvRÓÓÒw7V&Ö—BrÀÐ¢f–ÇW&U7FvS¢'W•7FvRÀÐ¢ââæ'W”F–væ÷7F–72ÀÐ¢ÆFVæ7”×3¢FFRææ÷r‚’ÒCÀÐ¢Ó°Ð¢ÐÐ¢ÐÐ Ð¢ò¢ Ð¢¢XÙnX{®ûÉ§Fö¶Vâ(i"4ôÎûÈÎY»®Zé¢Fö¶Vâ‹é>XZ^8 Ð¢¢ðÐ¢ò¢ Ð¢¢XÙnX{®ûÉ§Fö¶Vâ(i"4ôÎûÈÎY»®Zé¢Fö¶Vâ‹é>XZ^8 Ð¢¢ðÐ¢7–æ26VÆÂ†÷&FW"’°Ð¢6öç7BCÒFFRææ÷r‚“°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÄGFV×G2rÂÂtW†V7WF÷"r“°Ð¢Ööæ—F÷"æ&VB‚tW†V7WF÷"rÂ6VÆÃ¢G²†÷&FW"æÖ–çBÇÂrr’ç6Æ–6RƒÂb—Ö“°Ð Ð¢6öç7B&6TFV6–ÖÇ2Ò÷&FW"æ&6TFV6–ÖÇ2óòc°Ð¢6öç7BFö¶VäÖ÷VçBÒ÷&FW"çFö¶VäÖ÷VçC°Ð¢6öç7B7W'&VçE&–6RÒ÷&FW"æ7W'&VçE&–6S°Ð Ð¢–b‚çVÖ&W"æ—4f–æ—FR‡Fö¶VäÖ÷VçB’ÇÂFö¶VäÖ÷VçBÃÒ’°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÄf–ÂrÂÂtW†V7WF÷"r“°Ð¢Ööæ—F÷"ç&V6÷&DW'&÷"‚tW†V7WF÷"rÂæWrW'&÷"‚v–çfÆ–BFö¶VäÖ÷VçBr’Â°Ð¢6–FS¢u4TÄÂrÀÐ¢Ö–çC¢÷&FW"æÖ–çBÀÐ¢Fö¶VäÖ÷VçBÀÐ¢Ò“°Ð¢&WGW&â²7V66W73¢fÇ6RÂW'&÷#¢v–çfÆ–BFö¶VäÖ÷VçBrÂÆFVæ7”×3¢FFRææ÷r‚’ÒCÓ°Ð¢ÐÐ Ð¢òòÓÓÓÓÓÓÓÓÓÓÓÒE%•õ%TâÓÓÓÓÓÓÓÓÓÓÓÐÐ¢–b‡F†—2æG'•'Vâ’°Ð¢6öç7Bf–ÆÅ&–6RÒ7W'&VçE&–6R¢ã““S°Ð¢6öç7B6öÄ÷WBÒFö¶VäÖ÷VçB¢f–ÆÅ&–6S°Ð¢6öç6öÆRæÆör€Ð¢´W†V7WF÷#¤E%•õ%TåÒ4TÄÂG¶÷&FW"ç7–Ö&öÂÇÂ÷&FW"æÖ–çBç6Æ–6RƒÂb—Ó¢°Ð¢G·Fö¶VäÖ÷VçBçFôf—†VBƒ"—ÒFö¶Vç2(i"G·6öÄ÷WBçFôf—†VBƒB—Ò4ôÂG¶f–ÆÅ&–6RçFôW‡öæVçF–ÂƒB—ÖÀÐ¢“°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÅ7V66W72rÂÂtW†V7WF÷"r“°Ð¢&WGW&â°Ð¢7V66W73¢G'VRÀÐ¢6–væGW&S¢E%•%Tåõ4TÄÅòG´FFRææ÷r‚—ÖÀÐ¢6öÄ÷WBÀÐ¢&–6S¢f–ÆÅ&–6RÀÐ¢ÆFVæ7”×3¢FFRææ÷r‚’ÒCÀÐ¢G'•'Vã¢G'VRÀÐ¢Ó°Ð¢ÐÐ Ð¢òòÓÓÓÓÓÓÓÓÓÓÓÒÄ•dRÓÓÓÓÓÓÓÓÓÓÓÐÐ¢–b‚F†—2æ¶W——"’°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÄf–ÂrÂÂtW†V7WF÷"r“°Ð¢&WGW&â²7V66W73¢fÇ6RÂW'&÷#¢wvÆÆWBæ÷BÆöFVBrÂÆFVæ7”×3¢FFRææ÷r‚’ÒCÓ°Ð¢ÐÐ¢–b‚F†—2çV×6F²ÇÂF†—2æöæÆ–æU6F²’°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÄf–ÂrÂÂtW†V7WF÷"r“°Ð¢&WGW&â°Ð¢7V66W73¢fÇ6RÀÐ¢W'&÷#¢tV×ÖgVâ÷V××7v×6F²æ÷BÆöFVBrÀÐ¢ÆFVæ7”×3¢FFRææ÷r‚’ÒCÀÐ¢Ó°Ð¢ÐÐ¢–b‚÷&FW"çööÄFG&W72’°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÄf–ÂrÂÂtW†V7WF÷"r“°Ð¢&WGW&â°Ð¢7V66W73¢fÇ6RÀÐ¢W'&÷#¢wööÄFG&W72Ö—76–ærrÀÐ¢ÆFVæ7”×3¢FFRææ÷r‚’ÒCÀÐ¢Ó°Ð¢ÐÐ Ð¢G'’°Ð¢6öç7BööÄ¶W’ÒæWrV&Æ–4¶W’†÷&FW"çööÄFG&W72“°Ð Ð¢òòâööÂ7FFR(	BKÉŽXXŽŠû²ööÅ7FFT66†^ûÈŽhÈK¹>[ˆS×2YîXûX‹~ikûÈžûÈÆ66†RÖ—72h˜Þ‹[%>8 Ð¢òòc2ã3¢XÙnX{®x:Þ‹zþ[èNKˆÞXhÞK‹.KŠNXù%>ûÈŽ™;îKˆ®KÙžš)Ò²7v7FF^ûÈžûÈÎXÙnX{®K¸âãÓ'2™˜ÞX‹XzXØ×>8 Ð¢6öç7BE3ÒFFRææ÷r‚“°Ð¢ÆWB7v7FFRÒçVÆÃ°Ð¢–b‡F†—2çööÅ7FFT66†R’°Ð¢7v7FFRÒF†—2çööÅ7FFT66†RævWB†÷&FW"çööÄFG&W72“°Ð¢ÐÐ¢–b‚7v7FFR’°Ð¢7v7FFRÒv—BF†—2æöæÆ–æU6F²ç7v6öÆæ7FFR‡ööÄ¶W’ÂF†—2æ¶W——"çV&Æ–4¶W’“°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÄ66†TÖ—72rÂÂtW†V7WF÷"r“°Ð¢ÒVÇ6R°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÄ66†T†—BrÂÂtW†V7WF÷"r“°Ð¢ÐÐ¢6öç7B7FFTÆFVæ7”×2ÒFFRææ÷r‚’ÒE3°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç7FFTö²rÂÂtW†V7WF÷"r“°Ð¢Ööæ—F÷"ç6WB‚tW†V7WF÷"æÆ7E7FFTÆFVæ7”×2rÂ7FFTÆFVæ7”×2ÂtW†V7WF÷"r“°Ð Ð¢òò"âc2ã3S¢XÙnX{®i[˜xòÒXZŽ˜:ŽhÈK¹>ûÈŽKˆÞXhÞyY’ãRRKÙž˜xþûÈž8 Ð¢òòZh.iéÎiÈ’66†VDÖ÷VçNûÈŽ™;îKˆ®KÙžš)Þ{É>ZÙŽûÈžyJŽ{É>ZÙŽXÎûÈÎY
nX‰žyJŽhÈK¹>Šë[Ù^y¨BFö¶VäÖ÷VçN8 Ð¢òòÖF‚æfÆö÷"Xë¾hèžkZîx+ž{+î[ªnŠúþ[zîûÈÇ&r–çFVvW"KˆÞKÉ¢–ç7Vff–6–VçBgVæG>8 Ð¢6öç7B6VÆÄÖ÷VçBÒ„çVÖ&W"æ—4f–æ—FR†÷&FW"æ66†VDÖ÷VçB’bb÷&FW"æ66†VDÖ÷VçBâÐ¢ò÷&FW"æ66†VDÖ÷Vç@Ð¢¢Fö¶VäÖ÷VçC°Ð¢6öç7B6VÆÄÖ÷VçE&rÒÖF‚æfÆö÷"‡6VÆÄÖ÷VçB¢ÖF‚ç÷rƒÂ&6TFV6–ÖÇ2’“°Ð¢–b‡6VÆÄÖ÷VçE&rÃÒ’°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÄf–ÂrÂÂtW†V7WF÷"r“°Ð¢&WGW&â°Ð¢7V66W73¢fÇ6RÀÐ¢W'&÷#¢væòöâÖ6†–â&Ææ6RFò6VÆÂrÀÐ¢ÆFVæ7”×3¢FFRææ÷r‚’ÒCÀÐ¢Ó°Ð¢ÐÐ Ð¢6öç7B6VÆÄÖ÷VçD$âÒæWr$â‡6VÆÄÖ÷VçE&r“°Ð¢6öç7B6Æ—vU7BÒ6öæf–rç7G&FVw’ç6VÆÅ6Æ—vT'2ò°Ð Ð¢òò"âièN˜
6VÆÂhÈ~KºNûÈ†&6^(i'V÷FRikžY	ûÈÐ¢6öç7BD#ÒFFRææ÷r‚“°Ð¢6öç7B6VÆÅ&W7VÇBÒv—BF†—2çV×6F²ç6VÆÄ&6T–çWB‡7v7FFRÂ6VÆÄÖ÷VçD$âÂ6Æ—vU7B“°Ð¢6öç7B'V–ÆDÆFVæ7”×2ÒFFRææ÷r‚’ÒD#°Ð Ð¢6öç7B7v—‡2ÒF†—2åöW‡G&7D–ç7G'V7F–öç2‡6VÆÅ&W7VÇB“°Ð¢–b‚7v—‡2ÇÂ7v—‡2æÆVæwF‚ÓÓÒ’°Ð¢F‡&÷ræWrW'&÷"‚u4D²6VÆÄ&6T–çWB&WGW&æVBæò–ç7G'V7F–öç2r“°Ð¢ÐÐ Ð¢òòKËzé~š(NiÉò4ôÂ÷W@Ð¢6öç7BV÷FU&rÒF†—2åöW‡G&7EV÷FTÖ÷VçB‡6VÆÅ&W7VÇBÂ7v7FFRÂ6VÆÄÖ÷VçD$âÂw6VÆÂr“°Ð¢6öç7BW‡V7FVE6öÄ÷WBÒçVÖ&W"‡V÷FU&r’òS“°Ð¢6öç7B&VÅ&–6RÒ6VÆÄÖ÷VçBâòW‡V7FVE6öÄ÷WBò6VÆÄÖ÷VçB¢°Ð Ð¢òò2âièN˜
8zÛîYÞ8hùKª@Ð¢6öç7B²6W&–Æ—¦VBÂfVT–æfòÒÒv—BF†—2åö'V–ÆDæE6–våG‚‡7v—‡2Âu4TÄÂrÂ÷&FW"æÖ–çB“°Ð Ð¢òòc2ãrãC¢K¸î[{.zÛîYÒG‚hùXùnyÉþZéî™;îKˆ¢6–væGW&PÐ¢òòfW'6–öæVEG&ç67F–öâ[¨þX‰~XÉnjÎ[Èó¢³ÓÖçVÕ÷6–w2†6ö×7B×Sb’Â³âãcUÓ×6–væGW&U³ÐÐ¢6öç7B'3S‚Ò&WV—&R‚v'3S‚r’æFVfVÇC°Ð¢6öç7B&VÅ6–rÒ'3S‚æVæ6öFR‡6W&–Æ—¦VBç6Æ–6RƒÂcR’“°Ð Ð¢6öç7BE6VæCÒFFRææ÷r‚“°Ð¢v—BF†—2å÷7V&Ö—EG‚‡6W&–Æ—¦VBÂu4TÄÂr“°Ð¢6öç7B6VæDÆFVæ7”×2ÒFFRææ÷r‚’ÒE6VæC°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÅ7V66W72rÂÂtW†V7WF÷"r“°Ð Ð¢6öç7B6–rÒ&VÅ6–s²òòyJŽ™;îKˆ®yÉþZéâ6–pÐ¢6öç6öÆRæÆör€Ð¢´W†V7WF÷#¤Ä•dUÒ4TÄÂ7V&Ö—GFVC¢G²‡6–rÇÂrr’ç6Æ–6RƒÂ‚—Òââ°Ð¢‡7FFSÒG·7FFTÆFVæ7”×7Ö×2'V–ÆCÒG¶'V–ÆDÆFVæ7”×7Ö×26VæCÒG·6VæDÆFVæ7”×7Ö×2F÷FÃÒG°Ð¢FFRææ÷r‚’ÒC Ð¢Ö×2ÂfVSÒG¶fVT–æfòçF÷FÄÆ×÷'G7ÔÂG¶fVT–æfòç6÷W&6WÒ–ÀÐ¢“°Ð Ð¢&WGW&â°Ð¢7V66W73¢G'VRÀÐ¢6–væGW&S¢6–rÀÐ¢6öÄ÷WC¢W‡V7FVE6öÄ÷WBÀÐ¢&–6S¢&VÅ&–6RÀÐ¢6VÆÄÖ÷VçBÂòòc2ãrãC3¢Zéî™˜^XÙnX{®y¨NKº>[ˆi[ûÈŽXúþˆ;ÒÂFö¶VäÖ÷VçBZh.iéÎ™;îKˆ®KÙžš)ÞKˆÞ‹k>ûÈÐ¢ÆFVæ7”×3¢FFRææ÷r‚’ÒCÀÐ¢7FFTÆFVæ7”×2ÀÐ¢'V–ÆDÆFVæ7”×2ÀÐ¢6VæDÆFVæ7”×2ÀÐ¢&–÷&—G”fVTÆ×÷'G3¢fVT–æfòçF÷FÄÆ×÷'G2ÀÐ¢&–÷&—G”fVU6÷W&6S¢fVT–æfòç6÷W&6RÀÐ¢Ó°Ð¢Ò6F6‚†W'"’°Ð¢Ööæ—F÷"æ–æ2‚tW†V7WF÷"ç6VÆÄf–ÂrÂÂtW†V7WF÷"r“°Ð¢Ööæ—F÷"ç&V6÷&DW'&÷"‚tW†V7WF÷"rÂW'"Â°Ð¢6–FS¢u4TÄÂrÀÐ¢Ö–çC¢÷&FW"æÖ–çBÀÐ¢7–Ö&öÃ¢÷&FW"ç7–Ö&öÂÀÐ¢Fö¶VäÖ÷VçBÀÐ¢Ò“°Ð¢6öç6öÆRæW'&÷"†´W†V7WF÷#¤Ä•dUÒ4TÄÂf–ÆVC¢G¶W'"æÖW76vWÖ“°Ð¢&WGW&â²7V66W73¢fÇ6RÂW'&÷#¢W'"æÖW76vRÂÆFVæ7”×3¢FFRææ÷r‚’ÒCÓ°Ð¢ÐÐ¢ÐÐ Ð¢7–æ2övWE&VÄöæ6†–åFö¶VäÖ÷VçB†Ö–çBÂFV6–ÖÇ2’°Ð¢G'’°Ð¢6öç7B÷væW"ÒF†—2æ¶W——"çV&Æ–4¶W“°Ð¢6öç7B&W7Òv—BF†—2ç'2ævWE'6VEFö¶Vä66÷VçG4'”÷væW"€Ð¢÷væW"ÀÐ¢²Ö–çC¢æWrV&Æ–4¶W’†Ö–çB’ÒÀÐ¢v6öæf—&ÖVBrÀÐ¢“°Ð¢ÆWBF÷FÂÒ°Ð¢f÷"†6öç7B62öb&W7çfÇVR’°Ð¢6öç7BV’Ò62æ66÷VçBæFFç'6VCòæ–æfóòçFö¶VäÖ÷VçCòçV”Ö÷VçC°Ð¢–b‡G—VöbV’ÓÓÒvçVÖ&W"r’F÷FÂ³ÒV“°Ð¢ÐÐ¢&WGW&âF÷FÃ°Ð¢Ò6F6‚†W'"’°Ð¢Ööæ—F÷"ç&V6÷&DW'&÷"‚tW†V7WF÷"rÂW'"Â²†6S¢vöæ6†–åö&Ææ6RrÂÖ–çBÒ“°Ð¢&WGW&â°Ð¢ÐÐ¢ÐÐ Ð¢ò¢ Ð¢¢c2ãrã#¢K¸â7v6öÆæ7FFR‹ùNY¹îy¨B7FFR˜xÎhùXùnkZÙy¨B&6RÖ–çNûÈŽŠ*¾KªNi‰>y¨NKº>[ˆûÈž8 Ð¢ Ð¢¢V×ÖgVâ÷V××7v×6F²y¨B7v6öÆæ7FFR‹ùNY¹î{¹>ièN˜xÎkZÙ‹Jnh‹~Kúhþ˜	®[‹ŽYÊ€Ð¢¢7FFRçööÎûÈŽY
²&6TÖ–çBòV÷FTÖ–çNûÈÎYØ~K‹¢V&Æ–4¶WžûÈž8.KˆÞYÎx˜ŽiÊÎZÙ~jë^Xúþˆ;ÞyZ^iÈž[zî[È.ûÈÀÐ¢¢‹ùž˜xÎX®ZI®‹zþ[èNXYÎ[©^hùXùnûÈÎ{¹þKˆ‹ùNY¹â&6SS‚ZÙ~zÊnK‹.ûÉ¾hùXùnKˆÞX‹‹ùNY¹âçVÆÎûÈŽ‹>yJŽikžKÉ®‹{>‹ø~j
š¨ÎûÈž8 Ð¢ Ð¢¢k:ŽhHþûÉ¥u4ôÂiŠòV÷FRÖ–çNûÈÆ&6RÖ–çBh˜ÞiŠþh‰KºÎŠhK›y¨NKº>[ˆ8 Ð¢¢ðÐ¢öW‡G&7D&6TÖ–çB‡7FFR’°Ð¢–b‚7FFR’&WGW&âçVÆÃ°Ð¢6öç7Bu4ôÂÒ6öæf–rç&öw&×2çw6öÃ°Ð¢6öç7BFõ7G"Ò‡b’Óâ°Ð¢–b‚b’&WGW&âçVÆÃ°Ð¢–b‡G—VöbbÓÓÒw7G&–ærr’&WGW&âc°Ð¢–b‡G—VöbbçFô&6SS‚ÓÓÒvgVæ7F–öâr’&WGW&âbçFô&6SS‚‚“°Ð¢–b‡G—VöbbçFõ7G&–ærÓÓÒvgVæ7F–öâr’°Ð¢6öç7B2ÒbçFõ7G&–ær‚“°Ð¢òò‹ø~kºB¶ö&¦V7Bö&¦V7EÒK˜¾{¾izhHþK˜žXÀÐ¢&WGW&â2bb2æÆVæwF‚ãÒ3"bb2æÆVæwF‚ÃÒCBò2¢çVÆÃ°Ð¢ÐÐ¢&WGW&âçVÆÃ°Ð¢Ó°Ð¢òòX	ž˜ž‹zþ[èNûÈŽhÈžXúþˆ;Þh
~hé.[¨þûÈÐ¢6öç7B6æF–FFW2Ò°Ð¢7FFRæ&6TÖ–çBÀÐ¢7FFRçööÂbb7FFRçööÂæ&6TÖ–çBÀÐ¢7FFRçööÄ&6TÖ–çBÀÐ¢7FFRçööÂbb7FFRçööÂæ&6UöÖ–çBÀÐ¢7FFRçööÅ7FFRbb7FFRçööÅ7FFRæ&6TÖ–çBÀÐ¢Ó°Ð¢f÷"†6öç7B2öb6æF–FFW2’°Ð¢6öç7B2ÒFõ7G"†2“°Ð¢–b‡2bb2ÓÒu4ôÂ’&WGW&â3°Ð¢ÐÐ¢òòXYÎ[©^ûÉ®Zh.iéÎiÈ’&6TÖ–çB÷V÷FTÖ–çBKˆZûžûÈÎhÉKˆÞiŠòu4ôÂy¨N˜*>KŠ Ð¢6öç7B&6U7G"ÒFõ7G"‡7FFRæ&6TÖ–çBÇÂ‡7FFRçööÂbb7FFRçööÂæ&6TÖ–çB’“°Ð¢6öç7BV÷FU7G"ÒFõ7G"‡7FFRçV÷FTÖ–çBÇÂ‡7FFRçööÂbb7FFRçööÂçV÷FTÖ–çB’“°Ð¢–b†&6U7G"bb&6U7G"ÓÒu4ôÂ’&WGW&â&6U7G#°Ð¢–b‡V÷FU7G"bbV÷FU7G"ÓÒu4ôÂ’&WGW&âV÷FU7G#°Ð¢&WGW&âçVÆÃ°Ð¢ÐÐ Ð¢öW7F–ÖFT'W•6Æ—vU7B‡7FFRÂ6—¦U6öÂÂFö¶VäÖ÷VçBÂ&6TFV6–ÖÇ2Òb’°Ð¢&WGW&âW7F–ÖFT'W•6Æ—vU7B‡7FFRÂ6—¦U6öÂÂFö¶VäÖ÷VçBÂ&6TFV6–ÖÇ2“°Ð¢ÐÐ Ð¢ò¢ Ð¢¢4D²KˆÞYÎx˜ŽiÊÎ‹ùNY¹î{¹>ièNKˆÞYÎ8.{¹þKˆZHNynûÉ Ð¢¢Òi[{¸B(i"y»Nhê^iŠò–ç7G'V7F–öç0Ð¢¢ÒZûž‹iÈ’æ–ç7G'V7F–öç2(i"XùnX{ Ð¢¢ÒZûž‹iÈ’æ—‡2(i"XùnX{ Ð¢¢ÒXÙ^KŠ¢–ç7G'V7F–öâZûž‹(i"XÈ^h‰i[{¸@Ð¢¢ðÐ¢öW‡G&7D–ç7G'V7F–öç2‡6Fµ&W7VÇB’°Ð¢–b‚6Fµ&W7VÇB’&WGW&âçVÆÃ°Ð¢–b„'&’æ—4'&’‡6Fµ&W7VÇB’’&WGW&â6Fµ&W7VÇC°Ð¢–b„'&’æ—4'&’‡6Fµ&W7VÇBæ–ç7G'V7F–öç2’’&WGW&â6Fµ&W7VÇBæ–ç7G'V7F–öç3°Ð¢–b„'&’æ—4'&’‡6Fµ&W7VÇBæ—‡2’’&WGW&â6Fµ&W7VÇBæ—‡3°Ð¢–b‡6Fµ&W7VÇBç&öw&Ô–Bbb6Fµ&W7VÇBæ¶W—2’&WGW&â·6Fµ&W7VÇEÓ°Ð¢&WGW&âçVÆÃ°Ð¢ÐÐ Ð¢öW‡G&7D&6TÖ÷VçB‡6Fµ&W7VÇBÂ7FFRÂfÆÆ&6µV÷FT–âÂ6–FR’°Ð¢–b‡6Fµ&W7VÇBbb6Fµ&W7VÇBæ&6R’&WGW&â&–t–çB‡6Fµ&W7VÇBæ&6RçFõ7G&–ær‚’“°Ð¢–b‡6Fµ&W7VÇBbb6Fµ&W7VÇBæ&6TÖ÷VçB’&WGW&â&–t–çB‡6Fµ&W7VÇBæ&6TÖ÷VçBçFõ7G&–ær‚’“°Ð¢–b‡6Fµ&W7VÇBbb6Fµ&W7VÇBçV”&6RÒçVÆÂ’°Ð¢&WGW&â&–t–çB„ÖF‚æfÆö÷"„çVÖ&W"‡6Fµ&W7VÇBçV”&6R’¢Sb’“°Ð¢ÐÐ¢òòfÆÆ&6¾ûÉ®yJ‚6öç7FçB&öGV7BXZÎ[ÈþKËzé~ûÈŽKˆÞ{+îzîûÈÎK¸^yJŽK¨îi‹îzK®ûÈÐ¢G'’°Ð¢6öç7B&6U&W6W'fRÒ&–t–çB‡7FFRçööÄ&6TÖ÷VçBçFõ7G&–ær‚’“°Ð¢–b‡7FFRçööÃòçf—'GVÅV÷FU&W6W'fW2ÓÒçVÆÂ’&WGW&âã°Ð¢6öç7BV÷FU&W6W'fRÒ&–t–çB‡7FFRçööÅV÷FTÖ÷VçBçFõ7G&–ær‚’’°Ð¢&–t–çB‡7FFRçööÂçf—'GVÅV÷FU&W6W'fW2çFõ7G&–ær‚’“°Ð¢6öç7BV÷FT–âÒ&–t–çB†fÆÆ&6µV÷FT–âçFõ7G&–ær‚’“°Ð¢6öç7B²Ò&6U&W6W'fR¢V÷FU&W6W'fS°Ð¢6öç7BæWuV÷FRÒV÷FU&W6W'fR²V÷FT–ã°Ð¢6öç7BæWt&6RÒ²òæWuV÷FS°Ð¢6öç7B&6T÷WBÒ&6U&W6W'fRÒæWt&6S°Ð¢&WGW&â&6T÷WBââò&6T÷WB¢ã°Ð¢Ò6F6‚…ò’°Ð¢&WGW&âã°Ð¢ÐÐ¢ÐÐ Ð¢öW‡G&7EV÷FTÖ÷VçB‡6Fµ&W7VÇBÂ7FFRÂfÆÆ&6´&6T–âÂ6–FR’°Ð¢–b‡6Fµ&W7VÇBbb6Fµ&W7VÇBçV÷FR’&WGW&â&–t–çB‡6Fµ&W7VÇBçV÷FRçFõ7G&–ær‚’“°Ð¢–b‡6Fµ&W7VÇBbb6Fµ&W7VÇBçV÷FTÖ÷VçB’&WGW&â&–t–çB‡6Fµ&W7VÇBçV÷FTÖ÷VçBçFõ7G&–ær‚’“°Ð¢–b‡6Fµ&W7VÇBbb6Fµ&W7VÇBçV•V÷FRÒçVÆÂ’°Ð¢&WGW&â&–t–çB„ÖF‚æfÆö÷"„çVÖ&W"‡6Fµ&W7VÇBçV•V÷FR’¢S’’“°Ð¢ÐÐ¢òòfÆÆ&6°Ð¢G'’°Ð¢6öç7B&6U&W6W'fRÒ&–t–çB‡7FFRçööÄ&6TÖ÷VçBçFõ7G&–ær‚’“°Ð¢–b‡7FFRçööÃòçf—'GVÅV÷FU&W6W'fW2ÓÒçVÆÂ’&WGW&âã°Ð¢6öç7BV÷FU&W6W'fRÒ&–t–çB‡7FFRçööÅV÷FTÖ÷VçBçFõ7G&–ær‚’’°Ð¢&–t–çB‡7FFRçööÂçf—'GVÅV÷FU&W6W'fW2çFõ7G&–ær‚’“°Ð¢6öç7B&6T–âÒ&–t–çB†fÆÆ&6´&6T–âçFõ7G&–ær‚’“°Ð¢6öç7B²Ò&6U&W6W'fR¢V÷FU&W6W'fS°Ð¢6öç7BæWt&6RÒ&6U&W6W'fR²&6T–ã°Ð¢6öç7BæWuV÷FRÒ²òæWt&6S°Ð¢6öç7BV÷FT÷WBÒV÷FU&W6W'fRÒæWuV÷FS°Ð¢&WGW&âV÷FT÷WBââòV÷FT÷WB¢ã°Ð¢Ò6F6‚…ò’°Ð¢&WGW&âã°Ð¢ÐÐ¢ÐÐ§ÐÐ Ð¦ÖöGVÆRæW‡÷'G2ÒW†V7WF÷#°Ð 