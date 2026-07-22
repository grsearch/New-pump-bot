'use strict';

const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

function calculateBuyPriceGuard({
  signalPrice,
  expectedPrice,
  maxPriceDeviationPct,
  configuredSlippagePct,
}) {
  const signal = Number(signalPrice);
  const expected = Number(expectedPrice);
  const deviationLimit = Number(maxPriceDeviationPct);
  const configuredSlippage = Number(configuredSlippagePct);

  if (!Number.isFinite(signal) || signal <= 0) {
    return { allowed: false, reason: 'invalid signal price' };
  }
  if (!Number.isFinite(expected) || expected <= 0) {
    return { allowed: false, reason: 'invalid expected price' };
  }
  if (!Number.isFinite(deviationLimit) || deviationLimit < 0) {
    return { allowed: false, reason: 'invalid max price deviation' };
  }
  if (!Number.isFinite(configuredSlippage) || configuredSlippage < 0) {
    return { allowed: false, reason: 'invalid configured slippage' };
  }

  const maxPrice = signal * (1 + deviationLimit / 100);
  const priceDeviationPct = ((expected / signal) - 1) * 100;
  if (expected > maxPrice * (1 + Number.EPSILON * 8)) {
    return {
      allowed: false,
      reason: 'expected price above signal cap',
      signalPrice: signal,
      expectedPrice: expected,
      maxPrice,
      priceDeviationPct,
      configuredSlippagePct: configuredSlippage,
      effectiveSlippagePct: 0,
    };
  }

  const remainingPct = Math.max(0, ((maxPrice / expected) - 1) * 100);
  return {
    allowed: true,
    signalPrice: signal,
    expectedPrice: expected,
    maxPrice,
    priceDeviationPct,
    configuredSlippagePct: configuredSlippage,
    effectiveSlippagePct: Math.min(configuredSlippage, remainingPct),
    remainingPct,
  };
}

function extractBuyInstructionAmounts(sdkResult) {
  const instructions = Array.isArray(sdkResult)
    ? sdkResult
    : sdkResult?.instructions || sdkResult?.ixs || (sdkResult ? [sdkResult] : []);

  for (const instruction of instructions) {
    const programId = instruction?.programId;
    const programIdString = typeof programId === 'string'
      ? programId
      : programId?.toBase58?.() || programId?.toString?.();
    if (programIdString !== PUMP_AMM_PROGRAM_ID || !instruction?.data) continue;

    const data = Buffer.from(instruction.data);
    if (data.length < 24 || !data.subarray(0, 8).equals(BUY_DISCRIMINATOR)) continue;
    return {
      baseAmountOut: data.readBigUInt64LE(8),
      maxQuoteAmountIn: data.readBigUInt64LE(16),
    };
  }
  return null;
}

async function resolveFreshPoolState({
  poolStateCache,
  onlineSdk,
  poolAddress,
  poolKey,
  user,
  maxAgeMs = 500,
}) {
  const ageLimit = Math.max(0, Number(maxAgeMs) || 0);
  let cacheAgeBeforeMs = null;
  let cachedState = null;

  if (poolStateCache) {
    cachedState = poolStateCache.get(poolAddress);
    cacheAgeBeforeMs = poolStateCache.getAge(poolAddress);
    if (
      cachedState &&
      Number.isFinite(cacheAgeBeforeMs) &&
      cacheAgeBeforeMs <= ageLimit
    ) {
      return {
        swapState: cachedState,
        stateSource: 'cache',
        cacheAgeBeforeMs,
        cacheAgeAtBuildMs: cacheAgeBeforeMs,
      };
    }

    const refreshed = await poolStateCache.refreshOne(poolAddress, {
      force: true,
      maxAgeMs: ageLimit,
      throwOnError: true,
    });
    const refreshedAge = poolStateCache.getAge(poolAddress);
    if (refreshed && Number.isFinite(refreshedAge) && refreshedAge <= ageLimit) {
      return {
        swapState: refreshed,
        stateSource: 'rpc',
        cacheAgeBeforeMs,
        cacheAgeAtBuildMs: refreshedAge,
      };
    }
  }

  const swapState = await onlineSdk.swapSolanaState(poolKey, user);
  if (!swapState) throw new Error('pool state refresh returned no state');
  return {
    swapState,
    stateSource: 'rpc-direct',
    cacheAgeBeforeMs,
    cacheAgeAtBuildMs: 0,
  };
}

module.exports = {
  BUY_DISCRIMINATOR,
  calculateBuyPriceGuard,
  extractBuyInstructionAmounts,
  resolveFreshPoolState,
};
