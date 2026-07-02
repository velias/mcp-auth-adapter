import { Router, Request, Response } from 'express';
import { AppConfig } from '../config';
import { Logger } from '../logger';
import { ICounter } from '../metrics';
import { requireJsonContentType } from '../middleware/security';
import { validateRedirectUriSecurity } from '../uri-validation';

const ROUTE = '/register';
const DCR_ECHO_FIELDS = [
  'redirect_uris',
  'grant_types',
  'response_types',
  'client_name',
  'client_uri',
  'logo_uri',
  'scope',
  'contacts',
  'tos_uri',
  'policy_uri',
  'software_id',
  'software_version',
  'software_statement',
] as const;

type ValidationError = { field: string; reason: string } | null;

/**
 * Validates redirect_uris: must be an array of strings, each parseable as a
 * URL with no fragment (RFC 6749 §3.1.2). Any URI scheme is accepted
 * (custom/private-use schemes are valid per RFC 8252 §7.1).
 */
export function validateRedirectUris(value: unknown): ValidationError {
  if (!Array.isArray(value)) {
    return { field: 'redirect_uris', reason: 'must be an array' };
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      return { field: `redirect_uris[${i}]`, reason: 'must be a string' };
    }
    const uri = value[i] as string;
    const result = validateRedirectUriSecurity(uri);
    if (!result.valid) {
      return { field: `redirect_uris[${i}]`, reason: result.reason };
    }
  }
  return null;
}

/** Validates that the value is an array of strings. */
export function validateStringArray(field: string, value: unknown): ValidationError {
  if (!Array.isArray(value)) {
    return { field, reason: 'must be an array' };
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      return { field: `${field}[${i}]`, reason: 'must be a string' };
    }
  }
  return null;
}

export function createRegisterRouter(config: AppConfig, logger: Logger, rejectedTotal: ICounter): Router {
  const router = Router();

  router.post('/register', requireJsonContentType, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    logger.accessLog('DCR register request', req, res, {
      clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
      softwareId: typeof body.software_id === 'string' ? body.software_id : undefined,
      scope: typeof body.scope === 'string' ? body.scope : undefined,
      grantTypes: Array.isArray(body.grant_types) ? (body.grant_types as unknown[]).join(',') : undefined,
      redirectUriCount: Array.isArray(body.redirect_uris) ? body.redirect_uris.length : 0,
    });

    if (body.redirect_uris !== undefined) {
      const err = validateRedirectUris(body.redirect_uris);
      if (err) {
        rejectedTotal.inc({ route: ROUTE, reason: 'invalid_redirect_uris' });
        res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: `${err.field}: ${err.reason}`,
        });
        return;
      }
    }

    for (const field of ['grant_types', 'response_types'] as const) {
      if (body[field] !== undefined) {
        const err = validateStringArray(field, body[field]);
        if (err) {
          rejectedTotal.inc({ route: ROUTE, reason: `invalid_${field}` });
          res.status(400).json({
            error: 'invalid_client_metadata',
            error_description: `${err.field}: ${err.reason}`,
          });
          return;
        }
      }
    }

    const response: Record<string, unknown> = {
      client_id: config.clientId,
      token_endpoint_auth_method: 'none',
    };

    for (const field of DCR_ECHO_FIELDS) {
      if (field in body) {
        response[field] = body[field];
      }
    }

    res.status(201)
      .set('Cache-Control', 'no-store')
      .json(response);
  });

  return router;
}
