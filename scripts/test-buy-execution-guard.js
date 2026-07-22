'use strict';

const assert = require('assert');
const {
  BUY_DISCRIMINATOR,
  calculateBuyPriceGuard,
  extractBuyInstructionAmounts,
  resolveFreshPoolState,
} = require('../src/core/BuyExecutionGuard');

function closeTo(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

async function main() {
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
  });
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(state.swapState, freshState);
  assert.strictEqual(state.stateSource, 'rpc');
  assert.strictEqual(state.cacheAgeBeforeMs, 1200);
  assert.strictEqual(state.cacheAgeAtBuildMs, 0);

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
    poolBaseAmount: 1_000_000_000_000n,
    poolQuoteAmount: 100_000_000_000n,
    baseTokenProgram: null,
  };
  executor.dryRun = false;
  executor.keypair = { publicKey: 'user' };
  executor.onlineSdk = { swapSolanaState: async () => { throw new Error('unexpected direct RPC'); } };
  executor.poolStateCache = {
    _ownerVerified: new Set([poolAddress]),
    get: () => swapState,
    getAge: () => 10,
    isDead: () => false,
  };
  executor.rpc = {};
  executor._latestBuySlot = 0;
  executor.pumpSdk = {
    buyQuoteInput: async (_state, quote, slippagePct) => {
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
  executor._buildAndSignTx = async () => ({
    serialized: Buffer.alloc(65),
    feeInfo: { totalLamports: 1, source: 'test' },
  });
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
  assert.strictEqual(liveResult.stateSource, 'cache');
  assert.ok(liveResult.effectiveSlippagePct > 11 && liveResult.effectiveSlippagePct < 12);
  assert.ok(liveResult.maxPrice === 1.15);
  assert.ok(liveResult.maxQuoteSol <= 0.23);

  console.log('PASS test-buy-execution-guard');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
