import { Router, Request, Response } from 'express';
import { IMetricsRegistry, IGauge } from '../metrics';

export function createMetricsRouter(metricsRegistry: IMetricsRegistry): Router {
  const router = Router();

  const uptimeGauge = metricsRegistry.createGauge('process_uptime_seconds', 'Process uptime in seconds');
  const rssGauge = metricsRegistry.createGauge('process_resident_memory_bytes', 'Resident memory size in bytes');
  const heapUsedGauge = metricsRegistry.createGauge('process_heap_used_bytes', 'V8 heap used in bytes');

  let eventLoopLagGauge: IGauge | undefined;
  let eventLoopHistogram: ReturnType<typeof import('perf_hooks').monitorEventLoopDelay> | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { monitorEventLoopDelay } = require('perf_hooks') as typeof import('perf_hooks');
    eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    eventLoopHistogram.enable();
    eventLoopLagGauge = metricsRegistry.createGauge('nodejs_eventloop_lag_seconds', 'Event loop lag in seconds');
  } catch {
    // monitorEventLoopDelay not available
  }

  router.get('/metrics', (_req: Request, res: Response) => {
    uptimeGauge.set(process.uptime());
    const mem = process.memoryUsage();
    rssGauge.set(mem.rss);
    heapUsedGauge.set(mem.heapUsed);

    if (eventLoopLagGauge && eventLoopHistogram) {
      const meanNs = eventLoopHistogram.mean;
      if (!Number.isNaN(meanNs)) {
        eventLoopLagGauge.set(meanNs / 1e9);
      }
    }

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(metricsRegistry.serialize());
  });

  return router;
}
