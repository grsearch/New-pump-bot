'use strict';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

function publicKeyString(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value.pubkey != null) return publicKeyString(value.pubkey);
  if (typeof value.toBase58 === 'function') return value.toBase58();
  if (typeof value.toString === 'function') return value.toString();
  return null;
}

function tokenUiAmount(balance) {
  const value = balance?.uiTokenAmount;
  if (!value) return 0;

  const raw = value.amount;
  const decimals = Number(value.decimals);
  if (raw != null && Number.isFinite(decimals)) {
    const amount = Number(raw);
    if (Number.isFinite(amount)) return amount / (10 ** decimals);
  }

  const ui = Number(value.uiAmountString ?? value.uiAmount);
  return Number.isFinite(ui) ? ui : 0;
}

function sumOwnerMintBalances(rows, owner, mint) {
  return (rows || []).reduce((sum, balance) => {
    if (balance?.owner !== owner || balance?.mint !== mint) return sum;
    return sum + tokenUiAmount(balance);
  }, 0);
}

function messageAccountKeys(message) {
  const direct = message?.accountKeys || message?.staticAccountKeys || [];
  return Array.from(direct, publicKeyString);
}

function nativeSolDelta(meta, message, owner) {
  const ownerIndex = messageAccountKeys(message).findIndex((key) => key === owner);
  if (ownerIndex < 0) return null;

  const pre = Number(meta?.preBalances?.[ownerIndex]);
  const post = Number(meta?.postBalances?.[ownerIndex]);
  if (!Number.isFinite(pre) || !Number.isFinite(post)) return null;
  return (post - pre) / LAMPORTS_PER_SOL;
}

function walletMintDelta(meta, owner, mint) {
  const before = sumOwnerMintBalances(meta?.preTokenBalances, owner, mint);
  const after = sumOwnerMintBalances(meta?.postTokenBalances, owner, mint);
  return { before, after, delta: after - before };
}

function quoteAssetDelta(meta, message, owner, wsolMint = WSOL_MINT) {
  const native = nativeSolDelta(meta, message, owner);
  const wsol = walletMintDelta(meta, owner, wsolMint);
  const total = native == null ? null : native + wsol.delta;

  return {
    nativeSolDelta: native,
    wsolBefore: wsol.before,
    wsolAfter: wsol.after,
    wsolDelta: wsol.delta,
    quoteAssetDelta: total,
  };
}

module.exports = {
  LAMPORTS_PER_SOL,
  WSOL_MINT,
  messageAccountKeys,
  nativeSolDelta,
  publicKeyString,
  quoteAssetDelta,
  sumOwnerMintBalances,
  tokenUiAmount,
  walletMintDelta,
};
