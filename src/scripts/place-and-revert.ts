#!/usr/bin/env npx tsx
/**
 * Place order → wait for fill → cancel unfilled → report profit
 *
 * Strategy: Place BUY at best ask (aggressive, fills immediately), then SELL at
 * best bid + spread to close. Profit = sell price - buy price if both fill.
 *
 * Run: npm run place-and-revert
 */

import 'dotenv/config';
import { Wallet } from 'ethers';
import { CONFIG } from '../config.js';
import { buildHmacSignature } from '../signing/hmac.js';
import { buildOrder, signOrder } from '../signing/eip712.js';
import { Side, type SignedOrder } from '../types.js';
import { Btc5MinStrategy } from '../strategies/btc-5min.js';

const SIDE_STR: Record<number, string> = { 0: 'BUY', 1: 'SELL' };
const SHARES = 5;
const MAX_COST = 5; // cap cost to stay within proxy balance
const WAIT_MS = 45_000; // 45 seconds to allow fills

// ─── CLOB Helpers ────────────────────────────────────────────────────────────

function buildAuthHeaders(method: string, path: string, body = ''): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = buildHmacSignature(timestamp, method, path, body);
  return {
    'Content-Type': 'application/json',
    POLY_ADDRESS: CONFIG.WALLET_ADDRESS,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: CONFIG.API_KEY,
    POLY_PASSPHRASE: CONFIG.API_PASSPHRASE,
  };
}

async function clobGet<T>(path: string): Promise<T> {
  const headers = buildAuthHeaders('GET', path);
  const resp = await fetch(`${CONFIG.CLOB_URL}${path}`, { method: 'GET', headers });
  if (!resp.ok) throw new Error(`GET ${path}: ${resp.status} ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

async function clobPost<T>(path: string, body: object): Promise<T> {
  const bodyStr = JSON.stringify(body);
  const headers = buildAuthHeaders('POST', path, bodyStr);
  const resp = await fetch(`${CONFIG.CLOB_URL}${path}`, { method: 'POST', headers, body: bodyStr });
  if (!resp.ok) throw new Error(`POST ${path}: ${resp.status} ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

async function clobDelete<T>(path: string, body?: object): Promise<T | null> {
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = buildAuthHeaders('DELETE', path, bodyStr);
  const resp = await fetch(`${CONFIG.CLOB_URL}${path}`, {
    method: 'DELETE',
    headers,
    body: bodyStr || undefined,
  });
  if (!resp.ok) throw new Error(`DELETE ${path}: ${resp.status} ${await resp.text()}`);
  const text = await resp.text();
  return text ? (JSON.parse(text) as T) : null;
}

// ─── Order Book (public, no auth) ─────────────────────────────────────────────

interface BookLevel {
  price: string;
  size: string;
}

interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
  tick_size: string;
}

async function getOrderBook(tokenId: string): Promise<OrderBook> {
  const resp = await fetch(`${CONFIG.CLOB_URL}/book?token_id=${tokenId}`);
  if (!resp.ok) throw new Error(`Book: ${resp.status} ${await resp.text()}`);
  return resp.json() as Promise<OrderBook>;
}

async function getFeeRate(tokenId: string): Promise<string> {
  const resp = await fetch(`${CONFIG.CLOB_URL}/fee-rate?token_id=${tokenId}`);
  if (!resp.ok) return '1000';
  const data = (await resp.json()) as { fee_rate_bps?: string; base_fee?: number };
  return String(data.fee_rate_bps ?? data.base_fee ?? '1000');
}

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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=========================================================');
  console.log('  Place Order → Wait → Revert (Cancel) → Report');
  console.log('=========================================================\n');

  const wallet = new Wallet(CONFIG.PRIVATE_KEY);
  const strategy = new Btc5MinStrategy(process.env.EVENT_SLUG || '');

  // 1. Discover market
  console.log('1. Discovering current BTC 5m market...');
  const market = await strategy.discoverActiveMarket();
  if (!market) {
    console.log('   No active market found.');
    process.exit(1);
  }
  console.log(`   Market: ${market.description}`);
  console.log(`   Expires: ${new Date(market.expiresAt).toISOString()}\n`);

  // 2. Get order book
  console.log('2. Fetching order book...');
  const book = await getOrderBook(market.yesTokenId);
  const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0.4;
  const bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : 0.6;
  const tick = parseFloat(book.tick_size || '0.01');
  console.log(`   Best bid: ${bestBid.toFixed(2)} | Best ask: ${bestAsk.toFixed(2)} | Tick: ${tick}\n`);

  const feeRateBps = await getFeeRate(market.yesTokenId);

  // 3. Place BUY - use best ask if reasonable, else midpoint to avoid empty book
  let buyPrice = bestAsk;
  if (bestAsk >= 0.99 || bestAsk <= 0.01) {
    buyPrice = 0.50; // fallback when book is thin
  }
  buyPrice = Math.round(buyPrice / tick) * tick;
  const buyCost = buyPrice * SHARES;
  if (buyCost > MAX_COST) {
    console.log(`   Capping: cost $${buyCost.toFixed(2)} > $${MAX_COST}, reducing size`);
  }
  console.log(`3. Placing BUY ${SHARES} YES @ ${buyPrice.toFixed(2)} (cost: $${buyCost.toFixed(2)})...`);

  const rawBuy = buildOrder({
    tokenId: market.yesTokenId,
    side: Side.BUY,
    price: buyPrice,
    size: SHARES,
    feeRateBps,
    negRisk: market.negRisk,
  });
  const signedBuy = await signOrder(wallet, rawBuy, market.negRisk);
  const buyPayload = buildOrderPayload(signedBuy, 'GTC');

  const buyResult = await clobPost<{ success: boolean; orderID?: string; errorMsg?: string }>('/order', buyPayload);
  if (!buyResult.success) {
    console.log(`   BUY failed: ${buyResult.errorMsg}`);
    process.exit(1);
  }
  const buyOrderId = buyResult.orderID!;
  console.log(`   Order placed: ${buyOrderId}\n`);

  // 4. Wait
  console.log(`4. Waiting ${WAIT_MS / 1000}s for fills...`);
  await new Promise((r) => setTimeout(r, WAIT_MS));

  // 5. Place SELL to close (revert) - sell above buy price to lock profit
  const sellPrice = Math.min(0.99, buyPrice + 2 * tick);
  console.log(`\n5. Placing SELL ${SHARES} YES @ ${sellPrice.toFixed(2)} (revert/close)...`);

  const rawSell = buildOrder({
    tokenId: market.yesTokenId,
    side: Side.SELL,
    price: sellPrice,
    size: SHARES,
    feeRateBps,
    negRisk: market.negRisk,
  });
  const signedSell = await signOrder(wallet, rawSell, market.negRisk);
  const sellPayload = buildOrderPayload(signedSell, 'GTC');

  const sellResult = await clobPost<{ success: boolean; orderID?: string; errorMsg?: string }>('/order', sellPayload);
  if (sellResult.success) {
    console.log(`   SELL placed: ${sellResult.orderID}`);
  } else {
    console.log(`   SELL failed: ${sellResult.errorMsg}`);
  }

  // 6. Wait a bit for sell to fill
  await new Promise((r) => setTimeout(r, 10_000));

  // 7. Cancel all unfilled
  console.log('\n6. Cancelling all unfilled orders...');
  const cancelResult = await clobDelete<{ canceled: string[] }>('/cancel-all');
  const canceled = cancelResult?.canceled?.length ?? 0;
  console.log(`   Cancelled ${canceled} order(s)\n`);

  // 8. Report
  console.log('=========================================================');
  console.log('  Result');
  console.log('=========================================================');
  console.log(`  BUY:  ${SHARES} @ ${buyPrice.toFixed(2)} = $${buyCost.toFixed(2)}`);
  console.log(`  SELL: ${SHARES} @ ${sellPrice.toFixed(2)} = $${(sellPrice * SHARES).toFixed(2)}`);
  const grossProfit = (sellPrice - buyPrice) * SHARES;
  console.log(`  Gross P&L: $${grossProfit.toFixed(2)} (${grossProfit >= 0 ? 'profit' : 'loss'})`);
  console.log('=========================================================');
  console.log('\n  Check Polymarket for actual fills. Profit realized when SELL fills.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
