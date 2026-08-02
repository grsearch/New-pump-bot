'use strict';

const {
  PublicKey,
  Transaction,
} = require('@solana/web3.js');
const {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} = require('@solana/spl-token');
const { config } = require('../config');
const { getMonitor } = require('../monitor/HealthMonitor');

const monitor = getMonitor();
monitor.registerModule('QuoteAssetReconciler', {
  staleMs: 7 * 60 * 60_000,
  label: 'SOL/WSOL Reconciler',
});

function parsedTokenAmount(accountInfo) {
  const info = accountInfo?.data?.parsed?.info;
  const tokenAmount = info?.tokenAmount;
  const raw = Number(tokenAmount?.amount);
  const decimals = Number(tokenAmount?.decimals);
  return Number.isFinite(raw) && Number.isFinite(decimals)
    ? raw / (10 ** decimals)
    : 0;
}

function nextScheduledAt(nowMs, hours, utcOffsetMinutes) {
  const dayMs = 24 * 60 * 60_000;
  const offsetMs = utcOffsetMinutes * 60_000;
  const localNow = nowMs + offsetMs;
  const localDayStart = Math.floor(localNow / dayMs) * dayMs;
  const candidates = [...hours]
    .sort((a, b) => a - b)
    .map((hour) => localDayStart + hour * 60 * 60_000 - offsetMs);
  const today = candidates.find((ts) => ts > nowMs);
  return today ?? candidates[0] + dayMs;
}

class QuoteAssetReconciler {
  constructor({ executor, tradeLogger, isTradingBusy = () => false }) {
    this.executor = executor;
    this.tradeLogger = tradeLogger;
    this.isTradingBusy = isTradingBusy;
    this.settings = config.quoteAssetReconciler;
    this.rpc = executor?.rpc || null;
    this.keypair = executor?.keypair || null;
    this.timer = null;
    this.running = false;
    this.latestSnapshot = null;
  }

  start() {
    if (!this.settings.enabled || !this.rpc || !this.keypair) {
      monitor.set('QuoteAssetReconciler.enabled', 0, 'QuoteAssetReconciler');
      return;
    }
    monitor.set('QuoteAssetReconciler.enabled', 1, 'QuoteAssetReconciler');
    this._scheduleNext();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getLatestSnapshot() {
    return this.latestSnapshot;
  }

  _scheduleNext() {
    this.stop();
    const nextRunAt = nextScheduledAt(
      Date.now(),
      this.settings.scheduleHours,
      this.settings.utcOffsetMinutes,
    );
    monitor.set('QuoteAssetReconciler.nextRunAt', nextRunAt, 'QuoteAssetReconciler');
    this.timer = setTimeout(() => this._runScheduled(), Math.max(1_000, nextRunAt - Date.now()));
    this.timer.unref?.();
  }

  _scheduleBusyRetry() {
    this.stop();
    const nextRunAt = Date.now() + this.settings.busyRetryMs;
    monitor.set('QuoteAssetReconciler.nextRunAt', nextRunAt, 'QuoteAssetReconciler');
    this.timer = setTimeout(() => this._runScheduled(), this.settings.busyRetryMs);
    this.timer.unref?.();
  }

  async _runScheduled() {
    const result = await this.reconcile({ allowUnwrap: true });
    if (result?.skipped === 'trading_busy') this._scheduleBusyRetry();
    else this._scheduleNext();
  }

  async reconcile({ allowUnwrap = false } = {}) {
    if (!this.settings.enabled || !this.rpc || !this.keypair) {
      return { skipped: 'disabled' };
    }
    if (this.running) return { skipped: 'already_running' };
    if (this.isTradingBusy()) {
      monitor.inc('QuoteAssetReconciler.skippedTradingBusy', 1, 'QuoteAssetReconciler');
      return { skipped: 'trading_busy' };
    }

    this.running = true;
    try {
      let snapshot = await this._readSnapshot();
      const shouldUnwrap = allowUnwrap &&
        this.settings.autoUnwrapEnabled &&
        snapshot.walletWsol >= this.settings.autoUnwrapMinSol &&
        snapshot.unwrapAccounts.length > 0;

      if (shouldUnwrap && !this.isTradingBusy()) {
        const signatures = await this._unwrap(snapshot.unwrapAccounts);
        snapshot = await this._readSnapshot();
        snapshot.unwrapSignatures = signatures;
        monitor.inc('QuoteAssetReconciler.unwrapRuns', 1, 'QuoteAssetReconciler');
        console.log(
          `[QuoteAssetReconciler] unwrapped wallet WSOL: ` +
          `${signatures.length} tx(s), remaining=${snapshot.walletWsol.toFixed(6)} WSOL`,
        );
      }

      this._publish(snapshot);
      return snapshot;
    } catch (err) {
      monitor.recordError('QuoteAssetReconciler', err, { phase: 'reconcile' });
      monitor.inc('QuoteAssetReconciler.failures', 1, 'QuoteAssetReconciler');
      console.error(`[QuoteAssetReconciler] reconcile failed: ${err.message}`);
      return { error: err.message };
    } finally {
      this.running = false;
    }
  }

  async _readSnapshot() {
    const owner = this.keypair.publicKey;
    const [nativeLamports, tokenAccounts] = await Promise.all([
      this.rpc.getBalance(owner, 'confirmed'),
      this.rpc.getParsedTokenAccountsByOwner(
        owner,
        { mint: NATIVE_MINT },
        'confirmed',
      ),
    ]);

    const walletAccounts = (tokenAccounts?.value || []).map((row) => {
      const info = row.account?.data?.parsed?.info || {};
      return {
        address: row.pubkey.toBase58(),
        amountSol: parsedTokenAmount(row.account),
        isNative: info.isNative === true,
        closeAuthority: info.closeAuthority || null,
      };
    });
    const unwrapAccounts = walletAccounts.filter((row) =>
      row.amountSol > 0 &&
      row.isNative &&
      (!row.closeAuthority || row.closeAuthority === owner.toBase58()),
    );
    const walletWsol = walletAccounts.reduce((sum, row) => sum + row.amountSol, 0);
    const nativeSol = nativeLamports / 1_000_000_000;

    return {
      ts: Date.now(),
      wallet: owner.toBase58(),
      nativeSol,
      walletWsol,
      walletQuoteSol: nativeSol + walletWsol,
      externalEscrowWsol: 0,
      walletWsolAccountCount: walletAccounts.length,
      externalEscrowAccountCount: 0,
      walletAccounts,
      unwrapAccounts,
      externalAccounts: [],
      unwrapSignatures: [],
    };
  }

  async _unwrap(accounts) {
    const signatures = [];
    const owner = this.keypair.publicKey;
    const chunkSize = 6;

    for (let start = 0; start < accounts.length; start += chunkSize) {
      if (this.isTradingBusy()) break;
      const chunk = accounts.slice(start, start + chunkSize);
      const latest = await this.rpc.getLatestBlockhash('confirmed');
      const tx = new Transaction({
        feePayer: owner,
        recentBlockhash: latest.blockhash,
      });
      for (const account of chunk) {
        tx.add(createCloseAccountInstruction(
          new PublicKey(account.address),
          owner,
          owner,
          [],
          TOKEN_PROGRAM_ID,
        ));
      }
      tx.sign(this.keypair);
      const signature = await this.rpc.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      const confirmation = await this.rpc.confirmTransaction({
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }, 'confirmed');
      if (confirmation?.value?.err) {
        throw new Error(`WSOL unwrap failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      signatures.push(signature);
    }
    return signatures;
  }

  _publish(snapshot) {
    const publicSnapshot = {
      ts: snapshot.ts,
      wallet: snapshot.wallet,
      nativeSol: snapshot.nativeSol,
      walletWsol: snapshot.walletWsol,
      walletQuoteSol: snapshot.walletQuoteSol,
      externalEscrowWsol: snapshot.externalEscrowWsol,
      walletWsolAccountCount: snapshot.walletWsolAccountCount,
      externalEscrowAccountCount: snapshot.externalEscrowAccountCount,
      unwrapSignatures: snapshot.unwrapSignatures,
    };
    this.latestSnapshot = publicSnapshot;

    monitor.beat('QuoteAssetReconciler', 'reconciled');
    monitor.set('QuoteAssetReconciler.nativeSol', snapshot.nativeSol, 'QuoteAssetReconciler');
    monitor.set('QuoteAssetReconciler.walletWsol', snapshot.walletWsol, 'QuoteAssetReconciler');
    monitor.set('QuoteAssetReconciler.walletQuoteSol', snapshot.walletQuoteSol, 'QuoteAssetReconciler');
    monitor.set(
      'QuoteAssetReconciler.externalEscrowWsol',
      snapshot.externalEscrowWsol,
      'QuoteAssetReconciler',
    );
    monitor.set('QuoteAssetReconciler.lastRunAt', snapshot.ts, 'QuoteAssetReconciler');

    // Clear the legacy false-positive alert. A router-owned token account is
    // not attributable to this wallet and must never be reported as its asset.
    monitor.clearAlert('quoteAsset.jupiterEscrowPending');

    this.tradeLogger?.saveQuoteAssetSnapshot?.({
      ...publicSnapshot,
      details: {
        walletAccounts: snapshot.walletAccounts,
        externalAccounts: snapshot.externalAccounts,
      },
    });

    console.log(
      `[QuoteAssetReconciler] native=${snapshot.nativeSol.toFixed(6)} ` +
      `walletWSOL=${snapshot.walletWsol.toFixed(6)} ` +
      `walletQuote=${snapshot.walletQuoteSol.toFixed(6)}`,
    );
  }
}

module.exports = QuoteAssetReconciler;
module.exports.nextScheduledAt = nextScheduledAt;
module.exports.parsedTokenAmount = parsedTokenAmount;
