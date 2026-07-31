import { Router, Request, Response } from 'express';

export interface UpstreamHealth {
  url: string;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  usingFallback: boolean;
}

type HealthStatus = 'ok' | 'error';

function upstreamStatus(health: UpstreamHealth): HealthStatus {
  if (health.lastSuccessAt === null) return 'error';
  if (health.lastErrorAt !== null && health.lastErrorAt > health.lastSuccessAt) return 'error';
  return 'ok';
}

const WELL_KNOWN_PATH = '/.well-known/openid-configuration';
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export function createUpstreamProbe(
  health: UpstreamHealth,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): () => Promise<void> {
  let lastProbeAt = 0;
  let inflight: Promise<void> | null = null;

  async function doProbe(): Promise<void> {
    const probeUrl = `${health.url}${WELL_KNOWN_PATH}`;
    try {
      const response = await fetch(probeUrl, {
        method: 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 405) {
        const getResponse = await fetch(probeUrl, {
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!getResponse.ok) {
          throw new Error(`HTTP ${getResponse.status} ${getResponse.statusText}`);
        }
      } else if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      health.lastSuccessAt = Date.now();
      health.usingFallback = false;
    } catch (err) {
      health.lastError = err instanceof Error ? err.message : String(err);
      health.lastErrorAt = Date.now();
    }
  }

  return async () => {
    const now = Date.now();
    if (now - lastProbeAt < cacheTtlMs) return;

    if (inflight) {
      await inflight;
      return;
    }

    lastProbeAt = now;
    inflight = doProbe().finally(() => { inflight = null; });
    await inflight;
  };
}

export function createHealthRouter(
  isShuttingDown: () => boolean = () => false,
  getUpstreamHealth?: () => UpstreamHealth,
  probeUpstream?: () => Promise<void>,
): Router {
  const router = Router();

  router.get('/health/live', (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  router.get('/health/ready', (_req: Request, res: Response) => {
    res.sendStatus(isShuttingDown() ? 503 : 200);
  });

  router.get('/health', (_req: Request, res: Response) => {
    const handle = async () => {
      if (probeUpstream) {
        await probeUpstream();
      }

      const adapterStatus: HealthStatus = isShuttingDown() ? 'error' : 'ok';

      let idpStatus: HealthStatus = 'ok';
      if (getUpstreamHealth) {
        idpStatus = upstreamStatus(getUpstreamHealth());
      }

      const overall: HealthStatus = (adapterStatus === 'error' || idpStatus === 'error') ? 'error' : 'ok';

      const body: Record<string, unknown> = {
        status: overall,
        checks: {
          adapter: adapterStatus,
          upstream_idp: idpStatus,
        },
      };

      if (overall !== 'ok') {
        const messages: string[] = [];
        if (adapterStatus === 'error') messages.push('adapter: shutting down');
        if (idpStatus === 'error') {
          const h = getUpstreamHealth?.();
          messages.push(h?.usingFallback
            ? 'upstream_idp: never successfully reached, using fallback config'
            : 'upstream_idp: unreachable');
        }
        body.message = messages.join('; ');
      }

      if (getUpstreamHealth) {
        const h = getUpstreamHealth();
        const detail: Record<string, unknown> = { url: h.url };
        if (h.lastSuccessAt !== null) detail.last_success_at = new Date(h.lastSuccessAt).toISOString();
        if (h.lastError !== null) detail.last_error = h.lastError;
        if (h.lastErrorAt !== null) detail.last_error_at = new Date(h.lastErrorAt).toISOString();
        if (h.usingFallback) detail.using_fallback = true;
        body.upstream_idp = detail;
      }

      res.status(overall === 'error' ? 503 : 200).json(body);
    };

    handle().catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ status: 'error', message: 'health check failed unexpectedly' });
      }
    });
  });

  return router;
}
