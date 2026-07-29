'use strict';

const BN = require('bn.js');

const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const BUY_EXACT_QUOTE_IN_DISCRIMINATOR = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);
const U64_MAX = (1n << 64n) - 1n;

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

function calculateExactQuoteBuyGuard({
  signalPrice,
  spendableQuoteSol,
  expectedBaseAmountRaw,
  baseDecimals,
  maxPriceDeviationPct,
}) {
  const signal = Number(signalPrice);
  const spendable = Number(spendableQuoteSol);
  const decimals = Number(baseDecimals);
  const deviationLimit = Number(maxPriceDeviationPct);
  let expectedRaw;
  try {
    expectedRaw = BigInt(expectedBaseAmountRaw);
  } catch (_) {
    return { allowed: false, reason: 'invalid expected base amount' };
  }

  if (!Number.isFinite(signal) || signal <= 0) {
    return { allowed: false, reason: 'invalid signal price' };
  }
  if (!Number.isFinite(spendable) || spendable <= 0) {
    return { allowed: false, reason: 'invalid spendable quote' };
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return { allowed: false, reason: 'invalid base decimals' };
  }
  if (!Number.isFinite(deviationLimit) || deviationLimit < 0) {
    return { allowed: false, reason: 'invalid max price deviation' };
  }
  if (expectedRaw <= 0n || expectedRaw > U64_MAX) {
    return { allowed: false, reason: 'invalid expected base amount' };
  }

  const scale = Math.pow(10, decimals);
  const expectedTokenAmount = Number(expectedRaw) / scale;
  const expectedPrice = spendable / expectedTokenAmount;
  const maxPrice = signal * (1 + deviationLimit / 100);
  const minTokenAmount = spendable / maxPrice;
  const minBaseAmountOut = BigInt(Math.ceil(minTokenAmount * scale));
  const priceDeviationPct = ((expectedPrice / signal) - 1) * 100;

  if (minBaseAmountOut <= 0n || minBaseAmountOut > U64_MAX) {
    return { allowed: false, reason: 'invalid minimum base amount' };
  }
  if (expectedRaw < minBaseAmountOut) {
    return {
      allowed: false,
      reason: 'expected price above signal cap',
      signalPrice: signal,
      expectedPrice,
      maxPrice,
      priceDeviationPct,
      expectedTokenAmount,
      minTokenAmount,
      expectedBaseAmountRaw: expectedRaw,
      minBaseAmountOut,
      effectiveSlippagePct: 0,
    };
  }

  return {
    allowed: true,
    signalPrice: signal,
    expectedPrice,
    maxPrice,
    priceDeviationPct,
    expectedTokenAmount,
    minTokenAmount,
    expectedBaseAmountRaw: expectedRaw,
    minBaseAmountOut,
    effectiveSlippagePct: Math.max(
      0,
      (1 - Number(minBaseAmountOut) / Number(expectedRaw)) * 100,
    ),
  };
}

function encodeBuyExactQuoteInData({
  spendableQuoteIn,
  minBaseAmountOut,
  trackVolume = true,
}) {
  const spendable = BigInt(spendableQuoteIn);
  const minimumBase = BigInt(minBaseAmountOut);
  if (spendable <= 0n || spendable > U64_MAX) {
    throw new RangeError('spendableQuoteIn must be a positive u64');
  }
  if (minimumBase <= 0n || minimumBase > U64_MAX) {
    throw new RangeError('minBaseAmountOut must be a positive u64');
  }

  const data = Buffer.alloc(25);
  BUY_EXACT_QUOTE_IN_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(spendable, 8);
  data.writeBigUInt64LE(minimumBase, 16);
  data.writeUInt8(trackVolume ? 1 : 0, 24);
  return data;
}

function replaceBuyWithExactQuoteIn(instructions, amounts) {
  if (!Array.isArray(instructions)) throw new TypeError('instructions must be an array');
  const data = encodeBuyExactQuoteInData(amounts);
  const index = instructions.findIndex((instruction) => {
    const programId = instruction?.programId;
    const programIdString = typeof programId === 'string'
      ? programId
      : programId?.toBase58?.() || programId?.toString?.();
    if (programIdString !== PUMP_AMM_PROGRAM_ID || !instruction?.data) return false;
    const instructionData = Buffer.from(instruction.data);
    return instructionData.length >= 8 &&
      instructionData.subarray(0, 8).equals(BUY_DISCRIMINATOR);
  });
  if (index < 0) throw new Error('Pump AMM BUY instruction not found');
  instructions[index].data = data;
  return index;
}

function extractBuyExactQuoteInAmounts(instructions) {
  if (!Array.isArray(instructions)) return null;
  for (const instruction of instructions) {
    const programId = instruction?.programId;
    const programIdString = typeof programId === 'string'
      ? programId
      : programId?.toBase58?.() || programId?.toString?.();
    if (programIdString !== PUMP_AMM_PROGRAM_ID || !instruction?.data) continue;
    const data = Buffer.from(instruction.data);
    if (
      data.length < 25 ||
      !data.subarray(0, 8).equals(BUY_EXACT_QUOTE_IN_DISCRIMINATOR)
    ) continue;
    return {
      spendableQuoteIn: data.readBigUInt64LE(8),
      minBaseAmountOut: data.readBigUInt64LE(16),
      trackVolume: data.readUInt8(24) !== 0,
    };
  }
  return null;
}

function buildStreamPostSwapState({
  cachedState,
  cacheAgeMs,
  signalSource,
  signalPoolBaseAmountRaw,
  signalPoolQuoteAmountRaw,
  signalVirtualQuoteReservesRaw,
  signalSlot,
  latestStreamSlot,
  signalTs,
  nowMs = Date.now(),
  maxSignalAgeMs = 300,
  maxSlotGap = 1,
  maxCacheAgeMs = 500,
}) {
  const signalAgeMs = Number.isFinite(Number(signalTs))
    ? Math.max(0, Number(nowMs) - Number(signalTs))
    : null;
  const slot = Number(signalSlot);
  const latestSlot = Number(latestStreamSlot);
  const slotGap =
    Number.isFinite(slot) && slot > 0 &&
    Number.isFinite(latestSlot) && latestSlot > 0
      ? latestSlot - slot
      : null;
  const reject = (reason) => ({
    allowed: false,
    reason,
    signalAgeMs,
    slotGap,
  });

  if (String(signalSource || '').toLowerCase() !== 'direct') {
    return reject('signal source is not direct');
  }
  if (
    !cachedState ||
    !cachedState.pool ||
    !cachedState.globalConfig ||
    !cachedState.poolAccountInfo ||
    !cachedState.poolKey ||
    !cachedState.baseMint ||
    !cachedState.baseTokenProgram
  ) {
    return reject('cached pool metadata unavailable');
  }
  const cacheAge = Number(cacheAgeMs);
  if (
    !Number.isFinite(cacheAge) ||
    cacheAge < 0 ||
    cacheAge > Math.max(0, Number(maxCacheAgeMs) || 0)
  ) {
    return reject('cached pool metadata is stale');
  }
  const ageLimit = Math.max(0, Number(maxSignalAgeMs) || 0);
  if (signalAgeMs == null || signalAgeMs > ageLimit) {
    return reject('stream signal is stale');
  }
  const gapLimit = Math.max(0, Number(maxSlotGap) || 0);
  if (slotGap == null || slotGap < 0 || slotGap > gapLimit) {
    return reject('stream slot gap is outside fast-path limit');
  }

  let poolBaseAmount;
  let poolQuoteAmount;
  let virtualQuoteReserves;
  try {
    poolBaseAmount = new BN(String(signalPoolBaseAmountRaw));
    poolQuoteAmount = new BN(String(signalPoolQuoteAmountRaw));
    virtualQuoteReserves = new BN(String(signalVirtualQuoteReservesRaw));
  } catch (_) {
    return reject('invalid stream reserve encoding');
  }
  if (
    poolBaseAmount.lte(new BN(0)) ||
    poolQuoteAmount.lte(new BN(0)) ||
    virtualQuoteReserves.isNeg()
  ) {
    return reject('invalid stream reserve values');
  }

  return {
    allowed: true,
    reason: null,
    signalAgeMs,
    slotGap,
    swapState: {
      ...cachedState,
      pool: {
        ...cachedState.pool,
        virtualQuoteReserves,
      },
      poolBaseAmount,
      poolQuoteAmount,
      _streamSignalSlot: slot,
      _streamSignalTs: Number(signalTs),
      _streamBuiltAtMs: Number(nowMs),
    },
  };
}

async function resolveFreshPoolState({
  poolStateCache,
  onlineSdk,
  poolAddress,
  poolKey,
  user,
  maxAgeMs = 500,
  forceRefresh = false,
}) {
  const stateDiagnostics = (swapState) => {
    const approximate = swapState?._rpcContextSlotApproximate;
    return {
      rpcContextSlot: Number(swapState?._rpcContextSlot) || null,
      rpcPoolContextSlot: Number(swapState?._rpcPoolContextSlot) || null,
      rpcReserveContextSlot: Number(swapState?._rpcReserveContextSlot) || null,
      rpcUserContextSlot: Number(swapState?._rpcUserContextSlot) || null,
      rpcContextSlotApproximate:
        approximate == null ? null : approximate === true,
      rpcFetchedAtMs: Number(swapState?._rpcFetchedAtMs) || null,
    };
  };
  const ageLimit = Math.max(0, Number(maxAgeMs) || 0);
  let cacheAgeBeforeMs = null;
  let cachedState = null;

  if (poolStateCache) {
    cachedState = poolStateCache.get(poolAddress);
    cacheAgeBeforeMs = poolStateCache.getAge(poolAddress);
    if (
      !forceRefresh &&
      cachedState &&
      Number.isFinite(cacheAgeBeforeMs) &&
      cacheAgeBeforeMs <= ageLimit
    ) {
      return {
        swapState: cachedState,
        stateSource: 'cache',
        cacheAgeBeforeMs,
        cacheAgeAtBuildMs: cacheAgeBeforeMs,
        ...stateDiagnostics(cachedState),
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
        stateSource: forceRefresh ? 'rpc-forced' : 'rpc',
        cacheAgeBeforeMs,
        cacheAgeAtBuildMs: refreshedAge,
        ...stateDiagnostics(refreshed),
      };
    }
  }

  const swapState = await onlineSdk.swapSolanaState(poolKey, user);
  if (!swapState) throw new Error('pool state refresh returned no state');
  let rpcContextSlot = null;
  if (typeof onlineSdk?.connection?.getSlot === 'function') {
    try {
      rpcContextSlot = Number(await onlineSdk.connection.getSlot('processed')) || null;
    } catch (_) {
      rpcContextSlot = null;
    }
  }
  return {
    swapState,
    stateSource: forceRefresh ? 'rpc-direct-forced' : 'rpc-direct',
    cacheAgeBeforeMs,
    cacheAgeAtBuildMs: 0,
    rpcContextSlot,
    rpcPoolContextSlot: null,
    rpcReserveContextSlot: null,
    rpcUserContextSlot: null,
    rpcContextSlotApproximate: true,
    rpcFetchedAtMs: Date.now(),
  };
}

module.exports = {
  BUY_DISCRIMINATOR,
  BUY_EXACT_QUOTE_IN_DISCRIMINATOR,
  calculateBuyPriceGuard,
  calculateExactQuoteBuyGuard,
  encodeBuyExactQuoteInData,
  extractBuyInstructionAmounts,
  extractBuyExactQuoteInAmounts,
  buildStreamPostSwapState,
  replaceBuyWithExactQuoteIn,
  resolveFreshPoolState,
};
