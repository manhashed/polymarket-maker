/**
 * One-time script to generate Polymarket CLOB API credentials.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx src/scripts/generate-api-key.ts
 *
 * This signs a ClobAuth EIP-712 message with your private key and
 * posts it to the CLOB to create API credentials.
 * Store the output in your .env file.
 */

import { Wallet } from 'ethers';
import 'dotenv/config';

const CLOB_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error('Set PRIVATE_KEY env var');
    process.exit(1);
  }

  const wallet = new Wallet(pk);
  console.log(`Wallet address: ${wallet.address}`);

  // Get server time
  const timeResp = await fetch(`${CLOB_URL}/time`);
  const serverTime = await timeResp.text();
  const timestamp = serverTime.trim().replace(/"/g, '');
  console.log(`Server time: ${timestamp}`);

  const nonce = 0;
  const domain = { name: 'ClobAuthDomain', version: '1', chainId: CHAIN_ID };
  const value = {
    address: wallet.address,
    timestamp,
    nonce,
    message: 'This message attests that I control the given wallet',
  };

  const signature = await wallet.signTypedData(domain, CLOB_AUTH_TYPES, value);

  // Try derive first
  const deriveResp = await fetch(`${CLOB_URL}/auth/derive-api-key`, {
    method: 'GET',
    headers: {
      'POLY_ADDRESS': wallet.address,
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': timestamp,
      'POLY_NONCE': nonce.toString(),
    },
  });

  if (deriveResp.ok) {
    const creds = await deriveResp.json();
    printCreds(creds);
    return;
  }

  // Derive failed, create new
  console.log('No existing credentials, creating new...');
  const createResp = await fetch(`${CLOB_URL}/auth/api-key`, {
    method: 'POST',
    headers: {
      'POLY_ADDRESS': wallet.address,
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': timestamp,
      'POLY_NONCE': nonce.toString(),
    },
  });

  if (!createResp.ok) {
    const errText = await createResp.text();
    console.error(`Failed to create API key: ${createResp.status} ${errText}`);
    process.exit(1);
  }

  const creds = await createResp.json();
  printCreds(creds);
}

function printCreds(creds: any) {
  console.log('\n=== Add these to your .env file ===\n');
  console.log(`POLY_API_KEY=${creds.apiKey}`);
  console.log(`POLY_API_SECRET=${creds.secret}`);
  console.log(`POLY_API_PASSPHRASE=${creds.passphrase}`);
  console.log('\n===================================\n');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
