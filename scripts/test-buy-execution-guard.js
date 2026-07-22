'use strict';

const assert = require('assert');
const {
  BUY_DISCRIMINATOR,
  BUY_EXACT_QUOTE_IN_DISCRIMINATOR,
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

  let cacheAge = 1200;
  let refreshCalls = 0;
  const staleState = { version: 'stale' };
  const freshState = { version: 'fresh' };
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
  const executor = Object.create(Executor.prototype);
  const poolAddress = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const mint = '11111111111111111111111111111111';
  const swapState = {
    baseMint: { toBase58: () => mint },
    pool: { virtualQuoteReserves: new (require('bn.js'))(5_000_000_000) },
    poolBaseAmount: 1_000_000_000_000n,
    poolQuoteAmount: 100_000_000_000n,
    baseTokenProgram: null,
  };
  executor.dryRun = false;
  executor.keypair = { publicKey: 'user' };
  executor.onlineSdk = { swapSolanaState: async () => { throw new Error('unexpected direct RPC'); } };
  let forcedRefreshCalls = 0;
  executor.poolStateCache = {
    _ownerVerified: new Set([poolAddress]),
    get: () => swapState,
    getAge: () => 10,
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
    assert.strictEqual(exact.minBaseAmountOut, 173914n);
    assert.strictEqual(exact.trackVolume, true);
    return {
      serialized: Buffer.alloc(65),
      feeInfo: { totalLamports: 1, source: 'test' },
    };
  };
  executor._submitTx = async () => {};
  const liveResult = await executor.buy({
    mint,
    symbol: 'TEST',
    sizeSol: 0.2,
    priceAfter: 1,
    baseDecimals: 6,
    poolAddress,
  });
  assert.strictEqual(liveResult.success, true);
  assert.strictEqual(forcedRefreshCalls, 1);
  assert.strictEqual(quoteCalls, 1);
  assert.strictEqual(liveResult.stateSource, 'rpc-forced');
  assert.strictEqual(liveResult.buyMode, 'buy_exact_quote_in');
  assert.ok(liveResult.effectiveSlippagePct > 10 && liveResult.effectiveSlippagePct < 11);
  assert.ok(liveResult.maxPrice === 1.15);
  assert.strictEqual(liveResult.maxQuoteSol, 0.2);
  assert.strictEqual(liveResult.minBaseAmountOutRaw, '173914');
  assert.strictEqual(liveResult.virtualQuoteReservesRaw, '5000000000');

  console.log('PASS test-buy-execution-guard');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
