import { Router, Request, Response } from 'express';
import { AppConfig } from '../config';
import { Logger, requestMeta } from '../logger';
import { requireJsonContentType } from '../middleware/security';

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
    try {
      const parsed = new URL(uri);
      if (parsed.hash) {
        return { field: `redirect_uris[${i}]`, reason: 'must not contain a fragment' };
      }
    } catch {
      return { field: `redirect_uris[${i}]`, reason: 'is not a valid URI' };
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

export function createRegisterRouter(config: AppConfig, logger: Logger): Router {
  const router = Router();

  router.post('/register', requireJsonContentType, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    logger.debug('DCR register request', {
      ...requestMeta(req),
      clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
      redirectUriCount: Array.isArray(body.redirect_uris) ? body.redirect_uris.length : 0,
    });

    if (body.redirect_uris !== undefined) {
      const err = validateRedirectUris(body.redirect_uris);
      if (err) {
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
