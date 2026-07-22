'use strict';

const { priceDetailsFromRawState } = require('../utils/pumpSwapPricing');

function estimateBuySlippagePct(state, sizeSol, tokenAmount, baseDecimals = 6) {
  if (!state || !Number.isFinite(sizeSol) || sizeSol <= 0 || !Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    return null;
  }
  const midPrice = priceDetailsFromRawState(state, baseDecimals)?.effectivePrice;
  const executionPrice = sizeSol / tokenAmount;
  if (!Number.isFinite(midPrice) || midPrice <= 0 || !Number.isFinite(executionPrice) || executionPrice <= 0) {
    return null;
  }
  return Math.max(0, ((executionPrice / midPrice) - 1) * 100);
}

module.exports = { estimateBuySlippagePct };
