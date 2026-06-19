import { Router, Request, Response } from 'express';
import { Logger, requestMeta } from '../logger';
import {
  CimdDocument,
  isCimdClientId,
  validateCimdUrl,
  validateRedirectUri,
  sanitizeForError,
} from '../cimd';
import { matchesRedirectPattern, checkResourceParam, ResourceConfig } from '../uri-validation';
import { signState } from '../state-signer';

export interface AuthScopeConfig {
  removed?: string[];
  preserved?: string[];
}

export interface AuthorizeRouterConfig extends AuthScopeConfig, ResourceConfig {
  getUpstreamAuthEndpoint: () => string;
  cimdResolve?: (cimdUrl: string) => string | null;
  cimdValidateAndCache?: (cimdUrl: string) => Promise<CimdDocument>;
  stateBaseUrl?: string;
  stateSecret?: Buffer;
  stateTtlSeconds?: number;
  stateAllowedRedirectUris?: string[];
}

export function filterScopes(
  scopeParam: string,
  scopeConfig: AuthScopeConfig,
): string | null {
  const scopes = scopeParam.split(' ').filter(Boolean);
  let filtered: string[];
  if (scopeConfig.preserved && scopeConfig.preserved.length > 0) {
    const set = new Set(scopeConfig.preserved);
    filtered = scopes.filter(s => set.has(s));
  } else if (scopeConfig.removed && scopeConfig.removed.length > 0) {
    const set = new Set(scopeConfig.removed);
    filtered = scopes.filter(s => !set.has(s));
  } else {
    return scopeParam;
  }
  return filtered.length > 0 ? filtered.join(' ') : null;
}

export function createAuthorizeRouter(
  config: AuthorizeRouterConfig,
  logger: Logger,
): Router {
  const router = Router();

  router.get('/authorize', async (req: Request, res: Response) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') {
        params.set(key, value);
      }
    }

    const resource = params.get('resource') || '';

    logger.debug('authorize request', {
      ...requestMeta(req),
      scope: params.get('scope'),
      clientId: params.get('client_id'),
      redirectUri: params.get('redirect_uri'),
      responseType: params.get('response_type'),
      resource: resource || 'MISSING',
    });

    // RFC 8707 resource parameter validation
    const resourceError = checkResourceParam(resource, config);
    if (resourceError) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: resourceError,
      });
      return;
    }

    // Strip unsupported response_mode
    const responseMode = params.get('response_mode');
    if (responseMode && responseMode !== 'query') {
      logger.debug('authorize: unsupported response_mode stripped', { responseMode });
      params.delete('response_mode');
    }

    const clientId = params.get('client_id') ?? '';
    let isCimd = false;

    if (config.cimdResolve && clientId && isCimdClientId(clientId)) {
      isCimd = true;
      const urlValidation = validateCimdUrl(clientId);
      if (!urlValidation.valid) {
        res.status(400).json({
          error: 'invalid_client',
          error_description: `Invalid CIMD client_id URL: ${sanitizeForError(urlValidation.reason)}`,
        });
        return;
      }

      const upstreamClientId = config.cimdResolve(clientId);
      if (!upstreamClientId) {
        logger.debug('authorize: unknown CIMD client rejected', { clientId: clientId.slice(0, 80) });
        res.status(403).json({
          error: 'invalid_client',
          error_description: `Unknown CIMD client: ${sanitizeForError(clientId)}`,
        });
        return;
      }

      let cimdDoc: CimdDocument;
      try {
        cimdDoc = await config.cimdValidateAndCache!(clientId);
      } catch (err) {
        logger.error('authorize: CIMD metadata fetch/validation failed', {
          clientId: clientId.slice(0, 80),
          error: String(err),
        });
        res.status(400).json({
          error: 'invalid_client',
          error_description: 'Failed to fetch or validate CIMD metadata document',
        });
        return;
      }

      const redirectUri = params.get('redirect_uri');
      if (redirectUri && !validateRedirectUri(redirectUri, cimdDoc)) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: `redirect_uri does not match any registered URI in the CIMD metadata document`,
        });
        return;
      }

      params.set('client_id', upstreamClientId);
    }

    // Validate and wrap redirect_uri for iss interception
    if (config.stateSecret) {
      const redirectUri = params.get('redirect_uri');
      if (!redirectUri) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'redirect_uri is required',
        });
        return;
      }

      if (!isCimd) {
        const match = matchesRedirectPattern(redirectUri, config.stateAllowedRedirectUris!);
        if (!match.allowed) {
          logger.debug('authorize: redirect_uri rejected', {
            reason: match.reason,
            uri: redirectUri.slice(0, 200),
          });
          res.status(400).json({
            error: 'invalid_request',
            error_description: 'redirect_uri not allowed',
          });
          return;
        }
      }

      const originalState = params.get('state') ?? null;
      const blob = signState(
        { redirectUri, state: originalState },
        config.stateSecret,
        config.stateTtlSeconds!,
      );

      params.set('redirect_uri', `${config.stateBaseUrl}/authorize/callback`);
      params.set('state', blob);
    }

    const scope = params.get('scope');
    if (scope) {
      const filtered = filterScopes(scope, config);
      if (filtered !== null) {
        params.set('scope', filtered);
      } else {
        params.delete('scope');
      }
    }

    const upstreamEndpoint = config.getUpstreamAuthEndpoint();
    const separator = upstreamEndpoint.includes('?') ? '&' : '?';
    const redirectUrl = `${upstreamEndpoint}${separator}${params.toString()}`;
    logger.debug('authorize redirect', { target: redirectUrl });
    res.redirect(302, redirectUrl);
  });

  return router;
}
