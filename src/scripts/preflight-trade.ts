/**
 * Preflight validation and test trade script.
 *
 * Validates the full trading pipeline:
 *   1. Wallet configuration
 *   2. On-chain balances (POL for gas, USDC.e for trading)
 *   3. CLOB balance and exchange allowance
 *   4. Fund transfer to proxy wallet if needed
 *   5. Active market discovery via Gamma API
 *   6. Test limit order placement + cancellation
 *
 * Usage:
 *   npx tsx src/scripts/preflight-trade.ts
 */

import { Wallet, JsonRpcProvider, Contract, formatUnits, parseUnits } from 'ethers';
import { CONFIG } from '../config.js';
import { buildHmacSignature } from '../signing/hmac.js';
import { buildOrder, signOrder } from '../signing/eip712.js';
import { Side, type SignedOrder } from '../types.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const CTF_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
];

const MIN_USDC_FOR_TRADE = 5;
const MIN_POL_FOR_GAS = 0.05;
const TEST_TRADE_SHARES = 10;

const SIDE_STR: Record<number, string> = { 0: 'BUY', 1: 'SELL' };

// ─── CLOB HTTP Helpers ───────────────────────────────────────────────────────

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

async function clobGet<T>(basePath: string, params?: Record<string, string>): Promise<T> {
  const headers = buildAuthHeaders('GET', basePath);
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const resp = await fetch(`${CONFIG.CLOB_URL}${basePath}${qs}`, { method: 'GET', headers });
  if (!resp.ok) {
    throw new Error(`GET ${basePath}: ${resp.status} ${await resp.text()}`);
  }
  return resp.json() as Promise<T>;
}

async function clobPost<T>(path: string, body: object): Promise<T> {
  const bodyStr = JSON.stringify(body);
  const headers = buildAuthHeaders('POST', path, bodyStr);
  const resp = await fetch(`${CONFIG.CLOB_URL}${path}`, { method: 'POST', headers, body: bodyStr });
  if (!resp.ok) {
    throw new Error(`POST ${path}: ${resp.status} ${await resp.text()}`);
  }
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
  if (!resp.ok) {
    throw new Error(`DELETE ${path}: ${resp.status} ${await resp.text()}`);
  }
  const text = await resp.text();
  return text ? (JSON.parse(text) as T) : null;
}

// ─── Gamma API Types ─────────────────────────────────────────────────────────

interface GammaMarket {
  conditionId: string;
  question: string;
  clobTokenIds: string;
  outcomePrices: string;
  outcomes: string;
  volume24hr: number;
  active: boolean;
  closed: boolean;
  neg_risk: boolean;
  minimum_tick_size: number;
}

interface DiscoveredMarket {
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  question: string;
  yesPrice: number;
  negRisk: boolean;
  tickSize: number;
}

// ─── Pipeline Steps ──────────────────────────────────────────────────────────

async function checkOnChainBalances(provider: JsonRpcProvider) {
  console.log('\n--- Step 1: On-chain balances ---');

  const usdc = new Contract(CONFIG.USDC_E_ADDRESS, ERC20_ABI, provider);

  const [walletPolRaw, walletUsdcRaw, proxyUsdcRaw] = await Promise.all([
    provider.getBalance(CONFIG.WALLET_ADDRESS),
    usdc.balanceOf(CONFIG.WALLET_ADDRESS),
    usdc.balanceOf(CONFIG.PROXY_ADDRESS),
  ]);

  const walletPol = parseFloat(formatUnits(walletPolRaw, 18));
  const walletUsdc = parseFloat(formatUnits(walletUsdcRaw, 6));
  const proxyUsdc = parseFloat(formatUnits(proxyUsdcRaw, 6));

  console.log(`  Wallet ${CONFIG.WALLET_ADDRESS}:`);
  console.log(`    POL:    ${walletPol.toFixed(4)}`);
  console.log(`    USDC.e: $${walletUsdc.toFixed(2)}`);
  console.log(`  Proxy  ${CONFIG.PROXY_ADDRESS}:`);
  console.log(`    USDC.e: $${proxyUsdc.toFixed(2)}`);

  return { walletPol, walletUsdc, proxyUsdc };
}

async function checkExchangeAllowances(provider: JsonRpcProvider) {
  console.log('\n--- Step 2: Exchange allowances ---');

  const usdc = new Contract(CONFIG.USDC_E_ADDRESS, ERC20_ABI, provider);
  const ctf = new Contract(CONFIG.CTF_TOKEN_ADDRESS, CTF_ABI, provider);

  const exchangeAddr = CONFIG.exchangeAddress(false);

  const [usdcAllowance, ctfApproved] = await Promise.all([
    usdc.allowance(CONFIG.PROXY_ADDRESS, exchangeAddr),
    ctf.isApprovedForAll(CONFIG.PROXY_ADDRESS, exchangeAddr),
  ]);

  const usdcAllowanceFormatted = parseFloat(formatUnits(usdcAllowance, 6));
  console.log(`  USDC.e allowance for exchange: $${usdcAllowanceFormatted.toFixed(2)}`);
  console.log(`  CTF approved for exchange:     ${ctfApproved}`);

  if (usdcAllowanceFormatted === 0) {
    console.log('  [!] Proxy has zero USDC.e allowance for the exchange.');
    console.log('      If order placement fails, approve via Polymarket web interface.');
  }
  if (!ctfApproved) {
    console.log('  [!] Proxy has not approved CTF tokens for the exchange.');
    console.log('      SELL orders will fail until approved.');
  }

  return { usdcAllowance: usdcAllowanceFormatted, ctfApproved: ctfApproved as boolean };
}

async function checkClobBalance() {
  console.log('\n--- Step 3: CLOB balance/allowance ---');

  try {
    const result = await clobGet<{ balance: string; allowance: string }>(
      '/balance-allowance',
      {
        asset_type: 'COLLATERAL',
        signature_type: CONFIG.SIGNATURE_TYPE.toString(),
      },
    );
    const balance = parseFloat(result.balance) / 1e6;
    const allowance = parseFloat(result.allowance) / 1e6;
    console.log(`  CLOB usable balance:   $${balance.toFixed(2)}`);
    console.log(`  CLOB usable allowance: $${allowance.toFixed(2)}`);
    return { balance, allowance };
  } catch (err: any) {
    console.log(`  Could not fetch CLOB balance: ${err.message}`);
    console.log('  Continuing with on-chain data...');
    return null;
  }
}

async function transferUsdcToProxy(
  wallet: Wallet,
  provider: JsonRpcProvider,
  amount: number,
) {
  console.log(`\n--- Transferring $${amount} USDC.e to proxy ---`);

  const connectedWallet = wallet.connect(provider);
  const usdc = new Contract(CONFIG.USDC_E_ADDRESS, ERC20_ABI, connectedWallet);
  const amountRaw = parseUnits(amount.toFixed(6), 6);

  const tx = await usdc.transfer(CONFIG.PROXY_ADDRESS, amountRaw);
  console.log(`  TX: ${tx.hash}`);
  console.log(`  Waiting for confirmation...`);

  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt!.blockNumber}`);
}

async function findActiveMarket(): Promise<DiscoveredMarket> {
  console.log('\n--- Step 4: Finding an active market ---');

  const url = 'https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=50&order=volume24hr&ascending=false';
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Gamma API: ${resp.status} ${await resp.text()}`);
  }

  const markets: GammaMarket[] = await resp.json();

  for (const m of markets) {
    if (!m.active || m.closed) continue;

    // Prefer non-neg-risk markets for simplicity
    if (m.neg_risk) continue;

    let tokenIds: string[];
    let prices: string[];
    let outcomes: string[];

    try {
      tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
    } catch {
      continue;
    }

    if (tokenIds.length < 2 || prices.length < 2) continue;

    const yesIdx = outcomes.indexOf('Yes');
    const noIdx = outcomes.indexOf('No');
    if (yesIdx === -1 || noIdx === -1) continue;

    const yesPrice = parseFloat(prices[yesIdx]);
    if (yesPrice < 0.10 || yesPrice > 0.90) continue;

    const tickSize = typeof m.minimum_tick_size === 'string'
      ? parseFloat(m.minimum_tick_size)
      : (m.minimum_tick_size ?? 0.01);

    const market: DiscoveredMarket = {
      conditionId: m.conditionId,
      yesTokenId: tokenIds[yesIdx],
      noTokenId: tokenIds[noIdx],
      question: m.question,
      yesPrice,
      negRisk: m.neg_risk ?? false,
      tickSize,
    };

    console.log(`  Market:    "${m.question}"`);
    console.log(`  Condition: ${market.conditionId}`);
    console.log(`  YES Token: ${market.yesTokenId}`);
    console.log(`  NO Token:  ${market.noTokenId}`);
    console.log(`  YES Price: ${yesPrice.toFixed(4)}`);
    console.log(`  Volume 24h: $${(m.volume24hr ?? 0).toFixed(0)}`);
    console.log(`  Tick Size: ${tickSize}`);

    return market;
  }

  throw new Error('No suitable binary market found (need non-neg-risk, YES price 0.10-0.90)');
}

async function getMidpoint(tokenId: string): Promise<number> {
  const resp = await fetch(`${CONFIG.CLOB_URL}/midpoint?token_id=${tokenId}`);
  if (!resp.ok) {
    throw new Error(`Midpoint: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { mid: string };
  return parseFloat(data.mid);
}

async function getFeeRate(tokenId: string): Promise<string> {
  const resp = await fetch(`${CONFIG.CLOB_URL}/fee-rate?token_id=${tokenId}`);
  if (!resp.ok) return '0';
  const data = (await resp.json()) as { fee_rate_bps?: string };
  return data.fee_rate_bps ?? '0';
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

async function placeTestTrade(
  wallet: Wallet,
  market: DiscoveredMarket,
  midpoint: number,
): Promise<string | null> {
  console.log('\n--- Step 6: Placing test limit order ---');

  const feeRateBps = await getFeeRate(market.yesTokenId);
  console.log(`  Fee rate: ${feeRateBps} bps`);

  // Price the order well below midpoint so it rests without matching
  const tick = market.tickSize;
  const bidOffset = Math.max(tick * 10, 0.05);
  let bidPrice = midpoint - bidOffset;
  bidPrice = Math.round(bidPrice / tick) * tick;
  bidPrice = Math.max(tick, Math.min(1 - tick, bidPrice));

  const cost = bidPrice * TEST_TRADE_SHARES;
  console.log(`  Order: BUY ${TEST_TRADE_SHARES} YES @ ${bidPrice.toFixed(4)}`);
  console.log(`  Midpoint: ${midpoint.toFixed(4)} (offset: ${bidOffset.toFixed(4)})`);
  console.log(`  Max cost if filled: $${cost.toFixed(2)}`);

  const rawOrder = buildOrder({
    tokenId: market.yesTokenId,
    side: Side.BUY,
    price: bidPrice,
    size: TEST_TRADE_SHARES,
    feeRateBps,
    negRisk: market.negRisk,
  });
  const signed = await signOrder(wallet, rawOrder, market.negRisk);
  const payload = buildOrderPayload(signed, 'GTC');

  console.log('  Submitting to CLOB...');

  const result = await clobPost<{
    success: boolean;
    errorMsg: string;
    orderID: string;
    status: string;
  }>('/order', payload);

  if (result.success) {
    console.log(`  Order placed!`);
    console.log(`    Order ID: ${result.orderID}`);
    console.log(`    Status:   ${result.status}`);
    return result.orderID;
  }

  console.log(`  Order failed: ${result.errorMsg}`);
  return null;
}

async function cancelTestOrder() {
  console.log('\n--- Step 7: Cancelling test order ---');
  try {
    const result = await clobDelete<{ canceled: string[]; not_canceled: Record<string, string> }>('/cancel-all');
    const count = result?.canceled?.length ?? 0;
    console.log(`  Cancelled ${count} order(s)`);
  } catch (err: any) {
    console.log(`  Cancel: ${err.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=========================================================');
  console.log('  Polymarket Bot - Preflight Check & Test Trade');
  console.log('=========================================================');

  // Validate wallet
  const wallet = new Wallet(CONFIG.PRIVATE_KEY);
  if (wallet.address.toLowerCase() !== CONFIG.WALLET_ADDRESS.toLowerCase()) {
    throw new Error(`Wallet mismatch: derived ${wallet.address}, expected ${CONFIG.WALLET_ADDRESS}`);
  }
  console.log(`\nWallet:  ${wallet.address}`);
  console.log(`Proxy:   ${CONFIG.PROXY_ADDRESS}`);
  console.log(`Exchange: ${CONFIG.exchangeAddress(false)} (sig_type: ${CONFIG.SIGNATURE_TYPE})`);

  // Connect to Polygon
  const provider = new JsonRpcProvider(CONFIG.POLYGON_RPC_URL);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CONFIG.CHAIN_ID) {
    throw new Error(`Chain ID mismatch: got ${network.chainId}, expected ${CONFIG.CHAIN_ID}`);
  }
  console.log(`Chain:   Polygon (${network.chainId})`);

  // Step 1: On-chain balances
  const { walletPol, walletUsdc, proxyUsdc } = await checkOnChainBalances(provider);

  // Step 2: Exchange allowances
  const { usdcAllowance } = await checkExchangeAllowances(provider);

  // Step 3: CLOB balance
  const clobResult = await checkClobBalance();

  // Fund proxy if needed
  if (proxyUsdc < MIN_USDC_FOR_TRADE) {
    console.log(`\n  Proxy USDC.e ($${proxyUsdc.toFixed(2)}) is below $${MIN_USDC_FOR_TRADE} minimum.`);

    if (walletUsdc < MIN_USDC_FOR_TRADE) {
      console.log(`  Wallet USDC.e ($${walletUsdc.toFixed(2)}) is also insufficient.`);
      console.log(`  Deposit USDC.e to wallet: ${CONFIG.WALLET_ADDRESS}`);
      console.log(`  Or bridge via: https://polymarket.com`);
      process.exit(1);
    }

    if (walletPol < MIN_POL_FOR_GAS) {
      console.log(`  Wallet POL (${walletPol.toFixed(4)}) too low for gas.`);
      console.log(`  Send POL to: ${CONFIG.WALLET_ADDRESS}`);
      process.exit(1);
    }

    const transferAmount = Math.min(walletUsdc, 20);
    await transferUsdcToProxy(wallet, provider, transferAmount);
  }

  // Step 4: Find market
  const market = await findActiveMarket();

  // Step 5: Get midpoint
  console.log('\n--- Step 5: Midpoint price ---');
  const midpoint = await getMidpoint(market.yesTokenId);
  console.log(`  Midpoint: ${midpoint.toFixed(4)}`);

  if (midpoint <= 0 || midpoint >= 1) {
    throw new Error(`Invalid midpoint: ${midpoint}`);
  }

  // Step 6: Place test trade
  const orderId = await placeTestTrade(wallet, market, midpoint);

  // Step 7: Cancel
  if (orderId) {
    await cancelTestOrder();
  }

  // Summary
  console.log('\n=========================================================');
  console.log('  Preflight Results');
  console.log('=========================================================');
  console.log(`  Wallet balance:     $${walletUsdc.toFixed(2)} USDC.e, ${walletPol.toFixed(4)} POL`);
  console.log(`  Proxy balance:      $${proxyUsdc.toFixed(2)} USDC.e`);
  console.log(`  Exchange allowance: $${usdcAllowance.toFixed(2)}`);
  console.log(`  Market:             "${market.question}"`);
  console.log(`  Trade result:       ${orderId ? 'SUCCESS (placed + cancelled)' : 'FAILED'}`);

  if (orderId) {
    console.log('\n  The trading pipeline is fully operational.');
    console.log('  You can now run the market-making bot with: npm run dev');
  } else {
    console.log('\n  Trade placement failed. Check error messages above.');
  }
  console.log('=========================================================');
}

main().catch((err) => {
  console.error('\nPreflight failed:', err.message || err);
  process.exit(1);
});
