import { childLogger } from '../utils/logger.js';
import type { MarketInfo, MarketStrategy } from './types.js';

const log = childLogger('Btc5MinStrategy');

const GAMMA_API = 'https://gamma-api.polymarket.com';

/** BTC Up/Down 5m series slug — used to discover the next active 5‑min window */
const BTC_5M_SERIES_SLUG = 'btc-up-or-down-5m';

/** 5 minutes in seconds — Polymarket BTC 5m slugs use Unix timestamp of window start */
const FIVE_MIN_SEC = 300;

/**
 * Compute the Unix timestamp of the current 5-minute window start.
 * Polymarket slugs: btc-updown-5m-{timestamp} where timestamp = window start (UTC).
 */
function getCurrent5mWindowTimestamp(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / FIVE_MIN_SEC) * FIVE_MIN_SEC;
}

interface GammaMarket {
  conditionId: string;
  question: string;
  clobTokenIds: string;
  outcomes: string;
  negRisk: boolean;
  orderPriceMinTickSize: number;
  endDate: string;
  startDate?: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
}

interface GammaEvent {
  slug: string;
  markets: GammaMarket[];
  seriesSlug?: string;
}

/**
 * Standard normal CDF — Abramowitz & Stegun approximation.
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return 0.5 * (1.0 + sign * y);
}

export class Btc5MinStrategy implements MarketStrategy {
  readonly name = 'btc-5min';
  readonly quotingCutoffMs = 30_000;
  readonly discoveryIntervalMs = 15_000;

  /** Event slug (exact) or series slug (e.g. btc-up-or-down-5m) for discovery */
  private readonly eventOrSeriesSlug: string;

  constructor(eventOrSeriesSlug: string) {
    this.eventOrSeriesSlug = eventOrSeriesSlug || BTC_5M_SERIES_SLUG;
  }

  async discoverActiveMarket(): Promise<MarketInfo | null> {
    try {
      const events = await this.fetchEvents();
      const market = this.pickNextActiveMarket(events);
      if (!market) {
        log.info('No active BTC 5m market with future expiry found');
        return null;
      }

      log.info(
        {
          conditionId: market.conditionId,
          expiresAt: new Date(market.expiresAt).toISOString(),
          question: market.description,
        },
        'Discovered active market',
      );

      return market;
    } catch (err) {
      log.error({ err }, 'Market discovery failed');
      return null;
    }
  }

  private pickNextActiveMarket(events: GammaEvent[]): MarketInfo | null {
    const now = Date.now();
    const candidates: { market: MarketInfo; expiresAt: number }[] = [];

    for (const event of events) {
      for (const m of event.markets || []) {
        if (!m.active || m.closed || !m.acceptingOrders) continue;
        const outcomes = this.parseJson<string[]>(m.outcomes);
        const tokenIds = this.parseJson<string[]>(m.clobTokenIds);
        if (!outcomes || !tokenIds || outcomes.length < 2 || tokenIds.length < 2) continue;

        const upIdx = outcomes.findIndex((o) => o === 'Up' || o === 'Yes');
        const downIdx = outcomes.findIndex((o) => o === 'Down' || o === 'No');
        if (upIdx === -1 || downIdx === -1) continue;

        const expiresAt = new Date(m.endDate).getTime();
        if (expiresAt <= now) continue;

        const startedAt = m.startDate
          ? new Date(m.startDate).getTime()
          : expiresAt - 5 * 60 * 1000;

        candidates.push({
          market: {
            conditionId: m.conditionId,
            yesTokenId: tokenIds[upIdx],
            noTokenId: tokenIds[downIdx],
            negRisk: m.negRisk ?? false,
            tickSize: m.orderPriceMinTickSize ?? 0.01,
            expiresAt,
            startedAt,
            description: m.question,
          },
          expiresAt,
        });
      }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => a.expiresAt - b.expiresAt);
    return candidates[0].market;
  }

  private parseJson<T>(s: string | undefined): T | null {
    if (!s) return null;
    try {
      return typeof s === 'string' ? (JSON.parse(s) as T) : (s as T);
    } catch {
      return null;
    }
  }

  private async fetchEvents(): Promise<GammaEvent[]> {
    const slug = this.eventOrSeriesSlug;
    const isSeries = !slug || slug === BTC_5M_SERIES_SLUG || slug === 'btc-updown-5m';

    if (isSeries) {
      return this.fetchEventsByTimestampGuessing();
    }

    const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}&limit=5`;
    log.debug({ url }, 'Fetching event by slug');

    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      log.error({ status: resp.status, text }, 'Gamma API request failed');
      return [];
    }

    const data = await resp.json();
    const raw = Array.isArray(data) ? data : [data];
    return raw.filter((e: GammaEvent) => e && (e.markets?.length ?? 0) > 0);
  }

  /**
   * Auto-discover BTC 5m market by computing the current 5-minute window timestamp.
   * Slug pattern: btc-updown-5m-{unixTimestamp} where timestamp = window start (UTC).
   * Tries current + adjacent windows to handle clock skew and market creation delay.
   */
  private async fetchEventsByTimestampGuessing(): Promise<GammaEvent[]> {
    const baseTs = getCurrent5mWindowTimestamp();
    const slugs = [
      `btc-updown-5m-${baseTs}`,
      `btc-updown-5m-${baseTs + FIVE_MIN_SEC}`,
      `btc-updown-5m-${baseTs - FIVE_MIN_SEC}`,
    ];

    for (const s of slugs) {
      const events = await this.fetchEventBySlug(s);
      if (events.length > 0) {
        const hasActive = events.some(
          (e) =>
            e.markets?.some(
              (m) => m.active && !m.closed && m.acceptingOrders,
            ),
        );
        if (hasActive) {
          log.debug({ slug: s, windowStart: new Date(baseTs * 1000).toISOString() }, 'Found active market');
          return events;
        }
      }
    }

    log.debug({ slugs, baseTs }, 'No active BTC 5m market found for current window');
    return [];
  }

  private async fetchEventBySlug(slug: string): Promise<GammaEvent[]> {
    const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}&limit=1`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      const raw = Array.isArray(data) ? data : [data];
      return raw.filter((e: GammaEvent) => e && (e.markets?.length ?? 0) > 0);
    } catch {
      return [];
    }
  }

  /**
   * Log-normal fair value for "Will BTC be above strike at expiry?"
   *
   *   d = ln(S / K) / (σ × √T)
   *   P(up) ≈ Φ(d)
   */
  computeFairValue(
    btcPrice: number,
    strikePrice: number,
    volatility: number,
    timeToExpiryMs: number,
  ): number {
    if (btcPrice <= 0 || strikePrice <= 0 || volatility <= 0) return 0.5;

    const T = Math.max(timeToExpiryMs / 1000 / (365.25 * 24 * 3600), 1e-10);
    const sqrtT = Math.sqrt(T);
    const d = Math.log(btcPrice / strikePrice) / (volatility * sqrtT);
    return Math.max(0.01, Math.min(0.99, normalCDF(d)));
  }

}
