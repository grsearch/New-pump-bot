'use strict';

const assert = require('assert');
const { Keypair } = require('@solana/web3.js');
const {
  quoteAssetDelta,
  sumOwnerMintBalances,
  WSOL_MINT,
} = require('../src/utils/quoteAssetAccounting');
const {
  nextScheduledAt,
  parsedTokenAmount,
} = require('../src/core/QuoteAssetReconciler');
const QuoteAssetReconciler = require('../src/core/QuoteAssetReconciler');
const { getMonitor } = require('../src/monitor/HealthMonitor');

const OWNER = 'Owner1111111111111111111111111111111111111';

function tokenBalance(accountIndex, owner, mint, amount, decimals = 9) {
  return {
    accountIndex,
    owner,
    mint,
    uiTokenAmount: { amount: String(amount), decimals },
  };
}

function testQuoteDeltaIncludesWsol() {
  const message = { staticAccountKeys: [OWNER] };
  const meta = {
    preBalances: [2_000_000_000],
    postBalances: [1_999_500_000],
    preTokenBalances: [],
    postTokenBalances: [tokenBalance(2, OWNER, WSOL_MINT, 200_000_000)],
  };
  const result = quoteAssetDelta(meta, message, OWNER);
  assert(Math.abs(result.nativeSolDelta - (-0.0005)) < 1e-12);
  assert(Math.abs(result.wsolDelta - 0.2) < 1e-12);
  assert(Math.abs(result.quoteAssetDelta - 0.1995) < 1e-12);
}

function testUnwrapIsNotNewProfit() {
  const message = { accountKeys: [OWNER] };
  const meta = {
    preBalances: [1_000_000_000],
    postBalances: [2_001_844_400],
    preTokenBalances: [tokenBalance(3, OWNER, WSOL_MINT, 1_000_000_000)],
    postTokenBalances: [],
  };
  const result = quoteAssetDelta(meta, message, OWNER);
  assert(Math.abs(result.wsolDelta - (-1)) < 1e-12);
  assert(Math.abs(result.quoteAssetDelta - 0.0018444) < 1e-12);
}

function testBalanceAggregation() {
  const rows = [
    tokenBalance(1, OWNER, WSOL_MINT, 300_000_000),
    tokenBalance(2, OWNER, WSOL_MINT, 700_000_000),
    tokenBalance(3, 'other', WSOL_MINT, 900_000_000),
  ];
  assert.strictEqual(sumOwnerMintBalances(rows, OWNER, WSOL_MINT), 1);
}

function testBeijingSchedule() {
  const beforeMidnight = Date.UTC(2026, 7, 2, 15, 59, 0);
  assert.strictEqual(
    nextScheduledAt(beforeMidnight, [0, 6, 12, 18], 480),
    Date.UTC(2026, 7, 2, 16, 0, 0),
  );
  const afterMidnight = Date.UTC(2026, 7, 2, 16, 1, 0);
  assert.strictEqual(
    nextScheduledAt(afterMidnight, [0, 6, 12, 18], 480),
    Date.UTC(2026, 7, 2, 22, 0, 0),
  );
}

function testParsedAmount() {
  const account = {
    data: { parsed: { info: { tokenAmount: { amount: '1250000000', decimals: 9 } } } },
  };
  assert.strictEqual(parsedTokenAmount(account), 1.25);
}

async function testWalletOwnedWsolUnwrap() {
  const keypair = Keypair.generate();
  const tokenAccount = Keypair.generate().publicKey;
  let rawAmount = '25000000';
  const saved = [];
  const rpc = {
    getBalance: async () => 1_000_000_000,
    getParsedTokenAccountsByOwner: async () => ({
      value: rawAmount === '0' ? [] : [{
        pubkey: tokenAccount,
        account: {
          data: {
            parsed: {
              info: {
                isNative: true,
                tokenAmount: { amount: rawAmount, decimals: 9 },
              },
            },
          },
        },
      }],
    }),
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 123,
    }),
    sendRawTransaction: async () => {
      rawAmount = '0';
      return 'unwrap-signature';
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  const reconciler = new QuoteAssetReconciler({
    executor: { rpc, keypair },
    tradeLogger: { saveQuoteAssetSnapshot: (row) => saved.push(row) },
  });
  reconciler.settings = {
    ...reconciler.settings,
    enabled: true,
    autoUnwrapEnabled: true,
    autoUnwrapMinSol: 0.01,
    jupiterEscrowWsolAccounts: [],
    jupiterEscrowAlertMinSol: 0.01,
  };
  const result = await reconciler.reconcile({ allowUnwrap: true });
  assert.strictEqual(result.walletWsol, 0);
  assert.deepStrictEqual(result.unwrapSignatures, ['unwrap-signature']);
  assert.strictEqual(saved.length, 1);
}

async function main() {
  testQuoteDeltaIncludesWsol();
  testUnwrapIsNotNewProfit();
  testBalanceAggregation();
  testBeijingSchedule();
  testParsedAmount();
  await testWalletOwnedWsolUnwrap();
  console.log('Quote asset reconciler tests PASS');
  getMonitor().stop();
}

main().catch((err) => {
  getMonitor().stop();
  console.error(err);
  process.exitCode = 1;
});
