import { Router, Request, Response } from 'express';
import express from 'express';
import { Logger, requestMeta } from '../logger';
import { isCimdClientId, resolveUpstreamClientId, sanitizeForError } from '../cimd';

const TOKEN_UPSTREAM_TIMEOUT_MS = 10000;
const TOKEN_UPSTREAM_MAX_RESPONSE_BYTES = 64 * 1024;
const RELAY_HEADERS = ['content-type', 'cache-control', 'pragma'];

export interface TokenCimdResolver {
  map: Record<string, string>;
  defaultClientId?: string;
}

export function createTokenRouter(
  getUpstreamTokenEndpoint: () => string,
  cimdResolver: TokenCimdResolver,
  logger: Logger,
): Router {
  const router = Router();

  const urlencodedParser = express.urlencoded({ extended: false, limit: '16kb' });

  router.post('/token', (req: Request, res: Response, next) => {
    const contentType = req.get('content-type') ?? '';
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      res.status(415).json({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
      return;
    }
    next();
  }, urlencodedParser, (req: Request, res: Response) => {
    void handleTokenRequest(req, res, getUpstreamTokenEndpoint, cimdResolver, logger);
  });

  return router;
}

async function handleTokenRequest(
  req: Request,
  res: Response,
  getUpstreamTokenEndpoint: () => string,
  cimdResolver: TokenCimdResolver,
  logger: Logger,
): Promise<void> {
  try {
    const body = req.body as Record<string, string>;
    const clientId = body.client_id ?? '';

    logger.debug('token proxy request', {
      ...requestMeta(req),
      clientId: clientId.startsWith('https://') ? clientId.slice(0, 80) : clientId,
      grantType: body.grant_type,
    });

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') {
        params.set(key, value);
      }
    }

    if (clientId && isCimdClientId(clientId)) {
      const upstreamClientId = resolveUpstreamClientId(
        clientId,
        cimdResolver.map,
        cimdResolver.defaultClientId,
      );

      if (!upstreamClientId) {
        logger.debug('token proxy: unknown CIMD client rejected', { clientId: clientId.slice(0, 80) });
        res.status(403).json({
          error: 'invalid_client',
          error_description: `Unknown CIMD client: ${sanitizeForError(clientId)}`,
        });
        return;
      }

      params.set('client_id', upstreamClientId);
    }

    const upstreamUrl = getUpstreamTokenEndpoint();
    let upstreamResponse: globalThis.Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(TOKEN_UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      logger.error('token proxy: upstream request failed', { error: String(err) });
      res.status(502).json({
        error: 'server_error',
        error_description: 'Token endpoint upstream request failed',
      });
      return;
    }

    let responseBody: Buffer;
    try {
      const reader = upstreamResponse.body?.getReader();
      if (!reader) {
        res.status(502).json({
          error: 'server_error',
          error_description: 'Token endpoint upstream returned no body',
        });
        return;
      }

      let totalBytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          const chunk = result.value as Uint8Array;
          totalBytes += chunk.byteLength;
          if (totalBytes > TOKEN_UPSTREAM_MAX_RESPONSE_BYTES) {
            reader.cancel().catch(() => {});
            res.status(502).json({
              error: 'server_error',
              error_description: 'Token endpoint upstream response too large',
            });
            return;
          }
          chunks.push(chunk);
        }
      } finally {
        reader.releaseLock();
      }

      responseBody = Buffer.concat(chunks);
    } catch (readErr) {
      logger.error('token proxy: failed reading upstream response', { error: String(readErr) });
      res.status(502).json({
        error: 'server_error',
        error_description: 'Failed reading token endpoint upstream response',
      });
      return;
    }

    for (const header of RELAY_HEADERS) {
      const value = upstreamResponse.headers.get(header);
      if (value) {
        res.set(header, value);
      }
    }

    res.status(upstreamResponse.status).send(responseBody);
  } catch (err) {
    logger.error('token proxy: unexpected error', { error: String(err) });
    res.status(500).json({
      error: 'server_error',
      error_description: 'Internal server error',
    });
  }
}
