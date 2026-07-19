'use strict';

function estimateBuySlippagePct(state, sizeSol, tokenAmount, baseDecimals = 6) {
  if (!state || !Number.isFinite(sizeSol) || sizeSol <= 0 || !Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    return null;
  }
  const toNumber = (value) => {
    if (value == null) return 0;
    try { return Number(value.toString()); } catch (_) { return 0; }
  };
  const baseRaw = toNumber(state.poolBaseAmount);
  const quoteRaw = toNumber(state.poolQuoteAmount);
  if (baseRaw <= 0 || quoteRaw <= 0) return null;
  const baseUi = baseRaw / Math.pow(10, baseDecimals);
  const quoteSol = quoteRaw / 1e9;
  const midPrice = quoteSol / baseUi;
  const executionPrice = sizeSol / tokenAmount;
  if (!Number.isFinite(midPrice) || midPrice <= 0 || !Number.isFinite(executionPrice) || executionPrice <= 0) {
    return null;
  }
  return Math.max(0, ((executionPrice / midPrice) - 1) * 100);
}

module.exports = { estimateBuySlippagePct };
