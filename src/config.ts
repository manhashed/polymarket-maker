import 'dotenv/config';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function envFloat(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseFloat(val) : fallback;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

export const CONFIG = {
  // Wallet
  PRIVATE_KEY: requireEnv('PRIVATE_KEY'),
  WALLET_ADDRESS: requireEnv('WALLET_ADDRESS'),
  PROXY_ADDRESS: requireEnv('PROXY_ADDRESS'),
  SIGNATURE_TYPE: 2, // GNOSIS_SAFE (required for proxy wallet)

  // API credentials
  API_KEY: requireEnv('POLY_API_KEY'),
  API_SECRET: requireEnv('POLY_API_SECRET'),
  API_PASSPHRASE: requireEnv('POLY_API_PASSPHRASE'),

  // Strategy selection
  MARKET_STRATEGY: process.env.MARKET_STRATEGY || 'btc-5min',
  EVENT_SLUG: process.env.EVENT_SLUG || '',

  // Exchange contracts
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  CHAIN_ID: 137,

  // Network endpoints
  CLOB_URL: 'https://clob.polymarket.com',
  WS_MARKET_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  WS_USER_URL: 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
  BINANCE_WS_URL: 'wss://stream.binance.com:9443/ws/btcusdt@trade',

  // Trading parameters
  ORDER_SIZE: envFloat('ORDER_SIZE', 50),
  MIN_SPREAD_BPS: envInt('MIN_SPREAD_BPS', 200),
  MAX_SPREAD_BPS: envInt('MAX_SPREAD_BPS', 1000),
  INVENTORY_SKEW_FACTOR: envFloat('INVENTORY_SKEW_FACTOR', 0.001),
  REQUOTE_THRESHOLD_BPS: envInt('REQUOTE_THRESHOLD_BPS', 50),

  // Risk limits
  MAX_POSITION: envFloat('MAX_POSITION', 1000),
  MAX_NOTIONAL: envFloat('MAX_NOTIONAL', 5000),
  MAX_LOSS: envFloat('MAX_LOSS', 500),

  // Volatility
  VOL_WINDOW_MS: envInt('VOL_WINDOW_MS', 300000),
  VOL_EWMA_ALPHA: envFloat('VOL_EWMA_ALPHA', 0.06),

  // Performance
  HEARTBEAT_INTERVAL_MS: 5000,
  CANCEL_REPLACE_TIMEOUT_MS: envInt('CANCEL_REPLACE_TIMEOUT_MS', 100),

  exchangeAddress(negRisk: boolean): string {
    return negRisk ? this.NEG_RISK_CTF_EXCHANGE : this.CTF_EXCHANGE;
  },

  // Polygon
  POLYGON_RPC_URL: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
  USDC_E_ADDRESS: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  CTF_TOKEN_ADDRESS: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',

  AMOUNT_DECIMALS: 6,
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
};
