'use strict';

const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { PublicKey } = require('@solana/web3.js');
const CompetitorForensics = require('../src/core/CompetitorForensics');
const { getMonitor } = require('../src/monitor/HealthMonitor');

const WALLET = '1eveYYxZ2mDiAnmCh3fnAbJwjgErzokRA1b6UrRybSM';
const OTHER = 'BSHdFzWq6BfXpTx49LcCuvF4FVZakEZTibkKgjBcJqLD';
const MINT = 'Aarj8Ci7EVX7vHLeLsBMuiDDzJ3oXdsMP1PFQ44bpump';
const PUMP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const BASE_TS = 1_800_000_000_000;

function key(value) {
  return new PublicKey(value).toBuffer();
}

function ui(amount, decimals = 6) {
  return {
    amount: String(Math.round(amount * (10 ** decimals))),
    decimals,
  };
}

function tx({
  signatureByte,
  wallet,
  slot,
  tokenBefore,
  tokenAfter,
  solBefore,
  solAfter,
  error = null,
}) {
  return {
    slot,
    transaction: {
      signature: Buffer.alloc(64, signatureByte),
      index: 2,
      transaction: {
        signatures: [Buffer.alloc(64, signatureByte)],
        message: {
          accountKeys: [key(wallet), key(PUMP)],
          header: { numRequiredSignatures: 1 },
          instructions: [{ programIdIndex: 1, accounts: [], data: Buffer.alloc(0) }],
        },
      },
      meta: {
        err: error,
        fee: 10_000,
        computeUnitsConsumed: 42_000,
        preBalances: [Math.round(solBefore * 1e9), 0],
        postBalances: [Math.round(solAfter * 1e9), 0],
        preTokenBalances: [{
          accountIndex: 0,
          mint: MINT,
          owner: wallet,
          uiTokenAmount: ui(tokenBefore),
        }],
        postTokenBalances: [{
          accountIndex: 0,
          mint: MINT,
          owner: wallet,
          uiTokenAmount: ui(tokenAfter),
        }],
        loadedWritableAddresses: [],
        loadedReadonlyAddresses: [],
        innerInstructions: [],
      },
    },
  };
}

const db = new DatabaseSync(':memory:');
db.transaction = (operation) => () => {
  db.exec('BEGIN');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};
db.exec(`
  CREATE TABLE token_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT,
    ts INTEGER,
    price REAL,
    fdv REAL,
    liquidity REAL,
    feature_quality_status TEXT
  );
  CREATE TABLE swap_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT,
    ts INTEGER,
    price REAL,
    feature_eligible INTEGER,
    price_reliable INTEGER
  );
`);
db.prepare(`
  INSERT INTO token_snapshots (mint, ts, price, fdv, liquidity, feature_quality_status)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(MINT, BASE_TS + 500, 0.000009, 50_000, 20_000, 'trusted');

const discovered = [];
const subject = new CompetitorForensics({
  db,
  wallets: [WALLET],
  onMintDiscovered: (mint) => discovered.push(mint),
  slotToWallClockMs: (slot) => BASE_TS + slot * 1000,
  labelIntervalMs: 60_000,
});
subject.start();

const buyTx = tx({
  signatureByte: 1,
  wallet: WALLET,
  slot: 1,
  tokenBefore: 0,
  tokenAfter: 100_000,
  solBefore: 10,
  solAfter: 8.99999,
});
subject.handleTransaction(buyTx, { firstRegion: 'COMP-TEST' });

const buy = db.prepare(`SELECT * FROM competitor_forensic_trades`).get();
assert.ok(buy, 'competitor buy should be recorded');
assert.strictEqual(buy.side, 'BUY');
assert.strictEqual(buy.token_amount, 100_000);
assert.ok(Math.abs(buy.sol_amount - 1) < 1e-8, 'fee-adjusted SOL amount should be 1');
assert.ok(Math.abs(buy.execution_price_sol - 0.00001) < 1e-12);
assert.ok(Math.abs(buy.reference_price_sol - 0.000009) < 1e-12);
assert.ok(Math.abs(buy.execution_vs_asof_pct - 11.11111111111111) < 1e-8);
assert.strictEqual(buy.capture_source, 'wallet_account_subscription');
assert.strictEqual(buy.context_snapshot_ts, BASE_TS + 500);
assert.strictEqual(buy.context_lag_ms, 500);
assert.strictEqual(buy.context_quality, 'trusted_asof');
assert.strictEqual(buy.entry_sequence, 1);
assert.deepStrictEqual(discovered, [MINT]);

const enrichRequest = {
  requestedAt: BASE_TS + 1100,
  trades: [{ tradeId: buy.id, eventTs: buy.ts }],
};
subject._contextEnrichInFlight.set(MINT, enrichRequest);
subject._completeTokenContext(MINT, enrichRequest, {
  symbol: 'TEST',
  fdv: 50_000,
  liquidity: 20_000,
  holders: 123,
  volume24h: 250_000,
  creationTime: (BASE_TS - 60_000) / 1000,
  marketSource: 'test',
}, null);
const enrichedBuy = db.prepare(`
  SELECT * FROM competitor_forensic_trades WHERE id = ?
`).get(buy.id);
assert.ok(enrichedBuy.external_context_id > 0);
assert.strictEqual(enrichedBuy.external_context_quality, 'post_trade_api_enrichment');
const tokenContext = db.prepare(`
  SELECT * FROM competitor_token_contexts WHERE id = ?
`).get(enrichedBuy.external_context_id);
assert.strictEqual(tokenContext.age_ms_at_event, 61_000);
assert.strictEqual(tokenContext.holders, 123);

const positionAfterBuy = db.prepare(`SELECT * FROM competitor_wallet_positions`).get();
assert.strictEqual(positionAfterBuy.token_balance, 100_000);
assert.ok(Math.abs(positionAfterBuy.cost_basis_sol - 1) < 1e-8);

subject.handleTransaction(buyTx, { firstRegion: 'LS-DUPLICATE' });

subject.handleTransaction(tx({
  signatureByte: 2,
  wallet: OTHER,
  slot: 3,
  tokenBefore: 10_000,
  tokenAfter: 20_000,
  solBefore: 5,
  solAfter: 4.87999,
}), { firstRegion: 'LS-TEST' });

subject.processLabels(BASE_TS + 181_000);
const labeled = db.prepare(`SELECT * FROM competitor_forensic_trades WHERE id = ?`).get(buy.id);
assert.strictEqual(labeled.label_status, 'complete');
assert.ok(labeled.label_samples_3s >= 1);
assert.ok(labeled.future_max_3s_pct > 0);

const positiveOpportunity = db.prepare(`
  SELECT * FROM competitor_opportunities WHERE wallet = ? AND did_buy = 1
`).get(WALLET);
assert.ok(positiveOpportunity, 'the competitor buy must produce a positive opportunity row');

const coverage = db.prepare(`SELECT * FROM competitor_capture_coverage WHERE wallet = ?`).get(WALLET);
assert.strictEqual(coverage.transactions_seen, 1);
assert.strictEqual(coverage.trades_parsed, 1);
assert.strictEqual(coverage.wallet_stream_transactions, 1);
assert.strictEqual(coverage.overlap_stream_transactions, 0);

subject.handleTransaction(tx({
  signatureByte: 4,
  wallet: WALLET,
  slot: 4,
  tokenBefore: 100_000,
  tokenAfter: 100_000,
  solBefore: 8.99999,
  solAfter: 8.99998,
  error: { InstructionError: [6, { Custom: 6004 }] },
}), { firstRegion: 'COMP-TEST' });
const failedTransaction = db.prepare(`
  SELECT * FROM competitor_wallet_transactions WHERE parse_status = 'chain_failed'
`).get();
assert.ok(failedTransaction, 'failed competitor transaction should be retained');
assert.ok(failedTransaction.chain_error_json.includes('6004'));
const coverageAfterFailure = db.prepare(`
  SELECT * FROM competitor_capture_coverage WHERE wallet = ?
`).get(WALLET);
assert.strictEqual(coverageAfterFailure.transactions_seen, 2);
assert.strictEqual(coverageAfterFailure.chain_failed_transactions, 1);

subject.handleTransaction(tx({
  signatureByte: 3,
  wallet: WALLET,
  slot: 5,
  tokenBefore: 100_000,
  tokenAfter: 50_000,
  solBefore: 8.99999,
  solAfter: 9.74998,
}), { firstRegion: 'COMP-TEST' });

const sell = db.prepare(`
  SELECT * FROM competitor_forensic_trades WHERE side = 'SELL'
`).get();
assert.ok(sell, 'competitor sell should be recorded');
assert.strictEqual(sell.sell_fraction_pct, 50);
assert.ok(Math.abs(sell.realized_pnl_sol - 0.25) < 1e-8);
assert.ok(Math.abs(sell.realized_pnl_pct - 50) < 1e-8);
assert.strictEqual(sell.hold_ms, 4000);

subject.addWallet(OTHER);
subject.handleTransaction(tx({
  signatureByte: 5,
  wallet: OTHER,
  slot: 6,
  tokenBefore: 40_000,
  tokenAfter: 0,
  solBefore: 5,
  solAfter: 5.39999,
}), { firstRegion: 'COMP-TEST' });
const unknownBasisSell = db.prepare(`
  SELECT * FROM competitor_forensic_trades
  WHERE wallet = ? AND side = 'SELL'
`).get(OTHER);
assert.ok(unknownBasisSell, 'pre-existing wallet balance sell should be recorded');
assert.strictEqual(unknownBasisSell.position_cost_known_before, 0);
assert.strictEqual(unknownBasisSell.realized_pnl_sol, null);

subject.stop();
const session = db.prepare(`SELECT * FROM competitor_capture_sessions`).get();
assert.strictEqual(session.status, 'stopped');
assert.ok(session.stopped_at >= session.started_at);
getMonitor().stop();
db.close();
console.log('Competitor forensics tests passed');
