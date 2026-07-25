'use strict';

const TOKEN_PROGRAM_IDS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

function parseInstructionError(error) {
  let value = error;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_) {
      return { instructionIndex: null, customCode: null };
    }
  }

  const instructionError = value?.InstructionError;
  if (!Array.isArray(instructionError) || instructionError.length < 2) {
    return { instructionIndex: null, customCode: null };
  }

  const detail = instructionError[1];
  return {
    instructionIndex: Number.isInteger(instructionError[0]) ? instructionError[0] : null,
    customCode: detail && typeof detail === 'object' && Number.isInteger(detail.Custom)
      ? detail.Custom
      : null,
  };
}

function extractFailedProgramId(logs = []) {
  for (let i = 0; i < logs.length; i += 1) {
    const match = String(logs[i]).match(/^Program ([1-9A-HJ-NP-Za-km-z]+) failed:/);
    if (match) return match[1];
  }
  return null;
}

function classifyChainFailure({
  error,
  logs = [],
  computeUnitsConsumed = null,
  computeUnitLimit = null,
} = {}) {
  const parsed = parseInstructionError(error);
  const text = [
    typeof error === 'string' ? error : JSON.stringify(error || ''),
    ...logs,
  ].join('\n');
  const failedProgramId = extractFailedProgramId(logs);

  if (
    parsed.customCode === 6004 ||
    parsed.customCode === 6040 ||
    /ExceededSlippage|BuySlippageBelowMinBaseAmountOut/i.test(text)
  ) {
    return { ...parsed, errorClass: 'PRICE_PROTECTION_SLIPPAGE', failedProgramId };
  }

  const computeAtLimit = Number.isFinite(computeUnitsConsumed) &&
    Number.isFinite(computeUnitLimit) &&
    computeUnitLimit > 0 &&
    computeUnitsConsumed >= computeUnitLimit * 0.98;
  if (
    /ComputationalBudgetExceeded|computational budget exceeded|exceeded.*compute/i.test(text) ||
    (/ProgramFailedToComplete/i.test(text) && computeAtLimit)
  ) {
    return { ...parsed, errorClass: 'COMPUTE_LIMIT', failedProgramId };
  }

  if (parsed.customCode === 1) {
    const tokenProgramFailed = TOKEN_PROGRAM_IDS.has(failedProgramId) ||
      logs.some((line) => (
        /Program (Tokenkeg|TokenzQd)/.test(String(line)) &&
        /failed: custom program error: 0x1/i.test(String(line))
      ));
    if (tokenProgramFailed) {
      return { ...parsed, errorClass: 'TOKEN_PROGRAM_INSUFFICIENT_FUNDS', failedProgramId };
    }
    if (/insufficient funds|insufficient lamports/i.test(text)) {
      return { ...parsed, errorClass: 'INSUFFICIENT_FUNDS_UNCLASSIFIED', failedProgramId };
    }
    return { ...parsed, errorClass: 'CUSTOM_1_UNCLASSIFIED', failedProgramId };
  }

  return { ...parsed, errorClass: 'OTHER_CHAIN_FAILURE', failedProgramId };
}

module.exports = {
  classifyChainFailure,
  extractFailedProgramId,
  parseInstructionError,
};
