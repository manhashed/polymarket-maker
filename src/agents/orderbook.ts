import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import type { ActiveMarketContext } from '../strategies/types.js';
import type {
  L2Book,
  PriceLevel,
  PolymarketMarketMsg,
  PolymarketUserMsg,
} from '../types.js';

const log = childLogger('OrderbookAgent');

export class OrderbookAgent extends EventEmitter {
  private marketWs: WebSocket | null = null;
  private userWs: WebSocket | null = null;
  private alive = false;
  private reconnectTimers: ReturnType<typeof setTimeout>[] = [];
  private market: ActiveMarketContext | null = null;

  private yesBook: L2Book = { bids: [], asks: [], timestamp: 0 };
  private noBook: L2Book = { bids: [], asks: [], timestamp: 0 };

  get yesOrderbook(): L2Book {
    return this.yesBook;
  }

  get noOrderbook(): L2Book {
    return this.noBook;
  }

  start(): void {
    this.alive = true;
    log.info('OrderbookAgent started (waiting for market assignment)');
  }

  switchMarket(market: ActiveMarketContext): void {
    this.market = market;
    this.yesBook = { bids: [], asks: [], timestamp: 0 };
    this.noBook = { bids: [], asks: [], timestamp: 0 };

    this.disconnectAll();
    this.connectMarket();
    this.connectUser();

    log.info(
      { conditionId: market.conditionId },
      'OrderbookAgent switched market',
    );
  }

  stop(): void {
    this.alive = false;
    this.reconnectTimers.forEach(clearTimeout);
    this.disconnectAll();
  }

  private disconnectAll(): void {
    [this.marketWs, this.userWs].forEach((ws) => {
      if (ws) {
        ws.removeAllListeners();
        ws.close();
      }
    });
    this.marketWs = null;
    this.userWs = null;
  }

  private connectMarket(): void {
    if (!this.alive || !this.market) return;
    log.info('Connecting to Polymarket market WebSocket');

    this.marketWs = new WebSocket(CONFIG.WS_MARKET_URL);

    this.marketWs.on('open', () => {
      log.info('Market WebSocket connected');
      const sub = JSON.stringify({
        assets_ids: [this.market!.yesTokenId, this.market!.noTokenId],
        type: 'market',
        custom_feature_enabled: true,
      });
      this.marketWs!.send(sub);
      log.info('Subscribed to market channel');
    });

    this.marketWs.on('message', (raw: Buffer) => {
      const recvTs = performance.now();
      try {
        const msg = JSON.parse(raw.toString());
        if (Array.isArray(msg)) {
          msg.forEach((m) => this.handleMarketMsg(m, recvTs));
        } else {
          this.handleMarketMsg(msg as PolymarketMarketMsg, recvTs);
        }
      } catch (err) {
        log.error({ err }, 'Failed to parse market WS message');
      }
    });

    this.marketWs.on('close', (code: number) => {
      log.warn({ code }, 'Market WebSocket closed');
      this.scheduleReconnect(() => this.connectMarket());
    });

    this.marketWs.on('error', (err: Error) => {
      log.error({ err: err.message }, 'Market WebSocket error');
    });
  }

  private connectUser(): void {
    if (!this.alive || !this.market) return;
    log.info('Connecting to Polymarket user WebSocket');

    this.userWs = new WebSocket(CONFIG.WS_USER_URL);

    this.userWs.on('open', () => {
      log.info('User WebSocket connected');
      const sub = JSON.stringify({
        auth: {
          apiKey: CONFIG.API_KEY,
          secret: CONFIG.API_SECRET,
          passphrase: CONFIG.API_PASSPHRASE,
        },
        markets: [this.market!.conditionId],
        type: 'user',
      });
      this.userWs!.send(sub);
      log.info('Subscribed to user channel');
    });

    this.userWs.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (Array.isArray(msg)) {
          msg.forEach((m) => this.handleUserMsg(m));
        } else {
          this.handleUserMsg(msg as PolymarketUserMsg);
        }
      } catch (err) {
        log.error({ err }, 'Failed to parse user WS message');
      }
    });

    this.userWs.on('close', (code: number) => {
      log.warn({ code }, 'User WebSocket closed');
      this.scheduleReconnect(() => this.connectUser());
    });

    this.userWs.on('error', (err: Error) => {
      log.error({ err: err.message }, 'User WebSocket error');
    });
  }

  private handleMarketMsg(msg: PolymarketMarketMsg, recvTs: number): void {
    if (!this.market) return;

    if (msg.event_type === 'book') {
      const book = this.parseBook(msg.bids, msg.asks, parseInt(msg.timestamp));
      if (msg.asset_id === this.market.yesTokenId) {
        this.yesBook = book;
      } else if (msg.asset_id === this.market.noTokenId) {
        this.noBook = book;
      }
      this.emit('book_update', { assetId: msg.asset_id, book, recvTs });
    }

    if (msg.event_type === 'price_change') {
      for (const pc of msg.price_changes) {
        const target =
          pc.asset_id === this.market.yesTokenId ? this.yesBook : this.noBook;
        this.applyPriceChange(target, pc);
      }
      this.emit('price_change', { msg, recvTs });
    }

    if (msg.event_type === 'last_trade_price') {
      this.emit('last_trade', { assetId: msg.asset_id, price: parseFloat(msg.price), side: msg.side });
    }
  }

  private handleUserMsg(msg: PolymarketUserMsg): void {
    if (msg.event_type === 'trade' && msg.type === 'TRADE') {
      log.info(
        {
          side: (msg as any).side,
          price: (msg as any).price,
          size: (msg as any).size,
          status: (msg as any).status,
        },
        'Trade fill received',
      );
      this.emit('fill', msg);
    }

    if (msg.event_type === 'order') {
      this.emit('order_update', msg);
    }
  }

  private parseBook(
    rawBids: Array<{ price: string; size: string }>,
    rawAsks: Array<{ price: string; size: string }>,
    timestamp: number,
  ): L2Book {
    const bids: PriceLevel[] = rawBids
      .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .sort((a, b) => b.price - a.price);
    const asks: PriceLevel[] = rawAsks
      .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .sort((a, b) => a.price - b.price);
    return { bids, asks, timestamp };
  }

  private applyPriceChange(
    book: L2Book,
    change: { price: string; size: string; side: string },
  ): void {
    const price = parseFloat(change.price);
    const size = parseFloat(change.size);
    const levels = change.side === 'BUY' ? book.bids : book.asks;

    const idx = levels.findIndex((l) => l.price === price);
    if (size === 0) {
      if (idx >= 0) levels.splice(idx, 1);
    } else if (idx >= 0) {
      levels[idx].size = size;
    } else {
      levels.push({ price, size });
      if (change.side === 'BUY') {
        levels.sort((a, b) => b.price - a.price);
      } else {
        levels.sort((a, b) => a.price - b.price);
      }
    }
    book.timestamp = Date.now();
  }

  private scheduleReconnect(fn: () => void): void {
    if (!this.alive) return;
    const timer = setTimeout(fn, 2000);
    this.reconnectTimers.push(timer);
  }
}
