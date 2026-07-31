'use strict';

const BUILT_IN_COMPETITOR_WALLETS = Object.freeze([
  'BSHdFzWq6BfXpTx49LcCuvF4FVZakEZTibkKgjBcJqLD',
  '3fZftz6m8d37X5pBhnF4rHhgrG5hW8rsCKgdhtuPBf6u',
  '1eveYYxZ2mDiAnmCh3fnAbJwjgErzokRA1b6UrRybSM',
]);

function resolveCompetitorWallets(configuredWallets = '') {
  const configured = String(configuredWallets || '')
    .split(',')
    .map((wallet) => wallet.trim())
    .filter(Boolean);

  return [...new Set([...BUILT_IN_COMPETITOR_WALLETS, ...configured])];
}

module.exports = {
  BUILT_IN_COMPETITOR_WALLETS,
  resolveCompetitorWallets,
};
