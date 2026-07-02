import { Router, Request, Response } from 'express';
import { Logger } from '../logger';
import { ICounter } from '../metrics';
import { verifyState } from '../state-signer';

export interface CallbackConfig {
  baseUrl: string;
  getSecrets: () => Buffer[];
  getUpstreamIssuer: () => string;
  getUpstreamSupportsIss: () => boolean;
  rejectedTotal: ICounter;
}

const ROUTE = '/authorize/callback';
const ALLOWED_SUCCESS_PARAMS = new Set(['code', 'state', 'iss']);
const ALLOWED_ERROR_PARAMS = new Set(['error', 'error_description', 'error_uri', 'state']);

export function createAuthorizeCallbackRouter(
  config: CallbackConfig,
  logger: Logger,
): Router {
  const router = Router();

  router.get('/authorize/callback', (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
    const code = str(query.code);
    const error = str(query.error);
    const stateBlob = str(query.state);
    const upstreamIss = str(query.iss);

    logger.accessLog('authorize callback request', req, res, {
      code_present: !!code,
      error: error,
      iss: upstreamIss,
    });

    if (!stateBlob) {
      logger.warn('authorize callback: missing state parameter');
      config.rejectedTotal.inc({ route: ROUTE, reason: 'state_missing' });
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing state parameter',
      });
      return;
    }

    const payload = verifyState(stateBlob, config.getSecrets());
    if (!payload) {
      logger.warn('authorize callback: state verification failed');
      config.rejectedTotal.inc({ route: ROUTE, reason: 'state_verification_failed' });
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'State verification failed',
      });
      return;
    }

    if (!code && !error) {
      logger.warn('authorize callback: malformed callback (neither code nor error)');
      config.rejectedTotal.inc({ route: ROUTE, reason: 'malformed_callback' });
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Malformed callback: missing both code and error',
      });
      return;
    }

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(payload.redirectUri);
    } catch {
      logger.error('authorize callback: invalid redirectUri in verified state blob', {
        uri: payload.redirectUri.slice(0, 200),
      });
      config.rejectedTotal.inc({ route: ROUTE, reason: 'redirect_uri_invalid' });
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'State contains invalid redirect URI',
      });
      return;
    }

    if (code) {
      const upstreamSupportsIss = config.getUpstreamSupportsIss();
      const expectedIssuer = config.getUpstreamIssuer();

      if (upstreamSupportsIss) {
        if (!upstreamIss) {
          logger.warn('authorize callback: upstream iss missing (upstream supports RFC 9207)', {
            expected: expectedIssuer,
          });
          config.rejectedTotal.inc({ route: ROUTE, reason: 'iss_missing' });
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'Missing iss parameter from upstream',
          });
          return;
        }
        if (upstreamIss !== expectedIssuer) {
          logger.warn('authorize callback: upstream iss mismatch', {
            received: upstreamIss,
            expected: expectedIssuer,
          });
          config.rejectedTotal.inc({ route: ROUTE, reason: 'iss_mismatch' });
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'Invalid iss parameter',
          });
          return;
        }
      } else {
        if (upstreamIss && upstreamIss !== expectedIssuer) {
          logger.warn('authorize callback: upstream iss mismatch (defense in depth)', {
            received: upstreamIss,
            expected: expectedIssuer,
          });
          config.rejectedTotal.inc({ route: ROUTE, reason: 'iss_mismatch' });
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'Invalid iss parameter',
          });
          return;
        }
      }

      for (const [key, value] of Object.entries(query)) {
        if (ALLOWED_SUCCESS_PARAMS.has(key) && key !== 'state' && key !== 'iss' && typeof value === 'string') {
          redirectUrl.searchParams.set(key, value);
        }
      }
      if (payload.state !== null) {
        redirectUrl.searchParams.set('state', payload.state);
      }
      redirectUrl.searchParams.set('iss', config.baseUrl);

      if (logger.isDebugEnabled) logger.debug('authorize callback: success redirect', {
        target: redirectUrl.href.split('?')[0],
      });

      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      res.redirect(302, redirectUrl.toString());
      return;
    }

    // Error response forwarding
    for (const [key, value] of Object.entries(query)) {
      if (ALLOWED_ERROR_PARAMS.has(key) && key !== 'state' && typeof value === 'string') {
        redirectUrl.searchParams.set(key, value);
      }
    }
    if (payload.state !== null) {
      redirectUrl.searchParams.set('state', payload.state);
    }

    if (logger.isDebugEnabled) logger.debug('authorize callback: error forwarding', {
      error: error,
    });

    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.redirect(302, redirectUrl.toString());
  });

  return router;
}
