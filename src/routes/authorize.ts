import { Router, Request, Response } from 'express';
import { Logger } from '../logger';
import { ICounter } from '../metrics';
import {
  AuthScopeConfig,
  AuthRequestTransformConfig,
  applyAuthorizationRequestTransforms,
  applyCimdClientIdSubstitution,
  filterScopes,
} from '../auth-request-transforms';

export type { AuthScopeConfig };
export { filterScopes };

const ROUTE = '/authorize';

export interface AuthorizeRouterConfig extends AuthRequestTransformConfig {
  getUpstreamAuthEndpoint: () => string;
  /** Upstream PAR endpoint when present; empty/undefined disables request_uri passthrough. */
  getUpstreamParEndpoint?: () => string;
  rejectedTotal: ICounter;
  redirectsTotal: ICounter;
}

export function createAuthorizeRouter(
  config: AuthorizeRouterConfig,
  logger: Logger,
): Router {
  const router = Router();

  const scopeConfig: AuthScopeConfig = {
    ...config,
    preservedSet: config.preserved?.length ? new Set(config.preserved) : undefined,
    removedSet: config.removed?.length ? new Set(config.removed) : undefined,
  };

  router.get('/authorize', async (req: Request, res: Response) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') {
        params.set(key, value);
      }
    }

    const requestUri = params.get('request_uri') || '';
    const upstreamPar = config.getUpstreamParEndpoint?.() ?? '';
    const parActive = !!upstreamPar;

    logger.accessLog('authorize request', req, res, {
      scope: params.get('scope'),
      clientId: params.get('client_id'),
      redirectUri: params.get('redirect_uri'),
      responseType: params.get('response_type'),
      codeChallengeMethod: params.get('code_challenge_method') || 'MISSING',
      statePresent: params.has('state'),
      resource: params.get('resource') || 'MISSING',
      requestUriPresent: !!requestUri,
    });

    // PAR follow-up: client_id + request_uri only (transforms already applied at POST /par)
    if (parActive && requestUri) {
      const clientId = params.get('client_id') ?? '';
      if (!clientId) {
        logger.warn('authorize: client_id missing with request_uri', {});
        config.rejectedTotal.inc({ route: ROUTE, reason: 'client_id_missing' });
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'client_id is required',
        });
        return;
      }

      const cimdResult = await applyCimdClientIdSubstitution(params, config, logger, 'authorize');
      if (!cimdResult.ok) {
        config.rejectedTotal.inc({
          route: ROUTE,
          reason: cimdResult.reason,
          ...cimdResult.resourceLabel,
          ...cimdResult.idpClientLabel,
        });
        res.status(cimdResult.status).json(cimdResult.body);
        return;
      }

      const forward = new URLSearchParams();
      forward.set('client_id', cimdResult.params.get('client_id')!);
      forward.set('request_uri', requestUri);

      const effectiveClientId = forward.get('client_id') ?? '';
      const idpClientLabel: Record<string, string> = config.knownIdpClients?.has(effectiveClientId)
        ? { idp_client: effectiveClientId }
        : {};

      const upstreamEndpoint = config.getUpstreamAuthEndpoint();
      const separator = upstreamEndpoint.includes('?') ? '&' : '?';
      const redirectUrl = `${upstreamEndpoint}${separator}${forward.toString()}`;
      if (logger.isDebugEnabled) logger.debug('authorize redirect (request_uri)', { target: redirectUrl });
      if (Object.keys(idpClientLabel).length > 0) config.redirectsTotal.inc(idpClientLabel);
      else config.redirectsTotal.inc();
      res.redirect(302, redirectUrl);
      return;
    }

    const result = await applyAuthorizationRequestTransforms(
      params,
      config,
      scopeConfig,
      logger,
      'authorize',
    );

    if (!result.ok) {
      config.rejectedTotal.inc({
        route: ROUTE,
        reason: result.reason,
        ...result.resourceLabel,
        ...result.idpClientLabel,
      });
      res.status(result.status).json(result.body);
      return;
    }

    const upstreamEndpoint = config.getUpstreamAuthEndpoint();
    const separator = upstreamEndpoint.includes('?') ? '&' : '?';
    const redirectUrl = `${upstreamEndpoint}${separator}${result.params.toString()}`;
    if (logger.isDebugEnabled) logger.debug('authorize redirect', { target: redirectUrl });
    const redirectLabels = { ...result.resourceLabel, ...result.idpClientLabel };
    if (Object.keys(redirectLabels).length > 0) config.redirectsTotal.inc(redirectLabels);
    else config.redirectsTotal.inc();
    res.redirect(302, redirectUrl);
  });

  return router;
}
