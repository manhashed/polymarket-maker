export interface MarketInfo {
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  negRisk: boolean;
  tickSize: number;
  expiresAt: number;
  startedAt: number;
  description: string;
}

export interface ActiveMarketContext extends MarketInfo {
  strikePrice: number;
}

export interface MarketStrategy {
  readonly name: string;
  readonly quotingCutoffMs: number;
  readonly discoveryIntervalMs: number;

  discoverActiveMarket(): Promise<MarketInfo | null>;

  computeFairValue(
    btcPrice: number,
    strikePrice: number,
    volatility: number,
    timeToExpiryMs: number,
  ): number;
}
