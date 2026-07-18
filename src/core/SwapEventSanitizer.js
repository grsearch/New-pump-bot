'use strict';

const { config } = require('../config');

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function distanceRatio(left, right) {
  if (!(left > 0) || !(right > 0)) return Infinity;
  const ratio = left / right;
  return ratio >= 1 ? ratio : 1 / ratio;
}

class SwapEventSanitizer {
  constructor(opts = {}) {
    const settings = config.priceFilter?.swapSanitizer || {};
    this.tokenRegistry = opts.tokenRegistry || null;
    this.enabled = opts.enabled ?? settings.enabled ?? true;
    this.solPriceUsd = finitePositive(opts.solPriceUsd ?? settings.solPriceUsd ?? process.env.SOL_PRICE_USD) || 72;
    this.maxJumpRatio = Math.max(1.01, finitePositive(opts.maxJumpRatio ?? settings.maxJumpRatio) || 2);
    this.marketMaxRatio = Math.max(1.01, finitePositive(opts.marketMaxRatio ?? settings.marketMaxRatio) || 5);
    this.marketMaxAgeMs = Math.max(1_000, finitePositive(opts.marketMaxAgeMs ?? settings.marketMaxAgeMs) || 300_000);
    this.confirmWindowMs = Math.max(100, finitePositive(opts.confirmWindowMs ?? settings.confirmWindowMs) || 5_000);
    this.confirmMinSamples = Math.max(2, Math.floor(finitePositive(opts.confirmMinSamples ?? settings.confirmMinSamples) || 3));
    this.confirmMinIndependentSources = Math.max(
      2,
      Math.floor(finitePositive(
        opts.confirmMinIndependentSources ?? settings.confirmMinIndependentSources,
      ) || 2),
    );
    this.confirmMinSpanMs = Math.max(0, finiteNumber(opts.confirmMinSpanMs ?? settings.confirmMinSpanMs, 100));
    this.confirmClusterRatio = Math.max(1.01, finitePositive(opts.confirmClusterRatio ?? settings.confirmClusterRatio) || 1.25);
    this.minPoolQuoteSol = Math.max(
      0,
      finiteNumber(opts.minPoolQuoteSol ?? settings.minPoolQuoteSol, config.strategy?.minPoolQuoteSol ?? 30),
    );
    this.dataQualityVersion = 4;
    this.debug = opts.debug ?? settings.debug ?? false;
    this.prices = new Map();
    this.pending = new Map();
    this.marketAnchors = new Map();
  }

  clear() {
    this.prices.clear();
    this.pending.clear();
    this.marketAnchors.clear();
  }

  getPrice(mint) {
    return this.prices.get(mint)?.price ?? null;
  }

  sanitize(swap) {
    if (!swap || !swap.mint) return this._reject('missing_mint');
    const side = String(swap.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return this._reject('invalid_side');

    const solVolume = finitePositive(swap.solVolume);
    if (!solVolume) return this._reject('nonpositive_volume');

    const now = finiteNumber(swap.ts, Date.now());
    const rawPrice = finitePositive(swap.price);
    const rawPriceBefore = finitePositive(swap.priceBefore);
    const source = String(swap.source || 'unknown').toLowerCase();
    const rawReliable = swap.priceReliable !== false && rawPrice != null;

    if (!this.enabled) {
      if (!rawPrice) return this._reject('missing_price');
      return {
        event: this._event(swap, {
          side,
          solVolume,
          price: rawPrice,
          priceBefore: rawPriceBefore || rawPrice,
          rawPrice,
          rawPriceBefore,
          source,
          priceReliable: rawReliable,
          priceSanitized: false,
          featureEligible: false,
          sanitizerReason: 'disabled',
          dataQualityVersion: 1,
        }),
        status: 'accepted',
        reason: 'disabled',
      };
    }

    const market = this._marketAnchor(swap.mint, now);
    let canonical = this.prices.get(swap.mint) || null;
    const previousCanonical = canonical;
    let marketRefreshedAcrossJump = false;
    if (market && (!canonical || market.updatedAt > canonical.ts)) {
      marketRefreshedAcrossJump = Boolean(
        canonical && distanceRatio(market.price, canonical.price) > this.maxJumpRatio,
      );
      canonical = { price: market.price, ts: market.updatedAt, source: 'market' };
      this.prices.set(swap.mint, canonical);
    }

    const featureSource = this._isFeatureSource(source);
    if (rawReliable && !featureSource) {
      if (!canonical) {
        return this._volumeOnly(swap, {
          side,
          solVolume,
          rawPrice,
          rawPriceBefore,
          source,
          reason: 'untrusted_feature_source',
        });
      }
      return this._fallback(swap, canonical.price, {
        side,
        solVolume,
        rawPrice,
        rawPriceBefore,
        source,
        reason: 'untrusted_feature_source',
      });
    }

    if (rawReliable && featureSource && !this._hasPlausiblePool(swap)) {
      return this._volumeOnly(swap, {
        side,
        solVolume,
        rawPrice,
        rawPriceBefore,
        source,
        reason: `${source}_insufficient_pool`,
      });
    }

    if (!rawReliable) {
      if (!canonical) {
        return this._volumeOnly(swap, {
          side,
          solVolume,
          rawPrice,
          rawPriceBefore,
          source,
          reason: 'unreliable_price_without_anchor',
        });
      }
      return this._fallback(swap, canonical.price, {
        side,
        solVolume,
        rawPrice,
        rawPriceBefore,
        source,
        reason: marketRefreshedAcrossJump ? 'market_anchor_refresh' : 'unreliable_price',
      });
    }

    if (!canonical) {
      if (source !== 'direct') {
        return this._volumeOnly(swap, {
          side,
          solVolume,
          rawPrice,
          rawPriceBefore,
          source,
          reason: 'non_direct_price_without_anchor',
        });
      }
      return this._accept(swap, rawPrice, rawPriceBefore, {
        side,
        solVolume,
        source,
        reason: 'direct_seed',
      });
    }

    if (market && distanceRatio(rawPrice, market.price) > this.marketMaxRatio) {
      return this._fallback(swap, canonical.price, {
        side,
        solVolume,
        rawPrice,
        rawPriceBefore,
        source,
        reason: marketRefreshedAcrossJump ? 'market_anchor_refresh' : 'market_anchor_mismatch',
      });
    }

    if (distanceRatio(rawPrice, canonical.price) > this.maxJumpRatio) {
      if (source === 'direct' && this._confirmDirectJump(swap.mint, rawPrice, now, swap)) {
        return this._accept(swap, rawPrice, rawPriceBefore, {
          side,
          solVolume,
          source,
          reason: 'direct_jump_independently_confirmed',
        });
      }
      return this._fallback(swap, canonical.price, {
        side,
        solVolume,
        rawPrice,
        rawPriceBefore,
        source,
        reason: marketRefreshedAcrossJump ? 'market_anchor_refresh' : 'price_discontinuity',
      });
    }

    this.pending.delete(swap.mint);
    return this._accept(swap, rawPrice, rawPriceBefore, {
      side,
      solVolume,
      source,
      reason: marketRefreshedAcrossJump && previousCanonical
        ? 'market_anchor_refresh'
        : 'continuous_price',
    });
  }

  _marketAnchor(mint, now) {
    const token = this.tokenRegistry?.getToken?.(mint);
    const marketUpdatedAt = finiteNumber(token?.market_updated_at, null);
    if (!marketUpdatedAt || now - marketUpdatedAt > this.marketMaxAgeMs) return null;

    const cached = this.marketAnchors.get(mint);
    if (cached?.updatedAt === marketUpdatedAt) return cached;

    let meta = null;
    try {
      meta = token?.meta_json ? JSON.parse(token.meta_json) : null;
    } catch (_) {}
    const marketSol = finitePositive(token?.price_sol ?? meta?.priceSol);
    const marketUsd = finitePositive(token?.price);
    const price = marketSol || (marketUsd ? marketUsd / this.solPriceUsd : null);
    if (!price) return null;

    const anchor = { price, updatedAt: marketUpdatedAt };
    this.marketAnchors.set(mint, anchor);
    return anchor;
  }

  _hasPlausiblePool(swap) {
    if (this.minPoolQuoteSol <= 0) return true;
    return finitePositive(swap?.poolQuoteAfter) >= this.minPoolQuoteSol;
  }

  _isFeatureSource(source) {
    return source === 'direct' || source === 'cpi';
  }

  _directEvidenceKey(swap) {
    const source = String(swap?.source || 'direct').toLowerCase();
    const pool = String(swap?.poolAddress || '').trim();
    return `${source}:${pool || 'unknown-pool'}`;
  }

  _confirmDirectJump(mint, price, ts, swap) {
    if (!this._hasPlausiblePool(swap)) return false;
    let samples = this.pending.get(mint) || [];
    samples = samples.filter((sample) => ts - sample.ts <= this.confirmWindowMs);
    const latest = samples[samples.length - 1];
    if (latest && distanceRatio(price, latest.price) > this.confirmClusterRatio) samples = [];
    samples.push({ price, ts, evidenceKey: this._directEvidenceKey(swap) });
    this.pending.set(mint, samples);
    if (samples.length < this.confirmMinSamples) return false;
    const recent = samples.slice(-this.confirmMinSamples);
    if (recent[recent.length - 1].ts - recent[0].ts < this.confirmMinSpanMs) return false;
    const independentSources = new Set(recent.map((sample) => sample.evidenceKey));
    if (independentSources.size < this.confirmMinIndependentSources) return false;
    this.pending.delete(mint);
    return true;
  }

  _accept(swap, price, priceBefore, context) {
    const previousPrice = this.prices.get(swap.mint)?.price ?? null;
    const rawCleanPriceBefore = finitePositive(priceBefore);
    let cleanPriceBefore = rawCleanPriceBefore;
    if (!cleanPriceBefore || distanceRatio(cleanPriceBefore, price) > this.maxJumpRatio) {
      cleanPriceBefore = previousPrice || price;
    }
    const priceChangePct = ((price - cleanPriceBefore) / cleanPriceBefore) * 100;
    this.prices.set(swap.mint, { price, ts: finiteNumber(swap.ts, Date.now()), source: context.source });
    return {
      event: this._event(swap, {
        ...context,
        price,
        priceBefore: cleanPriceBefore,
        priceChangePct,
        rawPrice: finitePositive(swap.price),
        rawPriceBefore: finitePositive(swap.priceBefore),
        priceReliable: swap.priceReliable !== false,
        priceSanitized: cleanPriceBefore !== rawCleanPriceBefore,
        featureEligible: true,
        sanitizerReason: context.reason,
        dataQualityVersion: this.dataQualityVersion,
      }),
      status: 'accepted',
      reason: context.reason,
    };
  }

  _volumeOnly(swap, context) {
    return {
      event: this._event(swap, {
        ...context,
        price: null,
        priceBefore: null,
        priceChangePct: null,
        priceReliable: false,
        priceSanitized: true,
        featureEligible: false,
        sanitizerReason: context.reason,
        dataQualityVersion: this.dataQualityVersion,
      }),
      status: 'volume_only',
      reason: context.reason,
    };
  }

  _fallback(swap, price, context) {
    const result = {
      event: this._event(swap, {
        ...context,
        price,
        priceBefore: price,
        priceChangePct: 0,
        priceReliable: false,
        priceSanitized: true,
        featureEligible: false,
        sanitizerReason: context.reason,
        dataQualityVersion: this.dataQualityVersion,
      }),
      status: 'sanitized',
      reason: context.reason,
    };
    if (this.debug) {
      console.warn(
        `[SwapSanitizer] ${swap.mint.slice(0, 6)} ${context.reason}: ` +
          `raw=${context.rawPrice || 'n/a'} anchor=${price}`,
      );
    }
    return result;
  }

  _event(swap, values) {
    return {
      ...swap,
      side: values.side,
      solVolume: values.solVolume,
      price: values.price,
      priceBefore: values.priceBefore,
      priceChangePct: values.priceChangePct === null
        ? null
        : values.priceChangePct ?? finiteNumber(swap.priceChangePct, 0),
      source: values.source,
      rawPrice: values.rawPrice,
      rawPriceBefore: values.rawPriceBefore,
      priceReliable: values.priceReliable,
      priceSanitized: values.priceSanitized,
      featureEligible: values.featureEligible,
      sanitizerReason: values.sanitizerReason,
      dataQualityVersion: values.dataQualityVersion,
    };
  }

  _reject(reason) {
    return { event: null, status: 'rejected', reason };
  }
}

module.exports = SwapEventSanitizer;
module.exports.distanceRatio = distanceRatio;
