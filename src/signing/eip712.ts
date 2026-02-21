import { Wallet } from 'ethers';
import { CONFIG } from '../config.js';
import { type RawOrder, type SignedOrder, Side } from '../types.js';

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

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

const domainCache = new Map<string, {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}>();

function getExchangeDomain(negRisk: boolean) {
  const contract = CONFIG.exchangeAddress(negRisk);
  let domain = domainCache.get(contract);
  if (!domain) {
    domain = {
      name: 'Polymarket CTF Exchange',
      version: '1',
      chainId: CONFIG.CHAIN_ID,
      verifyingContract: contract,
    };
    domainCache.set(contract, domain);
  }
  return domain;
}

export function generateSalt(): string {
  return Math.round(Math.random() * Date.now()).toString();
}

const UNIT = 10 ** CONFIG.AMOUNT_DECIMALS;

export function buildOrderAmounts(
  side: Side,
  price: number,
  size: number,
): { makerAmount: string; takerAmount: string } {
  if (side === Side.BUY) {
    const makerAmt = Math.floor(price * size * UNIT);
    const takerAmt = Math.floor(size * UNIT);
    return { makerAmount: makerAmt.toString(), takerAmount: takerAmt.toString() };
  }
  const makerAmt = Math.floor(size * UNIT);
  const takerAmt = Math.floor(price * size * UNIT);
  return { makerAmount: makerAmt.toString(), takerAmount: takerAmt.toString() };
}

export interface BuildOrderParams {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  feeRateBps: string;
  negRisk: boolean;
  expiration?: number;
}

export function buildOrder(params: BuildOrderParams): RawOrder {
  const { tokenId, side, price, size, feeRateBps, expiration = 0 } = params;
  const { makerAmount, takerAmount } = buildOrderAmounts(side, price, size);
  return {
    salt: generateSalt(),
    maker: CONFIG.SIGNATURE_TYPE === 0 ? CONFIG.WALLET_ADDRESS : CONFIG.PROXY_ADDRESS,
    signer: CONFIG.WALLET_ADDRESS,
    taker: CONFIG.ZERO_ADDRESS,
    tokenId,
    makerAmount,
    takerAmount,
    expiration: expiration.toString(),
    nonce: '0',
    feeRateBps,
    side,
    signatureType: CONFIG.SIGNATURE_TYPE,
  };
}

export async function signOrder(
  wallet: Wallet,
  order: RawOrder,
  negRisk: boolean,
): Promise<SignedOrder> {
  const domain = getExchangeDomain(negRisk);
  const signature = await wallet.signTypedData(domain, ORDER_EIP712_TYPES, order);
  return { ...order, signature };
}

export async function signClobAuth(
  wallet: Wallet,
  timestamp: string,
  nonce: number = 0,
): Promise<string> {
  const domain = {
    name: 'ClobAuthDomain',
    version: '1',
    chainId: CONFIG.CHAIN_ID,
  };
  const value = {
    address: CONFIG.WALLET_ADDRESS,
    timestamp,
    nonce,
    message: 'This message attests that I control the given wallet',
  };
  return wallet.signTypedData(domain, CLOB_AUTH_TYPES, value);
}
