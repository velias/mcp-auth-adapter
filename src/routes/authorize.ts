import { Router, Request, Response, NextFunction } from 'express';
import { Logger, requestMeta } from '../logger';
import {
  CimdDocument,
  isCimdClientId,
  validateCimdUrl,
  validateRedirectUri,
  sanitizeForError,
} from '../cimd';

export interface AuthScopeConfig {
  removed?: string[];
  preserved?: string[];
}

export interface AuthCimdConfig {
  resolve: (cimdUrl: string) => string | null;
  validateAndCache: (cimdUrl: string) => Promise<CimdDocument>;
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
  getUpstreamAuthEndpoint: () => string,
  logger: Logger,
  scopeConfig: AuthScopeConfig = {},
  cimdConfig?: AuthCimdConfig,
): Router {
  const router = Router();

  const handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === 'string') {
          params.set(key, value);
        }
      }

      logger.debug('authorize request', {
        ...requestMeta(req),
        scope: params.get('scope'),
        clientId: params.get('client_id'),
        redirectUri: params.get('redirect_uri'),
        responseType: params.get('response_type'),
      });

      const clientId = params.get('client_id') ?? '';

      if (cimdConfig && clientId && isCimdClientId(clientId)) {
        const urlValidation = validateCimdUrl(clientId);
        if (!urlValidation.valid) {
          res.status(400).json({
            error: 'invalid_client',
            error_description: `Invalid CIMD client_id URL: ${sanitizeForError(urlValidation.reason)}`,
          });
          return;
        }

        const upstreamClientId = cimdConfig.resolve(clientId);
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
          cimdDoc = await cimdConfig.validateAndCache(clientId);
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

      const scope = params.get('scope');
      if (scope) {
        const filtered = filterScopes(scope, scopeConfig);
        if (filtered !== null) {
          params.set('scope', filtered);
        } else {
          params.delete('scope');
        }
      }

      const redirectUrl = `${getUpstreamAuthEndpoint()}?${params.toString()}`;
      logger.debug('authorize redirect', { target: redirectUrl });
      res.redirect(302, redirectUrl);
    } catch (err) {
      next(err);
    }
  };

  router.get('/authorize', (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next);
  });

  return router;
}
