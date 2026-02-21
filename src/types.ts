export const enum Side {
  BUY = 0,
  SELL = 1,
}

export const enum SignatureType {
  EOA = 0,
  POLY_PROXY = 1,
  POLY_GNOSIS_SAFE = 2,
}

export const enum OrderType {
  GTC = 'GTC',
  GTD = 'GTD',
  FOK = 'FOK',
  FAK = 'FAK',
}

export interface RawOrder {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: number;
  signatureType: number;
}

export interface SignedOrder extends RawOrder {
  signature: string;
}

export interface ApiOrder {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: string;
  signatureType: number;
  signature: string;
}

export interface OrderPayload {
  order: ApiOrder;
  owner: string;
  orderType: string;
}

export interface PriceLevel {
  price: number;
  size: number;
}

export interface L2Book {
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: number;
}

export interface Quote {
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  fairValue: number;
  spread: number;
  timestamp: number;
}

export interface MarketState {
  btcPrice: number;
  btcTimestamp: number;
  volatility: number;
  book: L2Book;
  bookTimestamp: number;
}

export interface Position {
  yesShares: number;
  noShares: number;
  netDelta: number;
  avgEntryPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface RiskLimits {
  maxPosition: number;
  maxNotional: number;
  maxLoss: number;
}

export interface ActiveOrders {
  bidOrderId: string | null;
  askOrderId: string | null;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
}

export interface LatencyMetrics {
  cancelLatencyMs: number;
  submitLatencyMs: number;
  cycleLatencyMs: number;
  signLatencyMs: number;
  binanceLatencyMs: number;
  polymarketWsLatencyMs: number;
  ewmaCycleMs: number;
}

export interface ApiCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface BinanceTrade {
  e: string;
  E: number;
  s: string;
  t: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export interface PolymarketBookMsg {
  event_type: 'book';
  asset_id: string;
  market: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
}

export interface PolymarketPriceChangeMsg {
  event_type: 'price_change';
  market: string;
  price_changes: Array<{
    asset_id: string;
    price: string;
    size: string;
    side: string;
  }>;
  timestamp: string;
}

export interface PolymarketTradeMsg {
  event_type: 'trade';
  type: string;
  asset_id: string;
  market: string;
  price: string;
  size: string;
  side: string;
  status: string;
  maker_orders: Array<{
    order_id: string;
    matched_amount: string;
    price: string;
  }>;
}

export interface PolymarketOrderMsg {
  event_type: 'order';
  type: string;
  id: string;
  asset_id: string;
  market: string;
  price: string;
  original_size: string;
  size_matched: string;
  side: string;
}

export type PolymarketMarketMsg =
  | PolymarketBookMsg
  | PolymarketPriceChangeMsg
  | { event_type: 'last_trade_price'; asset_id: string; price: string; side: string; size: string };

export type PolymarketUserMsg = PolymarketTradeMsg | PolymarketOrderMsg;

export interface HeartbeatResponse {
  heartbeat_id: string;
}

export interface OrderResponse {
  success: boolean;
  errorMsg: string;
  orderID: string;
  status: string;
}

export interface CancelResponse {
  canceled: string[];
  not_canceled: Record<string, string>;
}
