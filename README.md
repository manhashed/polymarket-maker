# Polymarket Maker Bot

A modular, event-driven market-making bot for [Polymarket](https://polymarket.com) prediction markets. It provides liquidity on BTC Up/Down 5-minute markets by continuously quoting bid and ask prices based on a log-normal fair-value model, with risk controls and automatic market rotation.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Getting Started](#getting-started)
- [Data Flow](#data-flow)
- [Components in Detail](#components-in-detail)
- [Scripts](#scripts)
- [Deployment](#deployment)

---

## Overview

### What It Does

1. **Market discovery** — Automatically finds the current active BTC 5-minute market (or a specific event via config).
2. **Fair value pricing** — Uses a log-normal model with live BTC price and volatility to compute fair value.
3. **Market making** — Posts bid and ask orders around fair value, earning the spread when both sides fill.
4. **Risk management** — Tracks position, PnL, and enforces limits (max position, max loss, max notional).
5. **Market rotation** — When the current 5-minute window expires, discovers and switches to the next market.

### Key Features

- **Proxy wallet support** — Uses Polymarket’s proxy (Gnosis Safe) with `SIGNATURE_TYPE: 2`.
- **Modular strategies** — Pluggable `MarketStrategy` interface; currently implements `btc-5min`.
- **Event-driven design** — Agents communicate via Node.js `EventEmitter` for loose coupling.
- **Real-time data** — Binance WebSocket for BTC price; Polymarket WebSockets for order book and fills.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Orchestrator (index.ts)                            │
│                    Wires agents, handles startup/shutdown                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
        ▼                               ▼                               ▼
┌───────────────┐             ┌─────────────────┐             ┌─────────────────┐
│ MarketManager │             │ MarketDataAgent  │             │ OrderbookAgent   │
│ (strategy)    │             │ (Binance WS)     │             │ (Polymarket WS) │
└───────┬───────┘             └────────┬─────────┘             └────────┬─────────┘
        │                              │                                │
        │ market_switch                │ price (btc, vol)               │ fill, book_update
        ▼                              ▼                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                         QuotingAgent + RiskAgent                                │
│  fairValue → quote → risk check → adjusted quote                                │
└───────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────┐         ┌─────────────────┐
│ ExecutionAgent  │         │ LatencyMonitor  │
│ (sign, submit)  │         │ (metrics)        │
└─────────────────┘         └─────────────────┘
```

---

## Project Structure

```
polymarket-bot/
├── src/
│   ├── index.ts              # Entry point, orchestrator
│   ├── config.ts             # Central config from env
│   ├── types.ts              # Shared types (Quote, Order, Position, etc.)
│   │
│   ├── market-manager.ts     # Market discovery & rotation
│   │
│   ├── strategies/
│   │   ├── types.ts          # MarketStrategy, MarketInfo interfaces
│   │   └── btc-5min.ts       # BTC Up/Down 5m strategy
│   │
│   ├── agents/
│   │   ├── market-data.ts    # Binance WebSocket → BTC price & volatility
│   │   ├── orderbook.ts     # Polymarket WS → order book & fills
│   │   ├── quoting.ts       # Fair value → bid/ask quotes
│   │   ├── risk.ts          # Position tracking, limits, halt logic
│   │   ├── execution.ts     # Order signing & CLOB HTTP
│   │   └── latency.ts       # Cycle & latency metrics
│   │
│   ├── signing/
│   │   ├── eip712.ts        # EIP-712 order signing
│   │   └── hmac.ts          # L2 API HMAC auth
│   │
│   ├── utils/
│   │   └── logger.ts        # Pino logger
│   │
│   └── scripts/
│       ├── generate-api-key.ts   # Create Polymarket API credentials
│       ├── preflight-trade.ts    # Balance check, test order
│       ├── test-discovery.ts     # Test market discovery
│       ├── place-and-revert.ts   # Place order, wait, cancel
│       └── test-order.ts         # Manual single-order test
│
├── deploy/
│   ├── setup.sh                  # Linux VPS setup
│   └── polymarket-maker.service   # systemd unit
│
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Configuration

All configuration is loaded from `.env`. Copy `.env.example` to `.env` and fill in values.

### Required

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Ethereum private key (0x-prefixed hex) |
| `WALLET_ADDRESS` | Address derived from `PRIVATE_KEY` |
| `PROXY_ADDRESS` | Polymarket proxy (Gnosis Safe) address |
| `POLY_API_KEY` | CLOB API key (from `npm run generate-keys`) |
| `POLY_API_SECRET` | CLOB API secret |
| `POLY_API_PASSPHRASE` | CLOB API passphrase |

### Strategy & Market

| Variable | Description |
|----------|-------------|
| `MARKET_STRATEGY` | `btc-5min` (extensible) |
| `EVENT_SLUG` | Specific event (e.g. `btc-updown-5m-1771697400`) or **empty** for auto-discovery of current 5m window |

### Trading Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `ORDER_SIZE` | 50 | Shares per bid/ask |
| `MIN_SPREAD_BPS` | 200 | Min spread in basis points |
| `MAX_SPREAD_BPS` | 1000 | Max spread (volatility scaling) |
| `INVENTORY_SKEW_FACTOR` | 0.001 | Position-based quote skew |
| `REQUOTE_THRESHOLD_BPS` | 50 | Min price change to requote |

### Risk Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_POSITION` | 1000 | Max absolute position (shares) |
| `MAX_NOTIONAL` | 5000 | Max notional exposure |
| `MAX_LOSS` | 500 | Max realized + unrealized loss before halt |

### Optional

| Variable | Description |
|----------|-------------|
| `POLYGON_RPC_URL` | Polygon RPC (for preflight balance checks) |
| `LOG_LEVEL` | `info` \| `debug` \| `warn` \| `error` |

---

## Getting Started

### Prerequisites

- Node.js 20+
- Polymarket account with proxy wallet
- USDC.e on Polygon (in proxy for trading)

### 1. Install

```bash
npm install
```

### 2. Generate API Credentials

```bash
PRIVATE_KEY=0x... npm run generate-keys
```

Copy the output (`POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE`) into `.env`.

### 3. Configure `.env`

```bash
cp .env.example .env
# Edit .env with your wallet, proxy, API keys, POLYGON_RPC_URL
```

### 4. Preflight Check

```bash
npm run preflight
```

Verifies balances, allowances, and places + cancels a test order.

### 5. Run the Bot

```bash
npm run dev    # Development (tsx)
npm start      # Production (node dist/index.js)
```

---

## Data Flow

### 1. Market Discovery

- `MarketManager` uses the strategy’s `discoverActiveMarket()`.
- **Btc5MinStrategy**: If `EVENT_SLUG` is empty, computes the current 5-minute window timestamp and fetches `btc-updown-5m-{timestamp}` from the Gamma API. Otherwise fetches the specific slug.
- Emits `market_switch` with the new `ActiveMarketContext`.

### 2. Price & Fair Value

- **MarketDataAgent** subscribes to Binance `btcusdt@trade` and emits `price` with `{ price, volatility, latencyMs }`.
- Volatility is EWMA of squared log-returns, annualized.
- **MarketManager** locks `strikePrice` from the first BTC price and computes `fairValue` via the strategy’s log-normal model.

### 3. Quoting

- **QuotingAgent** receives `fairValue` and computes `bidPrice` and `askPrice`:
  - Spread scales with volatility (MIN_SPREAD_BPS → MAX_SPREAD_BPS).
  - Inventory skew shifts quotes to reduce position.
- Emits quotes only when price moves beyond `REQUOTE_THRESHOLD_BPS`.

### 4. Risk Check

- **RiskAgent** checks each quote: `ALLOW`, `REDUCE_ONLY`, or `HALT`.
- Halt triggers on `MAX_LOSS` breach; reduce-only on `MAX_POSITION` or `MAX_NOTIONAL`.
- Tracks position from fill events and unrealized PnL from fair value.

### 5. Execution

- **ExecutionAgent** signs bid and ask orders (EIP-712), cancels existing orders, and submits new ones to the CLOB.
- Uses HMAC L2 auth; `owner` in payload is `API_KEY`; `maker` is `PROXY_ADDRESS` when `SIGNATURE_TYPE === 2`.

### 6. Fills

- **OrderbookAgent** receives trade events on the user WebSocket and emits `fill`.
- **RiskAgent** updates position; **ExecutionAgent** updates active order sizes.

---

## Components in Detail

### `src/index.ts` — Orchestrator

- Creates strategy, `MarketManager`, and all agents.
- Wires events: `market_switch` → risk/quoting/execution/orderbook; `price` → quoting + fair value; `fill` → risk + execution.
- Handles SIGINT/SIGTERM for graceful shutdown.

### `src/config.ts` — Configuration

- Loads from `process.env` via `dotenv`.
- `requireEnv()` for required vars; `envFloat()` / `envInt()` for optional with defaults.
- Holds Polymarket contract addresses, WebSocket URLs, and trading/risk parameters.

### `src/market-manager.ts` — Market Lifecycle

- Polls `discoverActiveMarket()` every `discoveryIntervalMs` (15s).
- When current market expires or is missing, discovers and switches.
- Pre-fetches next market when TTE &lt; 2× discovery interval.
- Emits `market_switch` with `prev` and `current` context.

### `src/strategies/btc-5min.ts` — BTC 5m Strategy

- **Discovery**: Fetches events from Gamma API. With empty `EVENT_SLUG`, derives slug from `floor(now/300)*300` (5-min window).
- **Fair value**: Log-normal CDF — `P(Up) = Φ(ln(S/K) / (σ√T))` where S = spot, K = strike, σ = vol, T = time to expiry.
- **Parameters**: `quotingCutoffMs = 30_000`, `discoveryIntervalMs = 15_000`.

### `src/agents/market-data.ts` — Binance Price Feed

- Connects to `wss://stream.binance.com:9443/ws/btcusdt@trade`.
- On each trade: updates `lastPrice`, computes EWMA variance, emits `price` with annualized vol.
- Auto-reconnects on close.

### `src/agents/orderbook.ts` — Polymarket WebSockets

- **Market WS**: Subscribes to `yesTokenId` and `noTokenId`; parses `book` and `price_change` into `L2Book`.
- **User WS**: Subscribes for fills and order updates; emits `fill` and `order_update`.
- Reconnects on disconnect.

### `src/agents/quoting.ts` — Quote Engine

- `computeSpread()`: Volatility-scaled between MIN and MAX spread (bps).
- `computeQuote()`: `bid = fairValue - halfSpread + inventorySkew`, `ask = fairValue + halfSpread + inventorySkew`.
- `shouldRequote()`: Only emits when bid/ask change exceeds `REQUOTE_THRESHOLD_BPS`.

### `src/agents/risk.ts` — Risk Control

- `processFill()`: Updates `yesShares`, `avgEntryPrice`, `realizedPnl`, `netDelta`.
- `checkQuote()`: Returns `ALLOW` / `REDUCE_ONLY` / `HALT` based on limits.
- `applyRiskAdjustment()`: For REDUCE_ONLY, zeros out the side that would increase position.

### `src/agents/execution.ts` — Order Execution

- `cancelAndReplace()`: Signs bid + ask in parallel with cancel; submits batch.
- Uses `buildL2Headers()` for HMAC auth on all CLOB requests.
- Heartbeat every 5s; fetches fee rate per market.

### `src/signing/eip712.ts` — Order Signing

- `buildOrder()`: Creates `RawOrder` with maker = proxy, signer = wallet, EIP-712 domain for CTF Exchange.
- `signOrder()`: Signs with `wallet.signTypedData()`.
- Supports both CTF and Neg-Risk exchanges via `exchangeAddress(negRisk)`.

### `src/signing/hmac.ts` — CLOB L2 Auth

- `buildHmacSignature()`: `HMAC-SHA256(timestamp + method + path + body)` with API secret; URL-safe base64.
- `buildL2Headers()`: Returns `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_TIMESTAMP`, `POLY_API_KEY`, `POLY_PASSPHRASE`.

---

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| **Generate API keys** | `npm run generate-keys` | Creates CLOB credentials from `PRIVATE_KEY` |
| **Preflight** | `npm run preflight` | Balance check, allowances, test order placement + cancel |
| **Test discovery** | `npm run test-discovery` | Discovers current BTC 5m market without trading |
| **Place and revert** | `npm run place-and-revert` | Places BUY at best ask, waits, places SELL to close, cancels unfilled |
| **Test order** | `npx tsx src/scripts/test-order.ts` | Manual single-order test (requires `YES_TOKEN_ID`, `CONDITION_ID`) |

---

## Deployment

### systemd (Linux)

```bash
npm run build
sudo ./deploy/setup.sh
# Copy .env to /opt/polymarket-bot/.env
sudo systemctl start polymarket-maker
journalctl -u polymarket-maker -f
```

### PM2

```bash
cd /opt/polymarket-bot
npm install -g pm2
pm2 start dist/index.js --name polymarket-maker
pm2 save && pm2 startup
```

---

## License

MIT — see [LICENSE](LICENSE).
