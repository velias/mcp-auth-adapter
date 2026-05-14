import { Request, Response, NextFunction } from 'express';
import { ICounter, IHistogram } from '../metrics';

export interface HttpMetrics {
  requestsTotal: ICounter;
  requestDuration: IHistogram;
}

/**
 * Only records metrics when the request was handled by a matched route
 * (req.route is set by Express). Unmatched paths, health probes, and
 * /metrics itself are never instrumented.
 */
export function createHttpMetricsMiddleware(
  httpMetrics: HttpMetrics,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route as { path: string } | undefined;
      if (!route) return;
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const path = route.path;
      const labels = { method: req.method, path, status: String(res.statusCode) };
      httpMetrics.requestsTotal.inc(labels);
      httpMetrics.requestDuration.observe(durationSec, { method: req.method, path });
    });
    next();
  };
}
