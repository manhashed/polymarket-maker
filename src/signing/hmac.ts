import { createHmac } from 'node:crypto';
import { CONFIG } from '../config.js';

function fromUrlSafeBase64(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function toUrlSafeBase64(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function buildHmacSignature(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string = '',
): string {
  const message = timestamp + method + requestPath + body;
  const secretBuffer = fromUrlSafeBase64(CONFIG.API_SECRET);
  return toUrlSafeBase64(
    createHmac('sha256', secretBuffer).update(message).digest(),
  );
}

export function buildL2Headers(
  method: string,
  requestPath: string,
  body: string = '',
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = buildHmacSignature(timestamp, method, requestPath, body);
  return {
    'POLY_ADDRESS': CONFIG.WALLET_ADDRESS,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_API_KEY': CONFIG.API_KEY,
    'POLY_PASSPHRASE': CONFIG.API_PASSPHRASE,
  };
}
