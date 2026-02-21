import { childLogger } from '../utils/logger.js';
import type { LatencyMetrics } from '../types.js';

const log = childLogger('LatencyMonitor');

const EWMA_ALPHA = 0.1;

export class LatencyMonitor {
  private metrics: LatencyMetrics = {
    cancelLatencyMs: 0,
    submitLatencyMs: 0,
    cycleLatencyMs: 0,
    signLatencyMs: 0,
    binanceLatencyMs: 0,
    polymarketWsLatencyMs: 0,
    ewmaCycleMs: 0,
  };
  private cycleCount = 0;
  private logInterval: ReturnType<typeof setInterval> | null = null;

  get current(): LatencyMetrics {
    return { ...this.metrics };
  }

  start(): void {
    this.logInterval = setInterval(() => this.logMetrics(), 10_000);
  }

  stop(): void {
    if (this.logInterval) clearInterval(this.logInterval);
  }

  recordCycle(data: {
    cycleMs: number;
    signMs: number;
    cancelMs: number;
    submitMs: number;
  }): void {
    this.metrics.cycleLatencyMs = data.cycleMs;
    this.metrics.signLatencyMs = data.signMs;
    this.metrics.cancelLatencyMs = data.cancelMs;
    this.metrics.submitLatencyMs = data.submitMs;
    this.metrics.ewmaCycleMs =
      EWMA_ALPHA * data.cycleMs + (1 - EWMA_ALPHA) * this.metrics.ewmaCycleMs;
    this.cycleCount++;

    if (data.cycleMs > 100) {
      log.warn({ cycleMs: data.cycleMs.toFixed(1) }, 'Cancel/replace cycle exceeded 100ms');
    }
  }

  recordBinanceLatency(latencyMs: number): void {
    this.metrics.binanceLatencyMs = latencyMs;
  }

  recordPolymarketWsLatency(latencyMs: number): void {
    this.metrics.polymarketWsLatencyMs = latencyMs;
  }

  private logMetrics(): void {
    log.info(
      {
        cycles: this.cycleCount,
        ewmaCycleMs: this.metrics.ewmaCycleMs.toFixed(1),
        lastCycleMs: this.metrics.cycleLatencyMs.toFixed(1),
        signMs: this.metrics.signLatencyMs.toFixed(1),
        cancelMs: this.metrics.cancelLatencyMs.toFixed(1),
        submitMs: this.metrics.submitLatencyMs.toFixed(1),
        binanceMs: this.metrics.binanceLatencyMs.toFixed(1),
      },
      'Latency report',
    );
  }
}
