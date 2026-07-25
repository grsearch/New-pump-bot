'use strict';

const assert = require('assert');
const {
  classifyChainFailure,
  extractFailedProgramId,
  parseInstructionError,
} = require('../src/core/ChainFailureDiagnostics');

const customOne = { InstructionError: [6, { Custom: 1 }] };
assert.deepStrictEqual(parseInstructionError(customOne), {
  instructionIndex: 6,
  customCode: 1,
});

const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const tokenLogs = [
  'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]',
  `Program ${tokenProgram} invoke [2]`,
  'Program log: Error: insufficient funds',
  `Program ${tokenProgram} failed: custom program error: 0x1`,
  'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA failed: custom program error: 0x1',
];
const tokenFailure = classifyChainFailure({ error: customOne, logs: tokenLogs });
assert.strictEqual(tokenFailure.errorClass, 'TOKEN_PROGRAM_INSUFFICIENT_FUNDS');
assert.strictEqual(tokenFailure.instructionIndex, 6);
assert.strictEqual(
  extractFailedProgramId(tokenLogs),
  tokenProgram,
);

const unknownCustomOne = classifyChainFailure({ error: customOne, logs: [] });
assert.strictEqual(unknownCustomOne.errorClass, 'CUSTOM_1_UNCLASSIFIED');

const genericFunds = classifyChainFailure({
  error: customOne,
  logs: [
    'Transfer: insufficient lamports 1000, need 2000',
    'Program 11111111111111111111111111111111 failed: custom program error: 0x1',
  ],
});
assert.strictEqual(genericFunds.errorClass, 'INSUFFICIENT_FUNDS_UNCLASSIFIED');

const slippage = classifyChainFailure({
  error: { InstructionError: [6, { Custom: 6040 }] },
  logs: [
    'Program log: AnchorError caused by account: pool. ' +
      'Error Code: BuySlippageBelowMinBaseAmountOut.',
  ],
});
assert.strictEqual(slippage.errorClass, 'PRICE_PROTECTION_SLIPPAGE');

const compute = classifyChainFailure({
  error: { InstructionError: [6, 'ProgramFailedToComplete'] },
  logs: ['Program abc consumed 250000 of 250000 compute units'],
  computeUnitsConsumed: 250000,
  computeUnitLimit: 250000,
});
assert.strictEqual(compute.errorClass, 'COMPUTE_LIMIT');

const nonComputeProgramFailure = classifyChainFailure({
  error: { InstructionError: [6, 'ProgramFailedToComplete'] },
  logs: ['Program abc consumed 180000 of 250000 compute units'],
  computeUnitsConsumed: 180000,
  computeUnitLimit: 250000,
});
assert.strictEqual(nonComputeProgramFailure.errorClass, 'OTHER_CHAIN_FAILURE');

console.log('PASS test-chain-failure-diagnostics');
