import { Wallet } from 'ethers';
import { CONFIG } from './config.js';
import { logger } from './utils/logger.js';
import { MarketManager } from './market-manager.js';
import { Btc5MinStrategy } from './strategies/btc-5min.js';
import { MarketDataAgent } from './agents/market-data.js';
import { OrderbookAgent } from './agents/orderbook.js';
import { QuotingAgent } from './agents/quoting.js';
import { ExecutionAgent } from './agents/execution.js';
import { RiskAgent, RiskAction } from './agents/risk.js';
import { LatencyMonitor } from './agents/latency.js';
import type { MarketStrategy } from './strategies/types.js';
import type { ActiveMarketContext } from './strategies/types.js';

const log = logger.child({ agent: 'Orchestrator' });

function createStrategy(): MarketStrategy {
  switch (CONFIG.MARKET_STRATEGY) {
    case 'btc-5min':
      // EVENT_SLUG: specific event (e.g. btc-updown-5m-1771697400) or empty for series discovery
      return new Btc5MinStrategy(CONFIG.EVENT_SLUG || '');
    default:
      throw new Error(`Unknown strategy: ${CONFIG.MARKET_STRATEGY}`);
  }
}

async function main() {
  log.info('=== Polymarket Maker Bot Starting ===');
  log.info(
    {
      wallet: CONFIG.WALLET_ADDRESS,
      proxy: CONFIG.PROXY_ADDRESS,
      signatureType: CONFIG.SIGNATURE_TYPE,
      strategy: CONFIG.MARKET_STRATEGY,
      eventSlug: CONFIG.EVENT_SLUG,
    },
    'Configuration loaded',
  );

  const wallet = new Wallet(CONFIG.PRIVATE_KEY);
  if (wallet.address.toLowerCase() !== CONFIG.WALLET_ADDRESS.toLowerCase()) {
    throw new Error(
      `Wallet address mismatch: derived ${wallet.address}, expected ${CONFIG.WALLET_ADDRESS}`,
    );
  }
  log.info('Wallet verified');

  const strategy = createStrategy();
  const marketManager = new MarketManager(strategy);

  const marketData = new MarketDataAgent();
  const orderbook = new OrderbookAgent();
  const quoting = new QuotingAgent();
  const execution = new ExecutionAgent(wallet);
  const risk = new RiskAgent();
  const latency = new LatencyMonitor();

  // --- Market rotation wiring ---
  marketManager.on(
    'market_switch',
    async (ev: { prev: ActiveMarketContext | null; current: ActiveMarketContext }) => {
      const { current } = ev;
      log.info(
        { conditionId: current.conditionId, description: current.description },
        'Market rotation triggered',
      );

      risk.resetForNewMarket();
      quoting.resetForNewMarket();
      quoting.setTickSize(current.tickSize);

      await execution.setMarket(current);
      orderbook.switchMarket(current);
    },
  );

  // --- MarketDataAgent → QuotingAgent + MarketManager ---
  marketData.on('price', (data: { price: number; volatility: number; latencyMs: number }) => {
    quoting.updateMarketData(data.price, data.volatility);
    latency.recordBinanceLatency(performance.now() - data.latencyMs);

    marketManager.updateStrikePrice(data.price);

    const tte = marketManager.getTimeToExpiryMs();
    if (tte <= 0) return;

    if (tte < marketManager.quotingCutoffMs) return;

    const fairValue = marketManager.computeFairValue(data.price, data.volatility, tte);
    const quote = quoting.computeQuote(fairValue);
    if (!quote) return;

    const riskAction = risk.checkQuote(quote);
    if (riskAction === RiskAction.HALT) {
      log.warn('Risk HALT — cancelling all');
      execution.cancelAll();
      return;
    }

    const adjustedQuote = risk.applyRiskAdjustment(quote, riskAction);
    if (adjustedQuote.bidSize <= 0 && adjustedQuote.askSize <= 0) return;

    execution.cancelAndReplace(adjustedQuote).then((timings) => {
      if (timings.cycleMs > 0) latency.recordCycle(timings);
    });
  });

  // --- OrderbookAgent fills → RiskAgent + ExecutionAgent ---
  orderbook.on('fill', (msg: any) => {
    const side = msg.side as string;
    const price = parseFloat(msg.price);
    const size = parseFloat(msg.size);
    risk.processFill(side, price, size);

    for (const maker of msg.maker_orders || []) {
      execution.handleFill(maker.order_id, parseFloat(maker.matched_amount), side);
    }
  });

  orderbook.on('order_update', (msg: any) => {
    if (msg.type === 'CANCELLATION') {
      log.debug({ orderId: msg.id }, 'Order cancelled');
    }
  });

  // --- RiskAgent position updates → QuotingAgent ---
  risk.on('position_update', (pos) => {
    quoting.updatePosition(pos);
    risk.updateUnrealizedPnl(quoting.currentQuote?.fairValue ?? 0.5);
  });

  risk.on('halt', (reason: string) => {
    log.error({ reason }, 'RISK HALT — cancelling all orders');
    execution.cancelAll();
  });

  // --- OrderbookAgent book updates → LatencyMonitor ---
  orderbook.on('book_update', (data: { recvTs: number }) => {
    latency.recordPolymarketWsLatency(performance.now() - data.recvTs);
  });

  // --- Startup sequence ---
  await execution.init();
  marketData.start();
  orderbook.start();
  latency.start();
  await marketManager.start();

  log.info('=== All agents running ===');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down...');
    marketManager.stop();
    marketData.stop();
    orderbook.stop();
    latency.stop();
    await execution.cancelAll();
    execution.stop();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'Unhandled rejection');
  });
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
