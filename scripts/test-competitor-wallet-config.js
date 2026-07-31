'use strict';

const assert = require('assert');
const {
  BUILT_IN_COMPETITOR_WALLETS,
  resolveCompetitorWallets,
} = require('../src/utils/competitorWallets');

const TARGET = '1eveYYxZ2mDiAnmCh3fnAbJwjgErzokRA1b6UrRybSM';

assert.ok(
  BUILT_IN_COMPETITOR_WALLETS.includes(TARGET),
  'the requested competitor wallet must be built in',
);

assert.deepStrictEqual(
  resolveCompetitorWallets(` legacy-wallet,${TARGET},legacy-wallet `),
  [...BUILT_IN_COMPETITOR_WALLETS, 'legacy-wallet'],
  'configured wallets should be merged and deduplicated without replacing built-ins',
);

console.log('Competitor wallet config tests passed');
