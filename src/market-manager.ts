import { EventEmitter } from 'node:events';
import { childLogger } from './utils/logger.js';
import type { MarketStrategy, MarketInfo, ActiveMarketContext } from './strategies/types.js';

const log = childLogger('MarketManager');

export class MarketManager extends EventEmitter {
  private strategy: MarketStrategy;
  private current: ActiveMarketContext | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private alive = false;
  private initialBtcPrice = 0;

  constructor(strategy: MarketStrategy) {
    super();
    this.strategy = strategy;
  }

  get activeMarket(): ActiveMarketContext | null {
    return this.current;
  }

  get quotingCutoffMs(): number {
    return this.strategy.quotingCutoffMs;
  }

  setInitialBtcPrice(price: number): void {
    this.initialBtcPrice = price;
  }

  async start(): Promise<void> {
    this.alive = true;
    await this.discoverAndSwitch();
    this.pollTimer = setInterval(
      () => this.tick(),
      this.strategy.discoveryIntervalMs,
    );
    log.info(
      { strategy: this.strategy.name, intervalMs: this.strategy.discoveryIntervalMs },
      'MarketManager started',
    );
  }

  stop(): void {
    this.alive = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  computeFairValue(
    btcPrice: number,
    volatility: number,
    timeToExpiryMs: number,
  ): number {
    if (!this.current) return 0.5;
    return this.strategy.computeFairValue(
      btcPrice,
      this.current.strikePrice,
      volatility,
      timeToExpiryMs,
    );
  }

  getTimeToExpiryMs(): number {
    if (!this.current) return 0;
    return Math.max(0, this.current.expiresAt - Date.now());
  }

  private async tick(): Promise<void> {
    if (!this.alive) return;

    const tte = this.getTimeToExpiryMs();

    if (tte <= 0 || !this.current) {
      log.info('Current market expired or missing, discovering next...');
      await this.discoverAndSwitch();
      return;
    }

    if (tte < this.strategy.discoveryIntervalMs * 2) {
      log.info({ tteMs: tte }, 'Market expiring soon, pre-fetching next...');
      const next = await this.strategy.discoverActiveMarket();
      if (next && next.conditionId !== this.current.conditionId) {
        log.info(
          { next: next.description, expiresAt: new Date(next.expiresAt).toISOString() },
          'Next market pre-fetched, will switch on expiry',
        );
      }
    }
  }

  private async discoverAndSwitch(): Promise<void> {
    const market = await this.strategy.discoverActiveMarket();
    if (!market) {
      log.warn('No active market found');
      return;
    }

    if (this.current && this.current.conditionId === market.conditionId) {
      return;
    }

    const strikePrice = this.initialBtcPrice > 0
      ? this.initialBtcPrice
      : 0;

    const prev = this.current;
    this.current = { ...market, strikePrice };

    log.info(
      {
        conditionId: market.conditionId,
        description: market.description,
        expiresAt: new Date(market.expiresAt).toISOString(),
        strikePrice,
      },
      'Switched to new market',
    );

    this.emit('market_switch', {
      prev: prev ?? null,
      current: this.current,
    });
  }

  updateStrikePrice(btcPrice: number): void {
    if (!this.current || this.current.strikePrice > 0) return;
    this.current.strikePrice = btcPrice;
    log.info({ strikePrice: btcPrice }, 'Strike price locked from BTC feed');
  }
}
