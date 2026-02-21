/**
 * Test script: signs and submits a single small BUY order to verify
 * the full pipeline (signing, HMAC auth, order submission).
 *
 * Usage: npx tsx src/scripts/test-order.ts
 */

import 'dotenv/config';
import { Wallet, randomBytes } from 'ethers';
import { createHmac } from 'node:crypto';
import { CONFIG } from '../config.js';

const CLOB_URL = 'https://clob.polymarket.com';
const AMOUNT_DECIMALS = 6;
const UNIT = 10 ** AMOUNT_DECIMALS;

const YES_TOKEN_ID = process.env.YES_TOKEN_ID!;
const CONDITION_ID = process.env.CONDITION_ID!;
const NEG_RISK = process.env.NEG_RISK === 'true';

const EXCHANGE = CONFIG.exchangeAddress(NEG_RISK);

const ORDER_EIP712_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
};

function buildL2Headers(method: string, path: string, body: string = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method + path + body;
  const secret = Buffer.from(CONFIG.API_SECRET, 'base64');
  const sig = createHmac('sha256', secret).update(message).digest('base64');
  return {
    'POLY_ADDRESS': CONFIG.WALLET_ADDRESS,
    'POLY_SIGNATURE': sig,
    'POLY_TIMESTAMP': timestamp,
    'POLY_API_KEY': CONFIG.API_KEY,
    'POLY_PASSPHRASE': CONFIG.API_PASSPHRASE,
  };
}

async function main() {
  const wallet = new Wallet(CONFIG.PRIVATE_KEY);
  console.log('Wallet:', wallet.address);
  console.log('Proxy:', CONFIG.PROXY_ADDRESS);
  console.log('Token ID:', YES_TOKEN_ID);
  console.log('Condition ID:', CONDITION_ID);
  console.log('Exchange:', EXCHANGE);

  // Step 1: Get fee rate
  console.log('\n--- Step 1: Fee rate ---');
  const feeResp = await fetch(`${CLOB_URL}/fee-rate?token_id=${YES_TOKEN_ID}`);
  const feeData = await feeResp.json() as { fee_rate_bps?: string; base_fee?: number };
  console.log('Fee data:', feeData);
  const feeRateBps = feeData.fee_rate_bps ?? '0';

  // Step 2: Build a small test order
  // BUY 5 YES tokens at $0.01 each (smallest possible, costs $0.05)
  const price = 0.01;
  const size = 5;
  const side = 0; // BUY

  const makerAmount = Math.floor(price * size * UNIT).toString(); // USDC amount
  const takerAmount = Math.floor(size * UNIT).toString(); // token amount

  const saltBytes = randomBytes(32);
  const salt = BigInt('0x' + Buffer.from(saltBytes).toString('hex')).toString();

  const order = {
    salt,
    maker: CONFIG.PROXY_ADDRESS,
    signer: CONFIG.WALLET_ADDRESS,
    taker: CONFIG.ZERO_ADDRESS,
    tokenId: YES_TOKEN_ID,
    makerAmount,
    takerAmount,
    expiration: '0',
    nonce: '0',
    feeRateBps,
    side,
    signatureType: CONFIG.SIGNATURE_TYPE,
  };

  console.log('\n--- Step 2: Order ---');
  console.log('Price:', price, '| Size:', size, '| Side: BUY');
  console.log('Maker amount (USDC):', makerAmount, `(${parseInt(makerAmount) / UNIT} USDC)`);
  console.log('Taker amount (tokens):', takerAmount, `(${parseInt(takerAmount) / UNIT} tokens)`);

  // Step 3: Sign the order
  console.log('\n--- Step 3: Signing ---');
  const domain = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: CONFIG.CHAIN_ID,
    verifyingContract: EXCHANGE,
  };
  const signature = await wallet.signTypedData(domain, ORDER_EIP712_TYPES, order);
  console.log('Signature:', signature.substring(0, 20) + '...');

  // Step 4: Submit the order
  console.log('\n--- Step 4: Submitting ---');
  const payload = {
    order: {
      ...order,
      side: 'BUY',
      signature,
    },
    owner: CONFIG.API_KEY,
    orderType: 'GTC',
  };

  const body = JSON.stringify(payload);
  console.log('Payload size:', body.length, 'bytes');

  const path = '/order';
  const headers = {
    ...buildL2Headers('POST', path, body),
    'Content-Type': 'application/json',
  };

  const resp = await fetch(`${CLOB_URL}${path}`, {
    method: 'POST',
    headers,
    body,
  });

  console.log('Response status:', resp.status);
  const result = await resp.text();
  console.log('Response:', result);

  if (resp.ok) {
    const parsed = JSON.parse(result);
    console.log('\n=== ORDER SUBMITTED SUCCESSFULLY ===');
    console.log('Order ID:', parsed.orderID);
    console.log('Status:', parsed.status);

    // Cancel it right away
    console.log('\n--- Cancelling test order ---');
    const cancelBody = JSON.stringify([parsed.orderID]);
    const cancelPath = '/cancel';
    const cancelResp = await fetch(`${CLOB_URL}${cancelPath}`, {
      method: 'DELETE',
      headers: {
        ...buildL2Headers('DELETE', cancelPath, cancelBody),
        'Content-Type': 'application/json',
      },
      body: cancelBody,
    });
    console.log('Cancel status:', cancelResp.status);
    console.log('Cancel response:', await cancelResp.text());
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
