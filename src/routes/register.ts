import { Router, Request, Response } from 'express';
import { ParsedClientNameEntry, matchClientName } from '../config';
import { Logger } from '../logger';
import { ICounter, IMetricsRegistry } from '../metrics';
import { requireJsonContentType } from '../middleware/security';
import { validateRedirectUriSecurity } from '../uri-validation';

const ROUTE = '/register';
const CLIENT_NAME_LOG_MAX = 200;
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

export interface RegisterRouterConfig {
  defaultClientId?: string;
  dcrClientNameMap: ParsedClientNameEntry[];
  rejectedTotal: ICounter;
  metricsRegistry?: IMetricsRegistry;
  knownIdpClients?: Set<string>;
}

export function createRegisterRouter(config: RegisterRouterConfig, logger: Logger): Router {
  const router = Router();

  const registrationsTotal = config.metricsRegistry?.createCounter(
    'mcp_auth_dcr_registrations_total',
    'Successful DCR registrations',
  );

  router.post('/register', requireJsonContentType, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const rawClientName = typeof body.client_name === 'string' ? body.client_name : undefined;
    const truncatedClientName = rawClientName
      ? (rawClientName.length > CLIENT_NAME_LOG_MAX ? rawClientName.slice(0, CLIENT_NAME_LOG_MAX) : rawClientName)
      : undefined;

    const baseLogMeta = {
      clientName: truncatedClientName,
      softwareId: typeof body.software_id === 'string' ? body.software_id : undefined,
      scope: typeof body.scope === 'string' ? body.scope : undefined,
      grantTypes: Array.isArray(body.grant_types) ? (body.grant_types as unknown[]).join(',') : undefined,
      redirectUriCount: Array.isArray(body.redirect_uris) ? body.redirect_uris.length : 0,
    };

    if (body.redirect_uris !== undefined) {
      const err = validateRedirectUris(body.redirect_uris);
      if (err) {
        logger.warn('DCR: invalid redirect_uris', { field: err.field, reason: err.reason, clientName: truncatedClientName });
        logger.accessLog('DCR register request', req, res, baseLogMeta);
        config.rejectedTotal.inc({ route: ROUTE, reason: 'invalid_redirect_uris' });
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
          logger.warn(`DCR: invalid ${field}`, { field: err.field, reason: err.reason, clientName: truncatedClientName });
          logger.accessLog('DCR register request', req, res, baseLogMeta);
          config.rejectedTotal.inc({ route: ROUTE, reason: `invalid_${field}` });
          res.status(400).json({
            error: 'invalid_client_metadata',
            error_description: `${err.field}: ${err.reason}`,
          });
          return;
        }
      }
    }

    // Resolve client_id via client_name mapping
    let resolvedClientId: string;
    let matchedMapping: string | undefined;
    let matchType: string;

    const matched = matchClientName(rawClientName, config.dcrClientNameMap);
    if (matched) {
      resolvedClientId = matched.clientId;
      matchedMapping = matched.isPrefix
        ? `prefix:${matched.originalPattern}`
        : `exact:${matched.originalPattern}`;
      matchType = matched.isPrefix ? 'prefix' : 'exact';
    } else if (config.defaultClientId) {
      resolvedClientId = config.defaultClientId;
      matchType = 'default';
    } else {
      logger.warn('DCR: unknown client_name rejected (no match, no default)', { clientName: truncatedClientName });
      logger.accessLog('DCR register request', req, res, baseLogMeta);
      config.rejectedTotal.inc({ route: ROUTE, reason: 'client_name_unknown' });
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'Unknown client: client_name does not match any configured mapping and no default client_id is configured',
      });
      return;
    }

    if (logger.isDebugEnabled) logger.debug('DCR: client_id resolved', {
      clientName: truncatedClientName,
      resolvedClientId,
      matchType,
      matchedMapping,
    });

    const metricsLabels: Record<string, string> = { match_type: matchType };
    if (config.knownIdpClients?.has(resolvedClientId)) {
      metricsLabels.idp_client = resolvedClientId;
    }

    logger.accessLog('DCR register request', req, res, {
      ...baseLogMeta,
      idpClient: resolvedClientId,
      matchedMapping,
    });

    registrationsTotal?.inc(metricsLabels);

    const response: Record<string, unknown> = {
      client_id: resolvedClientId,
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
