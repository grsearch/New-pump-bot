'use strict';

const assert = require('assert');
const {
  BUY_DISCRIMINATOR,
  BUY_EXACT_QUOTE_IN_DISCRIMINATOR,
  buildStreamPostSwapState,
  calculateBuyPriceGuard,
  calculateExactQuoteBuyGuard,
  extractBuyExactQuoteInAmounts,
  extractBuyInstructionAmounts,
  replaceBuyWithExactQuoteIn,
  resolveFreshPoolState,
} = require('../src/core/BuyExecutionGuard');

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

async function main() {
  const packageJson = require('../package.json');
  assert.strictEqual(packageJson.dependencies['@pump-fun/pump-swap-sdk'], '1.19.0');

  const rejected = calculateBuyPriceGuard({
    signalPrice: 1,
    expectedPrice: 1.16,
    maxPriceDeviationPct: 15,
    configuredSlippagePct: 50,
  });
  assert.strictEqual(rejected.allowed, false);
  assert.strictEqual(rejected.reason, 'expected price above signal cap');

  const threePctHigher = calculateBuyPriceGuard({
    signalPrice: 1,
    expectedPrice: 1.03,
    maxPriceDeviationPct: 5,
    configuredSlippagePct: 50,
  });
  assert.strictEqual(threePctHigher.allowed, true);
  closeTo(threePctHigher.effectiveSlippagePct, (1.05 / 1.03 - 1) * 100);

  const configuredWins = calculateBuyPriceGuard({
    signalPrice: 1,
    expectedPrice: 1.03,
    maxPriceDeviationPct: 15,
    configuredSlippagePct: 2,
  });
  assert.strictEqual(configuredWins.effectiveSlippagePct, 2);

  const priceImproved = calculateBuyPriceGuard({
    signalPrice: 1,
    expectedPrice: 0.9,
    maxPriceDeviationPct: 15,
    configuredSlippagePct: 50,
  });
  assert.strictEqual(priceImproved.allowed, true);
  assert.ok(priceImproved.expectedPrice * (1 + priceImproved.effectiveSlippagePct / 100) <= 1.15 + 1e-12);

  const exactGuard = calculateExactQuoteBuyGuard({
    signalPrice: 1,
    spendableQuoteSol: 0.2,
    expectedBaseAmountRaw: 194174n,
    baseDecimals: 6,
    maxPriceDeviationPct: 15,
  });
  assert.strictEqual(exactGuard.allowed, true);
  assert.strictEqual(exactGuard.minBaseAmountOut, 173914n);
  assert.ok(exactGuard.expectedPrice < exactGuard.maxPrice);

  const exactRejected = calculateExactQuoteBuyGuard({
    signalPrice: 1,
    spendableQuoteSol: 0.2,
    expectedBaseAmountRaw: 170000n,
    baseDecimals: 6,
    maxPriceDeviationPct: 15,
  });
  assert.strictEqual(exactRejected.allowed, false);
  assert.strictEqual(exactRejected.reason, 'expected price above signal cap');

  const BN = require('bn.js');
  const streamMetadataState = {
    globalConfig: {},
    poolKey: {},
    poolAccountInfo: { owner: { toBase58: () => 'pump-owner' } },
    pool: { virtualQuoteReserves: new BN('1') },
    baseMint: {},
    baseTokenProgram: {},
  };
  const streamState = buildStreamPostSwapState({
    cachedState: streamMetadataState,
    cacheAgeMs: 20,
    signalSource: 'direct',
    signalPoolBaseAmountRaw: '1000000000000',
    signalPoolQuoteAmountRaw: '100000000000',
    signalVirtualQuoteReservesRaw: '5000000000',
    signalSlot: 500,
    latestStreamSlot: 501,
    signalTs: 1_000,
    nowMs: 1_100,
    maxSignalAgeMs: 300,
    maxSlotGap: 1,
    maxCacheAgeMs: 500,
  });
  assert.strictEqual(streamState.allowed, true);
  assert.strictEqual(streamState.signalAgeMs, 100);
  assert.strictEqual(streamState.slotGap, 1);
  assert.strictEqual(streamState.swapState.poolBaseAmount.toString(), '1000000000000');
  assert.strictEqual(streamState.swapState.poolQuoteAmount.toString(), '100000000000');
  assert.strictEqual(
    streamState.swapState.pool.virtualQuoteReserves.toString(),
    '5000000000',
  );
  assert.strictEqual(streamMetadataState.pool.virtualQuoteReserves.toString(), '1');
  const leadingStreamState = buildStreamPostSwapState({
    cachedState: streamMetadataState,
    cacheAgeMs: 50_000,
    signalSource: 'direct',
    signalPoolBaseAmountRaw: '1000000000000',
    signalPoolQuoteAmountRaw: '100000000000',
    signalVirtualQuoteReservesRaw: '5000000000',
    signalSlot: 500,
    latestStreamSlot: 499,
    signalTs: 1_000,
    nowMs: 1_100,
    maxSignalAgeMs: 300,
    maxSlotGap: 1,
    maxCacheAgeMs: 60_000,
  });
  assert.strictEqual(leadingStreamState.allowed, true);
  assert.strictEqual(leadingStreamState.slotGap, -1);
  assert.strictEqual(buildStreamPostSwapState({
    cachedState: streamMetadataState,
    cacheAgeMs: 20,
    signalSource: 'cpi',
    signalPoolBaseAmountRaw: '1',
    signalPoolQuoteAmountRaw: '1',
    signalVirtualQuoteReservesRaw: '1',
    signalSlot: 500,
    latestStreamSlot: 500,
    signalTs: 1_000,
    nowMs: 1_100,
  }).reason, 'signal source is not direct');
  assert.strictEqual(buildStreamPostSwapState({
    cachedState: streamMetadataState,
    cacheAgeMs: 20,
    signalSource: 'direct',
    signalPoolBaseAmountRaw: '1',
    signalPoolQuoteAmountRaw: '1',
    signalVirtualQuoteReservesRaw: '1',
    signalSlot: 500,
    latestStreamSlot: 502,
    signalTs: 1_000,
    nowMs: 1_100,
  }).reason, 'stream slot gap is outside fast-path limit');
  assert.strictEqual(buildStreamPostSwapState({
    cachedState: streamMetadataState,
    cacheAgeMs: 20,
    signalSource: 'direct',
    signalPoolBaseAmountRaw: '1',
    signalPoolQuoteAmountRaw: '1',
    signalVirtualQuoteReservesRaw: '1',
    signalSlot: 500,
    latestStreamSlot: 500,
    signalTs: 1_000,
    nowMs: 1_301,
  }).reason, 'stream signal is stale');
  const DumpDetector = require('../src/core/DumpDetector');
  const dumpDetector = Object.create(DumpDetector.prototype);
  assert.strictEqual(dumpDetector._findRawBalance([{
    accountIndex: 7,
    mint: 'Mint',
    uiTokenAmount: { amount: '123456789' },
  }], 7, 'Mint'), '123456789');

  let cacheAge = 1200;
  let refreshCalls = 0;
  const staleState = { version: 'stale' };
  const freshState = {
    version: 'fresh',
    _rpcContextSlot: 500,
    _rpcPoolContextSlot: 499,
    _rpcReserveContextSlot: 500,
    _rpcUserContextSlot: 501,
    _rpcContextSlotApproximate: false,
    _rpcFetchedAtMs: 123456,
  };
  const cache = {
    get: () => staleState,
    getAge: () => cacheAge,
    refreshOne: async (_pool, options) => {
      refreshCalls += 1;
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.maxAgeMs, 500);
      cacheAge = 0;
      return freshState;
    },
  };
  const state = await resolveFreshPoolState({
    poolStateCache: cache,
    onlineSdk: { swapSolanaState: async () => { throw new Error('unexpected direct RPC'); } },
    poolAddress: 'pool',
    poolKey: 'pool-key',
    user: 'user',
    maxAgeMs: 500,
    forceRefresh: true,
  });
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(state.swapState, freshState);
  assert.strictEqual(state.stateSource, 'rpc-forced');
  assert.strictEqual(state.cacheAgeBeforeMs, 1200);
  assert.strictEqual(state.cacheAgeAtBuildMs, 0);
  assert.strictEqual(state.rpcContextSlot, 500);
  assert.strictEqual(state.rpcPoolContextSlot, 499);
  assert.strictEqual(state.rpcReserveContextSlot, 500);
  assert.strictEqual(state.rpcUserContextSlot, 501);
  assert.strictEqual(state.rpcContextSlotApproximate, false);
  assert.strictEqual(state.rpcFetchedAtMs, 123456);

  const PoolStateCache = require('../src/core/PoolStateCache');
  const contextCache = new PoolStateCache({
    onlineSdk: {
      connection: {
        getMultipleAccountsInfoAndContext: async () => ({
          context: { slot: 777 },
          value: ['account'],
        }),
      },
    },
    user: 'user',
    getMintList: () => [],
  });
  const contextRead = await contextCache._getMultipleAccountsInfoWithContext(['key']);
  assert.deepStrictEqual(contextRead.accounts, ['account']);
  assert.strictEqual(contextRead.contextSlot, 777);
  assert.strictEqual(contextRead.approximate, false);

  cacheAge = 10;
  refreshCalls = 0;
  const forcedFreshState = await resolveFreshPoolState({
    poolStateCache: cache,
    onlineSdk: { swapSolanaState: async () => { throw new Error('unexpected direct RPC'); } },
    poolAddress: 'pool',
    poolKey: 'pool-key',
    user: 'user',
    maxAgeMs: 500,
    forceRefresh: true,
  });
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(forcedFreshState.stateSource, 'rpc-forced');

  const instructionData = Buffer.alloc(25);
  BUY_DISCRIMINATOR.copy(instructionData, 0);
  instructionData.writeBigUInt64LE(123456789n, 8);
  instructionData.writeBigUInt64LE(210000000n, 16);
  const amounts = extractBuyInstructionAmounts([{
    programId: { toBase58: () => 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' },
    data: instructionData,
  }]);
  assert.strictEqual(amounts.baseAmountOut, 123456789n);
  assert.strictEqual(amounts.maxQuoteAmountIn, 210000000n);

  const exactInstructions = [{
    programId: { toBase58: () => 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' },
    data: Buffer.from(instructionData),
  }];
  replaceBuyWithExactQuoteIn(exactInstructions, {
    spendableQuoteIn: 200000000n,
    minBaseAmountOut: 173914n,
    trackVolume: true,
  });
  assert.ok(
    exactInstructions[0].data.subarray(0, 8).equals(BUY_EXACT_QUOTE_IN_DISCRIMINATOR),
  );
  const exactAmounts = extractBuyExactQuoteInAmounts(exactInstructions);
  assert.strictEqual(exactAmounts.spendableQuoteIn, 200000000n);
  assert.strictEqual(exactAmounts.minBaseAmountOut, 173914n);
  assert.strictEqual(exactAmounts.trackVolume, true);

  const SignalEngine = require('../src/core/SignalEngine');
  const { config } = require('../src/config');
  const originalRebuyCooldownMs = config.strategy.rebuyCooldownMs;
  config.strategy.rebuyCooldownMs = 0;
  const engine = Object.create(SignalEngine.prototype);
  engine._exitCooldowns = new Map([['mint', 20_000]]);
  assert.strictEqual(engine._getMintProtectionRemainingMs('mint', 10_000), 10_000);
  assert.strictEqual(engine._getMintProtectionRemainingMs('mint', 20_001), 0);
  assert.strictEqual(engine._exitCooldowns.has('mint'), false);
  config.strategy.rebuyCooldownMs = originalRebuyCooldownMs;

  const Executor = require('../src/core/Executor');
  const diagnosticExecutor = Object.create(Executor.prototype);
  assert.strictEqual(diagnosticExecutor._getSellSlippageBps('TRAILING_STOP'), 500);
  assert.strictEqual(diagnosticExecutor._getSellSlippageBps('TIMEOUT_20S'), 500);
  assert.strictEqual(diagnosticExecutor._getSellSlippageBps('RUG_PULL_EXIT'), 5000);
  assert.strictEqual(diagnosticExecutor._getSellSlippageBps('NO_BOUNCE_5S'), 5000);
  assert.strictEqual(diagnosticExecutor._getSellSlippageBps('FIXED_STOP_LOSS'), 5000);
  diagnosticExecutor.computeUnitLimit = 250000;
  diagnosticExecutor.rpc = {
    getTransaction: async () => ({
      slot: 123,
      transaction: {
        message: {
          staticAccountKeys: ['User111', 'Pump111'],
          compiledInstructions: [
            {}, {}, {}, {}, {}, {},
            { programIdIndex: 1 },
          ],
        },
      },
      meta: {
        err: { InstructionError: [6, { Custom: 1 }] },
        loadedAddresses: { writable: [], readonly: [] },
        computeUnitsConsumed: 180000,
        logMessages: [
          'Program Pump111 invoke [1]',
          'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]',
          'Program log: Error: insufficient funds',
          'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1',
          'Program Pump111 failed: custom program error: 0x1',
        ],
      },
    }),
  };
  const failureDiagnostics = await diagnosticExecutor.fetchTxFailureDiagnostics(
    'FailureSignature',
    { InstructionError: [6, { Custom: 1 }] },
    122,
  );
  assert.strictEqual(
    failureDiagnostics.errorClass,
    'TOKEN_PROGRAM_INSUFFICIENT_FUNDS',
  );
  assert.strictEqual(failureDiagnostics.instructionIndex, 6);
  assert.strictEqual(failureDiagnostics.instructionProgramId, 'Pump111');
  assert.strictEqual(
    failureDiagnostics.failedProgramId,
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  );
  assert.strictEqual(failureDiagnostics.computeUnitsConsumed, 180000);
  assert.strictEqual(failureDiagnostics.slot, 123);

  const executor = Object.create(Executor.prototype);
  const poolAddress = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const mint = '11111111111111111111111111111111';
  const swapState = {
    globalConfig: {},
    poolKey: {},
    poolAccountInfo: {
      owner: {
        toBase58: () => 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      },
    },
    baseMint: { toBase58: () => mint },
    pool: { virtualQuoteReserves: new (require('bn.js'))(5_000_000_000) },
    poolBaseAmount: 1_000_000_000_000n,
    poolQuoteAmount: 100_000_000_000n,
    baseTokenProgram: {},
    _rpcContextSlot: 505,
    _rpcPoolContextSlot: 504,
    _rpcReserveContextSlot: 505,
    _rpcUserContextSlot: 506,
    _rpcContextSlotApproximate: false,
    _rpcFetchedAtMs: 123500,
  };
  executor.dryRun = false;
  executor.keypair = { publicKey: 'user' };
  executor.onlineSdk = { swapSolanaState: async () => { throw new Error('unexpected direct RPC'); } };
  let forcedRefreshCalls = 0;
  let refreshCallsAtSubmit = null;
  executor.poolStateCache = {
    _ownerVerified: new Set([poolAddress]),
    get: () => swapState,
    getAge: () => 50_000,
    isDead: () => false,
    refreshOne: async (_pool, options) => {
      forcedRefreshCalls += 1;
      assert.strictEqual(options.force, true);
      return swapState;
    },
  };
  executor.rpc = {};
  executor._latestBuySlot = 0;
  let quoteCalls = 0;
  executor.pumpSdk = {
    buyQuoteInput: async (_state, quote, slippagePct) => {
      quoteCalls += 1;
      assert.strictEqual(_state.pool.virtualQuoteReserves.toString(), '5000000000');
      assert.strictEqual(slippagePct, 0);
      const data = Buffer.alloc(25);
      BUY_DISCRIMINATOR.copy(data, 0);
      data.writeBigUInt64LE(194174n, 8);
      const maxQuote = BigInt(Math.floor(Number(quote.toString()) * (1 + slippagePct / 100)));
      data.writeBigUInt64LE(maxQuote, 16);
      return [{
        programId: { toBase58: () => poolAddress },
        data,
      }];
    },
  };
  executor._buildAndSignTx = async (instructions) => {
    const exact = extractBuyExactQuoteInAmounts(instructions);
    assert.ok(exact, 'buy_exact_quote_in instruction missing');
    assert.strictEqual(exact.spendableQuoteIn, 200000000n);
    assert.strictEqual(exact.minBaseAmountOut, 190477n);
    assert.strictEqual(exact.trackVolume, true);
    return {
      serialized: Buffer.alloc(65),
      feeInfo: { totalLamports: 1, source: 'test' },
    };
  };
  executor._submitTx = async () => {
    refreshCallsAtSubmit = forcedRefreshCalls;
  };
  const signalNow = Date.now();
  const liveResult = await executor.buy({
    mint,
    symbol: 'TEST',
    sizeSol: 0.2,
    priceAfter: 1,
    baseDecimals: 6,
    poolAddress,
    priceBefore: 1.2,
    signalSlot: 500,
    signalTransactionIndex: 17,
    signalTs: signalNow - 50,
    signalReceivedAt: signalNow - 45,
    latestStreamSlotAtSignal: 499,
    slotGapAtSignal: -1,
    latestStreamSlotAtOrder: 499,
    getLatestStreamSlot: () => 499,
    sellerTx: 'SellerTx',
    poolQuoteAfterSignal: 100,
    signalPoolBaseAmountUi: 123456,
    signalRawPoolQuoteSol: 95,
    signalVirtualQuoteReserveSol: 5,
    signalEffectiveQuoteReserveSol: 100,
    signalPoolBaseAmountRaw: '1000000000000',
    signalPoolQuoteAmountRaw: '100000000000',
    signalVirtualQuoteReservesRaw: '5000000000',
    signalStreamRegion: 'SS',
    signalSource: 'direct',
    _dumpBackrunEntry: true,
  });
  assert.strictEqual(liveResult.success, true);
  assert.strictEqual(refreshCallsAtSubmit, 0);
  assert.strictEqual(quoteCalls, 1);
  assert.strictEqual(liveResult.stateSource, 'stream-post-swap');
  assert.strictEqual(liveResult.buyMode, 'buy_exact_quote_in');
  assert.ok(liveResult.effectiveSlippagePct > 1 && liveResult.effectiveSlippagePct < 2);
  assert.ok(liveResult.maxPrice === 1.05);
  assert.strictEqual(liveResult.maxQuoteSol, 0.2);
  assert.strictEqual(liveResult.minBaseAmountOutRaw, '190477');
  assert.strictEqual(liveResult.virtualQuoteReservesRaw, '5000000000');
  assert.strictEqual(liveResult.effectiveQuoteReserveRaw, '105000000000');
  assert.strictEqual(liveResult.poolBaseAmountRaw, '1000000000000');
  assert.strictEqual(liveResult.poolQuoteAmountRaw, '100000000000');
  assert.strictEqual(liveResult.signalSlot, 500);
  assert.strictEqual(liveResult.signalTransactionIndex, 17);
  assert.strictEqual(liveResult.rpcContextSlot, null);
  assert.strictEqual(liveResult.latestStreamSlotAtQuote, 499);
  assert.strictEqual(liveResult.slotGapAtSignal, -1);
  assert.strictEqual(liveResult.slotGapAtQuote, -1);
  assert.strictEqual(liveResult.rpcSlotGapFromSignal, null);
  assert.strictEqual(liveResult.sellerTx, 'SellerTx');
  assert.strictEqual(liveResult.signalPoolBaseAmountUi, 123456);
  assert.strictEqual(liveResult.signalRawPoolQuoteSol, 95);
  assert.strictEqual(liveResult.signalVirtualQuoteReserveSol, 5);
  assert.strictEqual(liveResult.signalEffectiveQuoteReserveSol, 100);
  assert.strictEqual(liveResult.signalPoolBaseAmountRaw, '1000000000000');
  assert.strictEqual(liveResult.signalPoolQuoteAmountRaw, '100000000000');
  assert.strictEqual(liveResult.signalVirtualQuoteReservesRaw, '5000000000');
  assert.strictEqual(liveResult.signalStreamRegion, 'SS');
  assert.strictEqual(liveResult.signalSource, 'direct');
  assert.strictEqual(liveResult.baseDecimals, 6);
  assert.strictEqual(liveResult.streamFastPath, 1);
  assert.ok(liveResult.streamSignalAgeMs >= 0);
  assert.strictEqual(liveResult.streamSlotGap, -1);
  assert.strictEqual(liveResult.streamStateFallbackReason, null);
  assert.ok(liveResult.quoteLatencyMs >= 0);
  assert.ok(liveResult.signalToQuoteMs >= 0);

  const ttlCache = new PoolStateCache({
    onlineSdk: {},
    user: {},
    getMintList: () => [],
  });
  ttlCache.signalHotTtlMs = 10;
  ttlCache.hotMints.set('ExpiredSignalMint', {
    poolAddress,
    addedAt: Date.now() - 20,
    isPosition: false,
  });
  await ttlCache._refreshAll();
  assert.strictEqual(
    ttlCache.hotMints.has('ExpiredSignalMint'),
    false,
    'signal-only hot pools must expire instead of accumulating forever',
  );
  ttlCache.hotMints.set('OpenPositionMint', {
    poolAddress,
    addedAt: Date.now() - 20,
    isPosition: true,
  });
  ttlCache.addHot('OpenPositionMint', poolAddress, false);
  assert.strictEqual(
    ttlCache.hotMints.get('OpenPositionMint').isPosition,
    true,
    'signal prewarming must not downgrade an open position refresh tier',
  );

  console.log('PASS test-buy-execution-guard');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
