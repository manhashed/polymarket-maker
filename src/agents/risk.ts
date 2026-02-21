import { EventEmitter } from 'node:events';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import type { Position, Quote } from '../types.js';

const log = childLogger('RiskAgent');

export const enum RiskAction {
  ALLOW = 'ALLOW',
  REDUCE_ONLY = 'REDUCE_ONLY',
  HALT = 'HALT',
}

export class RiskAgent extends EventEmitter {
  private position: Position = {
    yesShares: 0,
    noShares: 0,
    netDelta: 0,
    avgEntryPrice: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
  };
  private halted = false;

  get currentPosition(): Position {
    return { ...this.position };
  }

  get isHalted(): boolean {
    return this.halted;
  }

  /**
   * Process a fill event and update the position.
   *
   * BUY fill → increase YES shares (we bought YES tokens)
   * SELL fill → decrease YES shares (we sold YES tokens)
   * netDelta = yesShares (positive = long YES, negative = short)
   */
  processFill(side: string, price: number, size: number): void {
    if (side === 'BUY') {
      const newShares = this.position.yesShares + size;
      this.position.avgEntryPrice =
        (this.position.avgEntryPrice * this.position.yesShares + price * size) / newShares;
      this.position.yesShares = newShares;
    } else {
      const pnl = (price - this.position.avgEntryPrice) * size;
      this.position.realizedPnl += pnl;
      this.position.yesShares -= size;
    }

    this.position.netDelta = this.position.yesShares;

    log.info(
      {
        yesShares: this.position.yesShares.toFixed(2),
        netDelta: this.position.netDelta.toFixed(2),
        realizedPnl: this.position.realizedPnl.toFixed(4),
      },
      'Position updated',
    );

    this.emit('position_update', this.position);
    this.checkLimits();
  }

  updateUnrealizedPnl(currentFairValue: number): void {
    this.position.unrealizedPnl =
      (currentFairValue - this.position.avgEntryPrice) * this.position.yesShares;
  }

  /**
   * Pre-trade risk check. Returns what action is allowed.
   */
  checkQuote(quote: Quote): RiskAction {
    if (this.halted) return RiskAction.HALT;

    const absPosition = Math.abs(this.position.netDelta);
    const totalPnl = this.position.realizedPnl + this.position.unrealizedPnl;

    if (totalPnl < -CONFIG.MAX_LOSS) {
      log.error({ totalPnl }, 'Max loss breached — HALTING');
      this.halted = true;
      this.emit('halt', 'max_loss_breached');
      return RiskAction.HALT;
    }

    const notional = absPosition * (quote.fairValue || 0.5);
    if (notional > CONFIG.MAX_NOTIONAL) {
      log.warn({ notional }, 'Max notional exceeded — REDUCE_ONLY');
      return RiskAction.REDUCE_ONLY;
    }

    if (absPosition > CONFIG.MAX_POSITION) {
      log.warn({ absPosition }, 'Max position exceeded — REDUCE_ONLY');
      return RiskAction.REDUCE_ONLY;
    }

    return RiskAction.ALLOW;
  }

  /**
   * Adjust quote sizes based on risk action.
   * REDUCE_ONLY: only quote on the side that reduces position.
   * HALT: zero all sizes.
   */
  applyRiskAdjustment(quote: Quote, action: RiskAction): Quote {
    if (action === RiskAction.HALT) {
      return { ...quote, bidSize: 0, askSize: 0 };
    }

    if (action === RiskAction.REDUCE_ONLY) {
      if (this.position.netDelta > 0) {
        return { ...quote, bidSize: 0 };
      }
      return { ...quote, askSize: 0 };
    }

    return quote;
  }

  unhalt(): void {
    this.halted = false;
    log.info('Risk halt cleared');
  }

  resetForNewMarket(): void {
    this.position = {
      yesShares: 0,
      noShares: 0,
      netDelta: 0,
      avgEntryPrice: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
    };
    this.halted = false;
    log.info('Position reset for new market');
    this.emit('position_update', this.position);
  }

  private checkLimits(): void {
    const totalPnl = this.position.realizedPnl + this.position.unrealizedPnl;
    if (totalPnl < -CONFIG.MAX_LOSS) {
      this.halted = true;
      this.emit('halt', 'max_loss_breached');
    }
  }
}
