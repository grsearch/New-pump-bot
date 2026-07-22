'use strict';

const assert = require('assert');
const Module = require('module');
const {
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  MIGRATE_DISCRIMINATOR,
  MIGRATE_V2_DISCRIMINATOR,
  decodeBase58,
  parsePumpMigrationTransaction,
} = require('../src/utils/pumpMigrationParser');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

function encodeBase58(buffer) {
  let number = BigInt(`0x${buffer.toString('hex') || '0'}`);
  let encoded = '';
  while (number > 0n) {
    encoded = BASE58_ALPHABET[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function key(char) {
  return char.repeat(32);
}

function migrationAccounts() {
  const accounts = Array.from({ length: 24 }, (_, index) => key(String.fromCharCode(65 + index)));
  accounts[2] = key('M');
  accounts[8] = PUMP_AMM_PROGRAM_ID;
  accounts[9] = key('P');
  accounts[17] = key('V');
  accounts[18] = key('W');
  return accounts;
}

function migrationV2Accounts() {
  const accounts = Array.from({ length: 27 }, (_, index) => key(String.fromCharCode(65 + index)));
  accounts[2] = key('M');
  accounts[8] = SYSTEM_PROGRAM_ID;
  accounts[9] = PUMP_AMM_PROGRAM_ID;
  accounts[10] = key('P');
  accounts[17] = key('V');
  accounts[18] = key('W');
  accounts[19] = TOKEN_2022_PROGRAM_ID;
  accounts[20] = TOKEN_PROGRAM_ID;
  accounts[21] = TOKEN_2022_PROGRAM_ID;
  accounts[26] = PUMP_PROGRAM_ID;
  return accounts;
}

function parsedTransaction(overrides = {}) {
  const instruction = {
    programId: PUMP_PROGRAM_ID,
    accounts: migrationAccounts(),
    data: encodeBase58(MIGRATE_DISCRIMINATOR),
    ...(overrides.instruction || {}),
  };
  return {
    slot: 123456,
    blockTime: 1_700_000_000,
    meta: { err: null, innerInstructions: [] },
    transaction: { message: { accountKeys: [], instructions: [instruction] } },
    ...overrides.transaction,
  };
}

const parsed = parsePumpMigrationTransaction(parsedTransaction(), {
  signature: 'test-signature',
  detectionPath: 'test',
});
assert(parsed, 'official migrate instruction should be detected');
assert.strictEqual(parsed.mint, key('M'));
assert.strictEqual(parsed.poolAddress, key('P'));
assert.strictEqual(parsed.poolBaseVault, key('V'));
assert.strictEqual(parsed.poolQuoteVault, key('W'));
assert.strictEqual(parsed.slot, 123456);
assert.strictEqual(parsed.migrationTime, 1_700_000_000_000);
assert.strictEqual(parsed.migrationTimeSource, 'blockTime');
assert.strictEqual(parsed.migrationVersion, 'v1');

const parsedV2 = parsePumpMigrationTransaction(parsedTransaction({
  instruction: {
    accounts: migrationV2Accounts(),
    data: encodeBase58(MIGRATE_V2_DISCRIMINATOR),
  },
}));
assert(parsedV2, 'official migrate_v2 instruction should be detected');
assert.strictEqual(parsedV2.mint, key('M'));
assert.strictEqual(parsedV2.poolAddress, key('P'));
assert.strictEqual(parsedV2.poolBaseVault, key('V'));
assert.strictEqual(parsedV2.poolQuoteVault, key('W'));
assert.strictEqual(parsedV2.migrationVersion, 'v2');

const invalidV2VaultAccounts = migrationV2Accounts();
invalidV2VaultAccounts[18] = TOKEN_2022_PROGRAM_ID;
const invalidV2Vault = parsePumpMigrationTransaction(parsedTransaction({
  instruction: {
    accounts: invalidV2VaultAccounts,
    data: encodeBase58(MIGRATE_V2_DISCRIMINATOR),
  },
}));
assert(invalidV2Vault, 'migration detection should survive a missing vault so PoolFinder can repair it');
assert.strictEqual(invalidV2Vault.poolQuoteVault, null, 'a token program ID must never be stored as a vault');

const wrongData = Buffer.from(MIGRATE_DISCRIMINATOR);
wrongData[0] ^= 0xff;
assert.strictEqual(parsePumpMigrationTransaction(parsedTransaction({
  instruction: { data: encodeBase58(wrongData) },
})), null, 'a generic Pump instruction must not be accepted');

const wrongAmmAccounts = migrationAccounts();
wrongAmmAccounts[8] = key('Q');
assert.strictEqual(parsePumpMigrationTransaction(parsedTransaction({
  instruction: { accounts: wrongAmmAccounts },
})), null, 'migrate must target the official PumpSwap program');

const wrongV2AmmAccounts = migrationV2Accounts();
wrongV2AmmAccounts[9] = key('Q');
assert.strictEqual(parsePumpMigrationTransaction(parsedTransaction({
  instruction: {
    accounts: wrongV2AmmAccounts,
    data: encodeBase58(MIGRATE_V2_DISCRIMINATOR),
  },
})), null, 'migrate_v2 must target the official PumpSwap program at its shifted index');

const compiledAccounts = migrationAccounts();
const accountKeys = [PUMP_PROGRAM_ID, ...compiledAccounts];
const compiled = parsedTransaction({
  instruction: {
    programId: undefined,
    programIdIndex: 0,
    accounts: compiledAccounts.map((_, index) => index + 1),
  },
  transaction: {
    transaction: {
      message: {
        accountKeys,
        instructions: [{
          programIdIndex: 0,
          accounts: compiledAccounts.map((_, index) => index + 1),
          data: encodeBase58(MIGRATE_DISCRIMINATOR),
        }],
      },
    },
  },
});
assert(parsePumpMigrationTransaction(compiled), 'compiled account indexes should be supported');

const compiledV2Accounts = migrationV2Accounts();
const compiledV2Static = [PUMP_PROGRAM_ID, ...compiledV2Accounts.slice(0, 17)];
const compiledV2 = parsedTransaction({
  transaction: {
    slot: 234567,
    blockTime: 1_700_000_100,
    meta: {
      err: null,
      innerInstructions: [],
      loadedAddresses: {
        writable: compiledV2Accounts.slice(17),
        readonly: [],
      },
    },
    transaction: {
      message: {
        staticAccountKeys: compiledV2Static,
        instructions: [{
          programIdIndex: 0,
          accounts: compiledV2Accounts.map((_, index) => index + 1),
          data: encodeBase58(MIGRATE_V2_DISCRIMINATOR),
        }],
      },
    },
  },
});
const parsedCompiledV2 = parsePumpMigrationTransaction(compiledV2);
assert(parsedCompiledV2, 'compiled migrate_v2 account indexes with ALT addresses should be supported');
assert.strictEqual(parsedCompiledV2.poolBaseVault, key('V'));
assert.strictEqual(parsedCompiledV2.poolQuoteVault, key('W'));

const jsonParsedV2 = parsedTransaction({
  transaction: {
    meta: { err: null, innerInstructions: [] },
    transaction: {
      message: {
        accountKeys: [PUMP_PROGRAM_ID, ...compiledV2Accounts].map((pubkey, index) => ({
          pubkey,
          signer: false,
          writable: index > 17,
          source: index > 17 ? 'lookupTable' : 'transaction',
        })),
        instructions: [{
          programIdIndex: 0,
          accounts: compiledV2Accounts.map((_, index) => index + 1),
          data: encodeBase58(MIGRATE_V2_DISCRIMINATOR),
        }],
      },
    },
  },
});
const parsedJsonV2 = parsePumpMigrationTransaction(jsonParsedV2);
assert(parsedJsonV2, 'jsonParsed ALT account keys should be supported without meta.loadedAddresses');
assert.strictEqual(parsedJsonV2.poolBaseVault, key('V'));
assert.strictEqual(parsedJsonV2.poolQuoteVault, key('W'));

assert.deepStrictEqual(decodeBase58('1'), Buffer.from([0]));
assert.deepStrictEqual(decodeBase58('2'), Buffer.from([1]));

const originalLoad = Module._load;
Module._load = function loadWithDependencyStubs(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  if (request === 'axios') return { get: async () => ({}), post: async () => ({ data: {} }) };
  if (request === 'ws') return class WebSocketStub {};
  return originalLoad.call(this, request, parent, isMain);
};
const PumpGraduationDiscovery = require('../src/core/PumpGraduationDiscovery');
const TokenWatchdog = require('../src/core/TokenWatchdog');
const PoolFinder = require('../src/utils/poolFinder');
Module._load = originalLoad;

const pumpSwapAccounts = Array.from({ length: 23 }, (_, index) => key(String.fromCharCode(65 + index)));
pumpSwapAccounts[0] = key('P');
pumpSwapAccounts[3] = key('M');
pumpSwapAccounts[7] = key('V');
pumpSwapAccounts[8] = key('W');
const poolFinder = Object.create(PoolFinder.prototype);
const extractedPool = poolFinder._extractPoolFromTx({
  instructions: [{ programId: PUMP_AMM_PROGRAM_ID, accounts: pumpSwapAccounts }],
  tokenTransfers: [],
}, key('M'));
assert.deepStrictEqual(extractedPool, {
  poolAddress: key('P'),
  poolBaseVault: key('V'),
  poolQuoteVault: key('W'),
}, 'PoolFinder should use the canonical PumpSwap vault indexes before transfer inference');

const discovery = Object.create(PumpGraduationDiscovery.prototype);
discovery.settings = {
  minFdvUsd: 15_000,
  maxFdvUsd: 1_000_000,
  minLiquidityUsd: 3_000,
  marketRetries: 1,
  marketRetryMs: 1,
};

let detectedMigration = null;
let migrationDetectionCount = 0;
discovery.onMigrationDetected = (migration) => {
  detectedMigration = migration;
  migrationDetectionCount++;
};
discovery.seenMints = new Map();
discovery.queuedMints = new Set();
discovery.candidateQueue = [];
discovery.running = false;
discovery._enqueueCandidate({ mint: key('M'), migrationVersion: 'v2' });
assert.strictEqual(detectedMigration.mint, key('M'));
assert.strictEqual(detectedMigration.migrationVersion, 'v2');
discovery._enqueueCandidate({ mint: key('M'), migrationVersion: 'v2' });
assert.strictEqual(migrationDetectionCount, 2, 'confirmed migrations must reset RSI even when screening is deduplicated');
assert.strictEqual(discovery.candidateQueue.length, 1, 'screening queue must remain deduplicated');

assert.strictEqual(
  discovery._hasMigrationHint(['Program log: Instruction: MigrateV2']),
  true,
  'websocket prefilter must accept MigrateV2 logs',
);

assert.strictEqual(
  discovery._getRejection({ market: { fdv: 20_000, liquidity: 3_500 } }),
  null,
  'discovery must accept valid FDV/LP without security or creation-time data',
);
assert.strictEqual(
  discovery._getRejection({ market: { fdv: 14_999, liquidity: 3_500 } }).code,
  'fdv_low',
);
assert.strictEqual(
  discovery._getRejection({ market: { fdv: 20_000, liquidity: 2_999 } }).code,
  'liquidity_low',
);

const watchdog = Object.create(TokenWatchdog.prototype);
const now = 1_800_000_000_000;
assert.strictEqual(
  watchdog._getMigrationAgeMs({ creation_time: now - 7 * 24 * 3600_000, migration_time: now - 60_000 }, now),
  60_000,
  'AGE must start from migration even when mint creation is much older',
);
assert.strictEqual(
  watchdog._getMigrationAgeMs({ creation_time: now - 7 * 24 * 3600_000 }, now),
  null,
  'missing migration time must remain unknown instead of falling back to creation time',
);

(async () => {
  let marketCalls = 0;
  discovery.fetchMarket = async () => {
    marketCalls++;
    return { fdv: 20_000, liquidity: 3_500 };
  };
  const screening = await discovery._fetchScreeningData(key('M'));
  assert.deepStrictEqual(screening, { market: { fdv: 20_000, liquidity: 3_500 } });
  assert.strictEqual(marketCalls, 1);

  let addOptions = null;
  discovery.tokenRegistry = {
    getToken: () => null,
    addToken: async (_mint, opts) => {
      addOptions = opts;
      return { mint: key('M'), symbol: 'TEST' };
    },
  };
  discovery.settings.marketInitialDelayMs = 0;
  discovery._fetchScreeningData = async () => screening;
  discovery.fetchAsset = async () => ({ symbol: 'TEST' });
  discovery.onBeforeAdd = null;
  discovery.onTokenAdded = null;
  discovery.emit = () => {};
  await discovery._screenAndAdd({
    mint: key('M'),
    poolAddress: key('P'),
    poolBaseVault: key('V'),
    poolQuoteVault: key('W'),
    migrationTime: now - 60_000,
    migrationTimeSource: 'blockTime',
    slot: 123456,
    signature: 'migration-signature',
    detectionPath: 'test',
  });
  assert.strictEqual(addOptions.fetchCreationTime, false, 'discovery must not fetch mint creation age');
  assert.strictEqual(addOptions.migrationTime, now - 60_000);
  console.log('Pump migration and discovery policy tests passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
