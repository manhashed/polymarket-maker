#!/usr/bin/env npx tsx
/**
 * Test BTC 5m market discovery (auto timestamp-based).
 * Run: npm run test-discovery
 */
import 'dotenv/config';
import { Btc5MinStrategy } from '../strategies/btc-5min.js';

async function main() {
  const strategy = new Btc5MinStrategy(process.env.EVENT_SLUG || '');
  console.log('Discovering active BTC 5m market (EVENT_SLUG empty = auto)...\n');

  const market = await strategy.discoverActiveMarket();
  if (!market) {
    console.log('No active market found.');
    return;
  }

  console.log('Found market:');
  console.log('  Condition ID:', market.conditionId);
  console.log('  Description:', market.description);
  console.log('  Expires at:', new Date(market.expiresAt).toISOString());
  console.log('  Yes token:', market.yesTokenId);
  console.log('  No token:', market.noTokenId);
  console.log('  Tick size:', market.tickSize);
}

main().catch(console.error);
