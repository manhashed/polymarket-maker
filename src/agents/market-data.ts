import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import type { BinanceTrade } from '../types.js';

const log = childLogger('MarketDataAgent');

export class MarketDataAgent extends EventEmitter {
  private ws: WebSocket | null = null;
  private lastPrice = 0;
  private lastTimestamp = 0;
  private ewmaVariance = 0;
  private tradeCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private alive = false;

  get btcPrice(): number {
    return this.lastPrice;
  }

  get btcTimestamp(): number {
    return this.lastTimestamp;
  }

  get annualizedVol(): number {
    // ~1 trade/sec on BTCUSDT → 31,536,000 trades/year
    // vol = sqrt(variance * trades_per_year)
    return Math.sqrt(this.ewmaVariance * 31_536_000);
  }

  start(): void {
    this.alive = true;
    this.connect();
  }

  stop(): void {
    this.alive = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (!this.alive) return;
    log.info({ url: CONFIG.BINANCE_WS_URL }, 'Connecting to Binance');

    this.ws = new WebSocket(CONFIG.BINANCE_WS_URL);

    this.ws.on('open', () => {
      log.info('Binance WebSocket connected');
    });

    this.ws.on('message', (raw: Buffer) => {
      const recvTs = performance.now();
      try {
        const trade: BinanceTrade = JSON.parse(raw.toString());
        this.onTrade(trade, recvTs);
      } catch (err) {
        log.error({ err }, 'Failed to parse Binance trade');
      }
    });

    this.ws.on('close', (code: number) => {
      log.warn({ code }, 'Binance WebSocket closed');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      log.error({ err: err.message }, 'Binance WebSocket error');
    });
  }

  private onTrade(trade: BinanceTrade, recvTs: number): void {
    const price = parseFloat(trade.p);
    const ts = trade.T;

    if (this.lastPrice > 0) {
      const logReturn = Math.log(price / this.lastPrice);
      const squaredReturn = logReturn * logReturn;
      this.ewmaVariance =
        CONFIG.VOL_EWMA_ALPHA * squaredReturn +
        (1 - CONFIG.VOL_EWMA_ALPHA) * this.ewmaVariance;
    }

    this.lastPrice = price;
    this.lastTimestamp = ts;
    this.tradeCount++;

    this.emit('price', {
      price,
      timestamp: ts,
      volatility: this.annualizedVol,
      latencyMs: recvTs,
    });
  }

  private scheduleReconnect(): void {
    if (!this.alive) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 1000);
  }
}
