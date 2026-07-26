'use strict';

process.env.ACTIVITY_FLOW_FORCE_DISABLED = 'false';
process.env.ACTIVITY_FLOW_ENTRY_MODE = 'ONE_SECOND_REBOUND_V8';
process.env.REBOUND_MIN_RECOVERY_PCT = '5';
process.env.MAX_MINT_AGE_MINUTES = '10';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const OrderFlowTracker = require('../src/core/OrderFlowTracker');
const SignalEngine = require('../src/core/SignalEngine');
const { config } = require('../src/config');
Module._load = originalLoad;

const BASE = 1_800_000_000_000;
let mintSequence = 0;

function nextMint() {
  mintSequence += 1;
  return `ReboundTestMint${mintSequence}111111111111111111111111`;
}

function event(mint, offsetMs, {
  wallet = `wallet-${offsetMs}`,
  price,
  priceBefore = price,
  side = 'BUY',
  priceChangePct = ((price - priceBefore) / priceBefore) * 100,
} = {}) {
  return {
    mint,
    symbol: 'V8TEST',
    signer: wallet,
    side,
    solVolume: 0.1,
    price,
    priceBefore,
    priceChangePct,
    ts: BASE + offsetMs,
    slot: Math.floor((BASE + offsetMs) / 400),
    signature: `${mint}-${offsetMs}-${wallet}`,
    featureEligible: true,
  };
}

function tracker(overrides = {}) {
  return new OrderFlowTracker({
    entryMode: 'ONE_SECOND_REBOUND_V8',
    reboundWindowMs: 1_000,
    reboundMinDropPct: 20,
    reboundMaxDropPct: 65,
    reboundMinRecoveryPct: 5,
    reboundMaxRecoveryPct: 10,
    reboundConfirmMinGapMs: 1_000,
    reboundConfirmMaxGapMs: 10_000,
    reboundMinUniqueBuyers1s: 2,
    reboundCooldownMs: 60_000,
    maxSignalAgeMs: 0,
    ...overrides,
  });
}

function collectSignals(subject) {
  const signals = [];
  subject.on('flowReversalSignal', (signal) => signals.push(signal));
  return signals;
}

async function run() {
  assert.strictEqual(config.activityFlow.entryMode, 'ONE_SECOND_REBOUND_V8');
  assert.strictEqual(config.activityFlow.reboundMinRecoveryPct, 5);
  assert.strictEqual(config.activityFlow.reboundMaxDropPct, 65);
  assert.strictEqual(config.activityFlow.reboundConfirmMaxGapMs, 10_000);
  assert.strictEqual(config.strategy.exitMode, 'ONE_SECOND_REBOUND_V8');
  assert.strictEqual(config.strategy.maxMintAgeMinutes, 120);

  const passingMint = nextMint();
  const passing = tracker();
  const passingSignals = collectSignals(passing);
  passing.handleSwap(event(passingMint, 0, {
    side: 'SELL',
    wallet: 'seller',
    priceBefore: 1,
    price: 0.7,
  }));
  passing.handleSwap(event(passingMint, 500, {
    wallet: 'buyer-a',
    price: 0.707,
  }));
  assert.strictEqual(passingSignals.length, 0, 'a 1% recovery must not buy');
  passing.handleSwap(event(passingMint, 1_100, {
    wallet: 'buyer-b',
    price: 0.735,
  }));
  assert.strictEqual(passingSignals.length, 1, 'a confirmed 5% recovery with two buyers should buy');
  assert.strictEqual(passingSignals[0]._reboundEntry, true);
  assert.strictEqual(passingSignals[0]._flow.entryRebound.dropDepthPct, 30);
  assert(passingSignals[0]._flow.entryRebound.recoveryPct >= 5);
  assert.strictEqual(passingSignals[0]._flow.entryRebound.uniqueBuyers1s, 2);

  const extremeMint = nextMint();
  const extreme = tracker();
  const extremeSignals = collectSignals(extreme);
  extreme.handleSwap(event(extremeMint, 0, {
    side: 'SELL',
    priceBefore: 1,
    price: 0.3,
  }));
  assert.strictEqual(extremeSignals.length, 0);
  assert.strictEqual(extreme.states.get(extremeMint).reboundArm, null);
  assert.match(extreme.states.get(extremeMint).reboundDecision, /hard reject/);

  const chaseMint = nextMint();
  const chase = tracker();
  const chaseSignals = collectSignals(chase);
  chase.handleSwap(event(chaseMint, 0, {
    side: 'SELL',
    priceBefore: 1,
    price: 0.7,
  }));
  chase.handleSwap(event(chaseMint, 500, {
    wallet: 'buyer-a',
    price: 0.707,
  }));
  chase.handleSwap(event(chaseMint, 1_100, {
    wallet: 'buyer-b',
    price: 0.78,
  }));
  assert.strictEqual(chaseSignals.length, 0);
  assert.match(chase.states.get(chaseMint).reboundDecision, /chase reject/);

  const lowerLowMint = nextMint();
  const lowerLow = tracker();
  const lowerLowSignals = collectSignals(lowerLow);
  lowerLow.handleSwap(event(lowerLowMint, 0, {
    side: 'SELL',
    priceBefore: 1,
    price: 0.7,
  }));
  lowerLow.handleSwap(event(lowerLowMint, 700, {
    side: 'SELL',
    wallet: 'seller-2',
    priceBefore: 0.7,
    price: 0.65,
  }));
  lowerLow.handleSwap(event(lowerLowMint, 1_300, {
    wallet: 'buyer-a',
    price: 0.656,
  }));
  lowerLow.handleSwap(event(lowerLowMint, 1_700, {
    wallet: 'buyer-b',
    price: 0.683,
  }));
  assert.strictEqual(lowerLowSignals.length, 1, 'a new low must restart the confirmation clock');
  assert.strictEqual(lowerLowSignals[0]._flow.entryRebound.confirmGapMs, 1_000);

  const lateConfirmMint = nextMint();
  const lateConfirm = tracker();
  const lateConfirmSignals = collectSignals(lateConfirm);
  lateConfirm.handleSwap(event(lateConfirmMint, 0, {
    side: 'SELL',
    wallet: 'late-seller',
    priceBefore: 1,
    price: 0.7,
  }));
  lateConfirm.handleSwap(event(lateConfirmMint, 8_500, {
    wallet: 'late-buyer-a',
    price: 0.714,
  }));
  lateConfirm.handleSwap(event(lateConfirmMint, 9_000, {
    wallet: 'late-buyer-b',
    price: 0.735,
  }));
  assert.strictEqual(lateConfirmSignals.length, 1, 'a valid rebound may confirm in the ninth second');
  assert.strictEqual(lateConfirmSignals[0]._flow.entryRebound.confirmGapMs, 9_000);

  const oneBuyerMint = nextMint();
  const oneBuyer = tracker();
  const oneBuyerSignals = collectSignals(oneBuyer);
  oneBuyer.handleSwap(event(oneBuyerMint, 0, {
    side: 'SELL',
    priceBefore: 1,
    price: 0.7,
  }));
  oneBuyer.handleSwap(event(oneBuyerMint, 500, {
    wallet: 'same-buyer',
    price: 0.707,
  }));
  oneBuyer.handleSwap(event(oneBuyerMint, 1_100, {
    wallet: 'same-buyer',
    price: 0.735,
  }));
  assert.strictEqual(oneBuyerSignals.length, 0, 'one wallet must not satisfy buyer breadth');

  const panel = passing.getStrategyCandidates(10, BASE + 1_100);
  assert.strictEqual(panel.mode, 'ONE_SECOND_REBOUND_V8');
  assert.strictEqual(panel.thresholds.reboundMinRecoveryPct, 5);
  assert.strictEqual(panel.thresholds.reboundMaxDropPct, 65);
  assert.strictEqual(panel.candidates[0].stage, 'signaled');

  let historicalBuyExists = true;
  const acceptedSignals = [];
  const engine = new SignalEngine({
    tradeLogger: {
      getRecentAcceptedSellerTxs: () => [],
      loadRecentPriceSamples: () => new Map(),
      hasSuccessfulBuyForMint: () => historicalBuyExists,
      logSignal: () => {},
    },
    positionManager: {
      openPositionCount: () => 0,
      hasOpenPosition: () => false,
    },
  });
  engine.on('buyOrder', (signal) => acceptedSignals.push(signal));
  await engine.handleDumpSignal(passingSignals[0]);
  assert.strictEqual(
    acceptedSignals.length,
    1,
    'a previous completed trade must not permanently blacklist V8 rebound entries',
  );
  await engine.handleDumpSignal({
    ...passingSignals[0],
    signature: 'duplicate-inflight-signal',
  });
  assert.strictEqual(
    acceptedSignals.length,
    1,
    'a duplicate V8 signal must not emit a second BUY while the first BUY is in flight',
  );
  engine.markBuyDone(passingMint);
  historicalBuyExists = false;
  engine._exitCooldowns.set(passingMint, Date.now() + 60_000);
  await engine.handleDumpSignal({
    ...passingSignals[0],
    signature: 'cooldown-signal',
  });
  assert.strictEqual(acceptedSignals.length, 1, 'the 60-second mint protection must block immediate re-entry');
  engine.shutdown();

  console.log('Strategy V8 one-second rebound tests: PASS');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
