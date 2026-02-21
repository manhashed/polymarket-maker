import { EventEmitter } from 'node:events';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import type { Quote, Position } from '../types.js';

const log = childLogger('QuotingAgent');

function roundToTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

function clampPrice(price: number, tickSize: number): number {
  return Math.max(tickSize, Math.min(1 - tickSize, roundToTick(price, tickSize)));
}

export class QuotingAgent extends EventEmitter {
  private lastQuote: Quote | null = null;
  private btcPrice = 0;
  private volatility = 0;
  private tickSize = 0.001;
  private position: Position = {
    yesShares: 0,
    noShares: 0,
    netDelta: 0,
    avgEntryPrice: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
  };

  get currentQuote(): Quote | null {
    return this.lastQuote;
  }

  setTickSize(tickSize: number): void {
    this.tickSize = tickSize;
  }

  updatePosition(pos: Position): void {
    this.position = pos;
  }

  updateMarketData(btcPrice: number, volatility: number): void {
    this.btcPrice = btcPrice;
    this.volatility = volatility;
  }

  /**
   * Spread widening based on realized vol.
   *
   * Low vol  → use MIN_SPREAD_BPS
   * High vol → scale up toward MAX_SPREAD_BPS
   *
   * Threshold: 30% annualized vol is "normal" for BTC.
   * Above 80% vol, use max spread.
   */
  computeSpread(): number {
    const volNormalized = Math.min(1, Math.max(0, (this.volatility - 0.30) / 0.50));
    const spreadBps =
      CONFIG.MIN_SPREAD_BPS + volNormalized * (CONFIG.MAX_SPREAD_BPS - CONFIG.MIN_SPREAD_BPS);
    return spreadBps / 10000;
  }

  /**
   * Compute bid/ask quotes given a fair value from the strategy.
   *
   * Inventory skew: shifts the entire quote in the direction that
   * reduces the current position.
   */
  computeQuote(fairValue: number): Quote | null {
    if (fairValue <= 0 || fairValue >= 1) return null;

    const halfSpread = this.computeSpread() / 2;
    const inventorySkew = -this.position.netDelta * CONFIG.INVENTORY_SKEW_FACTOR;

    const rawBid = fairValue - halfSpread + inventorySkew;
    const rawAsk = fairValue + halfSpread + inventorySkew;

    const tick = this.tickSize;
    const bidPrice = clampPrice(rawBid, tick);
    const askPrice = clampPrice(rawAsk, tick);

    if (bidPrice >= askPrice) return null;

    const quote: Quote = {
      bidPrice,
      askPrice,
      bidSize: CONFIG.ORDER_SIZE,
      askSize: CONFIG.ORDER_SIZE,
      fairValue,
      spread: askPrice - bidPrice,
      timestamp: Date.now(),
    };

    const shouldRequote = this.shouldRequote(quote);
    this.lastQuote = quote;

    if (shouldRequote) {
      this.emit('new_quote', quote);
    }

    return quote;
  }

  resetForNewMarket(): void {
    this.lastQuote = null;
    this.position = {
      yesShares: 0,
      noShares: 0,
      netDelta: 0,
      avgEntryPrice: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
    };
  }

  private shouldRequote(newQuote: Quote): boolean {
    if (!this.lastQuote) return true;

    const bidDiffBps =
      Math.abs(newQuote.bidPrice - this.lastQuote.bidPrice) / this.lastQuote.bidPrice * 10000;
    const askDiffBps =
      Math.abs(newQuote.askPrice - this.lastQuote.askPrice) / this.lastQuote.askPrice * 10000;

    return bidDiffBps >= CONFIG.REQUOTE_THRESHOLD_BPS || askDiffBps >= CONFIG.REQUOTE_THRESHOLD_BPS;
  }
}
