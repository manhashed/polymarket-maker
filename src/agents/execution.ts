import { EventEmitter } from 'node:events';
import { Wallet } from 'ethers';
import { CONFIG } from '../config.js';
import { childLogger } from '../utils/logger.js';
import { buildOrder, signOrder, type BuildOrderParams } from '../signing/eip712.js';
import { buildL2Headers } from '../signing/hmac.js';
import type { ActiveMarketContext } from '../strategies/types.js';
import {
  Side,
  type Quote,
  type SignedOrder,
  type ActiveOrders,
  type OrderResponse,
  type CancelResponse,
  type HeartbeatResponse,
} from '../types.js';

const log = childLogger('ExecutionAgent');

const SIDE_STR: Record<number, string> = { 0: 'BUY', 1: 'SELL' };

function buildOrderPayload(signed: SignedOrder, orderType: string) {
  return {
    order: {
      salt: parseInt(signed.salt, 10),
      maker: signed.maker,
      signer: signed.signer,
      taker: signed.taker,
      tokenId: signed.tokenId,
      makerAmount: signed.makerAmount,
      takerAmount: signed.takerAmount,
      side: SIDE_STR[signed.side],
      expiration: signed.expiration,
      nonce: signed.nonce,
      feeRateBps: signed.feeRateBps,
      signatureType: signed.signatureType,
      signature: signed.signature,
    },
    owner: CONFIG.API_KEY,
    orderType,
    deferExec: false,
  };
}

export class ExecutionAgent extends EventEmitter {
  private wallet: Wallet;
  private market: ActiveMarketContext | null = null;
  private feeRateBps = '0';
  private active: ActiveOrders = {
    bidOrderId: null,
    askOrderId: null,
    bidPrice: 0,
    askPrice: 0,
    bidSize: 0,
    askSize: 0,
  };
  private heartbeatId = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cancelInFlight = false;

  constructor(wallet: Wallet) {
    super();
    this.wallet = wallet;
  }

  get activeOrders(): ActiveOrders {
    return { ...this.active };
  }

  async init(): Promise<void> {
    this.startHeartbeat();
    log.info('ExecutionAgent initialized (waiting for market assignment)');
  }

  async setMarket(market: ActiveMarketContext): Promise<void> {
    await this.cancelAll();
    this.market = market;
    await this.fetchFeeRate();
    log.info(
      { conditionId: market.conditionId, feeRateBps: this.feeRateBps },
      'ExecutionAgent switched market',
    );
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  async cancelAndReplace(quote: Quote): Promise<{ cycleMs: number; signMs: number; cancelMs: number; submitMs: number }> {
    if (this.cancelInFlight || !this.market) {
      return { cycleMs: 0, signMs: 0, cancelMs: 0, submitMs: 0 };
    }

    this.cancelInFlight = true;
    const cycleStart = performance.now();

    try {
      const signStart = performance.now();
      const [signedBid, signedAsk, _cancelResult] = await Promise.all([
        this.signNewOrder(this.market.yesTokenId, Side.BUY, quote.bidPrice, quote.bidSize),
        this.signNewOrder(this.market.yesTokenId, Side.SELL, quote.askPrice, quote.askSize),
        this.cancelExisting(),
      ]);
      const signMs = performance.now() - signStart;

      const submitStart = performance.now();
      const [bidResult, askResult] = await this.submitOrdersBatch(signedBid, signedAsk);
      const submitMs = performance.now() - submitStart;

      this.active = {
        bidOrderId: bidResult?.orderID ?? null,
        askOrderId: askResult?.orderID ?? null,
        bidPrice: quote.bidPrice,
        askPrice: quote.askPrice,
        bidSize: quote.bidSize,
        askSize: quote.askSize,
      };

      const cycleMs = performance.now() - cycleStart;
      const cancelMs = signMs;

      log.info(
        { cycleMs: cycleMs.toFixed(1), signMs: signMs.toFixed(1), submitMs: submitMs.toFixed(1), bid: quote.bidPrice, ask: quote.askPrice },
        'Cancel/replace cycle complete',
      );

      this.emit('cycle_complete', { cycleMs, signMs, cancelMs, submitMs });
      return { cycleMs, signMs, cancelMs, submitMs };
    } catch (err) {
      log.error({ err }, 'Cancel/replace cycle failed');
      this.emit('cycle_error', err);
      return { cycleMs: performance.now() - cycleStart, signMs: 0, cancelMs: 0, submitMs: 0 };
    } finally {
      this.cancelInFlight = false;
    }
  }

  async cancelAll(): Promise<void> {
    try {
      await this.httpRequest('DELETE', '/cancel-all');
      this.active = { bidOrderId: null, askOrderId: null, bidPrice: 0, askPrice: 0, bidSize: 0, askSize: 0 };
      log.info('All orders cancelled');
    } catch (err) {
      log.error({ err }, 'Failed to cancel all');
    }
  }

  handleFill(orderId: string, filledAmount: number, side: string): void {
    if (orderId === this.active.bidOrderId) {
      this.active.bidSize = Math.max(0, this.active.bidSize - filledAmount);
      if (this.active.bidSize <= 0) this.active.bidOrderId = null;
    } else if (orderId === this.active.askOrderId) {
      this.active.askSize = Math.max(0, this.active.askSize - filledAmount);
      if (this.active.askSize <= 0) this.active.askOrderId = null;
    }
    this.emit('fill_processed', { orderId, filledAmount, side });
  }

  private async signNewOrder(
    tokenId: string,
    side: Side,
    price: number,
    size: number,
  ): Promise<SignedOrder> {
    const negRisk = this.market?.negRisk ?? false;
    const params: BuildOrderParams = {
      tokenId,
      side,
      price,
      size,
      feeRateBps: this.feeRateBps,
      negRisk,
    };
    const order = buildOrder(params);
    return signOrder(this.wallet, order, negRisk);
  }

  private async cancelExisting(): Promise<CancelResponse | null> {
    const hasOrders = this.active.bidOrderId || this.active.askOrderId;
    if (!hasOrders || !this.market) return null;

    try {
      const body = JSON.stringify({
        market: this.market.conditionId,
        asset_id: this.market.yesTokenId,
      });
      return await this.httpRequest<CancelResponse>('DELETE', '/cancel-market-orders', body);
    } catch (err) {
      log.error({ err }, 'Cancel failed');
      return null;
    }
  }

  private async submitOrdersBatch(
    bid: SignedOrder,
    ask: SignedOrder,
  ): Promise<[OrderResponse | null, OrderResponse | null]> {
    const bidPayload = buildOrderPayload(bid, 'GTC');
    const askPayload = buildOrderPayload(ask, 'GTC');
    const body = JSON.stringify([bidPayload, askPayload]);

    try {
      const results = await this.httpRequest<OrderResponse[]>('POST', '/orders', body);
      return [results?.[0] ?? null, results?.[1] ?? null];
    } catch (err) {
      log.error({ err }, 'Batch order submission failed, falling back to individual');
      const [bidRes, askRes] = await Promise.all([
        this.submitSingle(bidPayload),
        this.submitSingle(askPayload),
      ]);
      return [bidRes, askRes];
    }
  }

  private async submitSingle(payload: ReturnType<typeof buildOrderPayload>): Promise<OrderResponse | null> {
    try {
      return await this.httpRequest<OrderResponse>('POST', '/order', JSON.stringify(payload));
    } catch (err) {
      log.error({ err }, 'Single order submission failed');
      return null;
    }
  }

  private async fetchFeeRate(): Promise<void> {
    if (!this.market) return;
    try {
      const resp = await fetch(
        `${CONFIG.CLOB_URL}/fee-rate?token_id=${this.market.yesTokenId}`,
      );
      const data = (await resp.json()) as { fee_rate_bps?: string; base_fee?: number };
      this.feeRateBps = data.fee_rate_bps ?? '0';
      log.info({ feeRateBps: this.feeRateBps }, 'Fetched fee rate');
    } catch (err) {
      log.warn({ err }, 'Failed to fetch fee rate, defaulting to 0');
      this.feeRateBps = '0';
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        const body = JSON.stringify({ heartbeat_id: this.heartbeatId || null });
        const resp = await this.httpRequest<HeartbeatResponse>('POST', '/v1/heartbeats', body);
        if (resp?.heartbeat_id) this.heartbeatId = resp.heartbeat_id;
      } catch (err) {
        log.error({ err }, 'Heartbeat failed');
      }
    }, CONFIG.HEARTBEAT_INTERVAL_MS);
  }

  private async httpRequest<T>(method: string, path: string, body?: string): Promise<T | null> {
    const url = CONFIG.CLOB_URL + path;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...buildL2Headers(method, path, body),
    };

    const resp = await fetch(url, {
      method: method === 'DELETE' ? 'DELETE' : 'POST',
      headers,
      body: method !== 'DELETE' || body ? body : undefined,
      keepalive: true,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log.error({ status: resp.status, path, errText }, 'HTTP request failed');
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }

    const text = await resp.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  }
}
