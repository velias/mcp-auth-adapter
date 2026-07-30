import { Logger, truncateClientIdForLog, truncateUriForLog } from './logger';
import {
  CimdDocument,
  isCimdClientId,
  validateCimdUrl,
  validateRedirectUri,
  sanitizeForError,
} from './cimd';
import { matchesRedirectPattern, checkAndMatchResource, ResourceConfig } from './uri-validation';
import { signState } from './state-signer';

export interface AuthScopeConfig {
  removed?: string[];
  preserved?: string[];
  removedSet?: Set<string>;
  preservedSet?: Set<string>;
}

export function filterScopes(
  scopeParam: string,
  scopeConfig: AuthScopeConfig,
): string | null {
  const scopes = scopeParam.split(' ').filter(Boolean);
  let filtered: string[];
  const preservedSet = scopeConfig.preservedSet
    ?? (scopeConfig.preserved?.length ? new Set(scopeConfig.preserved) : undefined);
  const removedSet = scopeConfig.removedSet
    ?? (scopeConfig.removed?.length ? new Set(scopeConfig.removed) : undefined);
  if (preservedSet) {
    filtered = scopes.filter(s => preservedSet.has(s));
  } else if (removedSet) {
    filtered = scopes.filter(s => !removedSet.has(s));
  } else {
    return scopeParam;
  }
  return filtered.length > 0 ? filtered.join(' ') : null;
}

/**
 * Shared authorize-time transforms used by GET /authorize and POST /par:
 * resource check, response_mode strip, CIMD, redirect_uri allowlist + HMAC
 * state wrap, scope filtering.
 */
export interface AuthRequestTransformConfig extends AuthScopeConfig, ResourceConfig {
  cimdResolve?: (cimdUrl: string) => string | null;
  cimdValidateAndCache?: (cimdUrl: string) => Promise<CimdDocument>;
  stateBaseUrl?: string;
  stateSecret?: Buffer;
  stateTtlSeconds?: number;
  stateAllowedRedirectUris?: string[];
  dcrClientIdRedirectMap?: Map<string, string[]>;
  knownIdpClients?: Set<string>;
}

export interface AuthRequestReject {
  ok: false;
  status: number;
  body: { error: string; error_description: string };
  reason: string;
  resourceLabel: Record<string, string>;
  idpClientLabel: Record<string, string>;
}

export interface AuthRequestSuccess {
  ok: true;
  params: URLSearchParams;
  isCimd: boolean;
  resourceLabel: Record<string, string>;
  idpClientLabel: Record<string, string>;
}

export type AuthRequestTransformResult = AuthRequestReject | AuthRequestSuccess;

function reject(
  status: number,
  error: string,
  error_description: string,
  reason: string,
  resourceLabel: Record<string, string>,
  idpClientLabel: Record<string, string> = {},
): AuthRequestReject {
  return {
    ok: false,
    status,
    body: { error, error_description },
    reason,
    resourceLabel,
    idpClientLabel,
  };
}

/**
 * Applies the shared authorization-request transform pipeline in place on `params`.
 * `logPrefix` is used in warn/debug messages (e.g. "authorize", "par").
 */
export async function applyAuthorizationRequestTransforms(
  params: URLSearchParams,
  config: AuthRequestTransformConfig,
  scopeConfig: AuthScopeConfig,
  logger: Logger,
  logPrefix: string,
): Promise<AuthRequestTransformResult> {
  const resource = params.get('resource') || '';
  const { error: resourceError, matchedPattern } = checkAndMatchResource(resource, config);
  const resourceLabel: Record<string, string> = matchedPattern
    ? { resource: matchedPattern }
    : {};

  if (resourceError) {
    logger.warn(`${logPrefix}: resource parameter rejected`, {
      reason: resourceError.reason,
      resource: truncateUriForLog(resource),
      clientId: params.get('client_id') ?? '',
    });
    return reject(400, 'invalid_request', resourceError.description, resourceError.reason, resourceLabel);
  }

  const responseMode = params.get('response_mode');
  if (responseMode && responseMode !== 'query') {
    if (logger.isDebugEnabled) {
      logger.debug(`${logPrefix}: unsupported response_mode stripped`, { responseMode });
    }
    params.delete('response_mode');
  }

  const clientId = params.get('client_id') ?? '';
  let isCimd = false;

  if (config.cimdResolve && clientId && isCimdClientId(clientId)) {
    isCimd = true;
    const urlValidation = validateCimdUrl(clientId);
    if (!urlValidation.valid) {
      logger.warn(`${logPrefix}: invalid CIMD client_id URL`, {
        clientId: truncateClientIdForLog(clientId),
        reason: urlValidation.reason,
      });
      return reject(
        400,
        'invalid_client',
        `Invalid CIMD client_id URL: ${sanitizeForError(urlValidation.reason)}`,
        'cimd_url_invalid',
        resourceLabel,
      );
    }

    const upstreamClientId = config.cimdResolve(clientId);
    if (!upstreamClientId) {
      logger.warn(`${logPrefix}: unknown CIMD client rejected`, { clientId: truncateClientIdForLog(clientId) });
      return reject(
        403,
        'invalid_client',
        `Unknown CIMD client: ${sanitizeForError(clientId)}`,
        'cimd_client_unknown',
        resourceLabel,
      );
    }

    let cimdDoc: CimdDocument;
    try {
      cimdDoc = await config.cimdValidateAndCache!(clientId);
    } catch (err) {
      logger.error(`${logPrefix}: CIMD metadata fetch/validation failed`, {
        clientId: truncateClientIdForLog(clientId),
        error: String(err),
      });
      return reject(
        400,
        'invalid_client',
        'Failed to fetch or validate CIMD metadata document',
        'cimd_metadata_failed',
        resourceLabel,
      );
    }

    const redirectUri = params.get('redirect_uri');
    if (redirectUri && !validateRedirectUri(redirectUri, cimdDoc)) {
      logger.warn(`${logPrefix}: CIMD redirect_uri mismatch`, {
        clientId: truncateClientIdForLog(clientId),
        uri: truncateUriForLog(redirectUri),
      });
      return reject(
        400,
        'invalid_request',
        'redirect_uri does not match any registered URI in the CIMD metadata document',
        'cimd_redirect_uri_mismatch',
        resourceLabel,
      );
    }

    params.set('client_id', upstreamClientId);
  }

  const effectiveClientId = params.get('client_id') ?? '';
  const idpClientLabel: Record<string, string> = config.knownIdpClients?.has(effectiveClientId)
    ? { idp_client: effectiveClientId }
    : {};

  if (config.stateSecret) {
    const redirectUri = params.get('redirect_uri');
    if (!redirectUri) {
      logger.warn(`${logPrefix}: redirect_uri missing`, { clientId: effectiveClientId });
      return reject(
        400,
        'invalid_request',
        'redirect_uri is required',
        'redirect_uri_missing',
        resourceLabel,
        idpClientLabel,
      );
    }

    if (!isCimd) {
      const perClientPatterns = config.dcrClientIdRedirectMap?.get(effectiveClientId);
      if (perClientPatterns) {
        const match = matchesRedirectPattern(redirectUri, perClientPatterns);
        if (!match.allowed) {
          logger.warn(`${logPrefix}: redirect_uri rejected (per-client)`, {
            reason: match.reason,
            uri: truncateUriForLog(redirectUri),
            clientId: effectiveClientId,
          });
          return reject(
            400,
            'invalid_request',
            'redirect_uri not allowed',
            'redirect_uri_rejected',
            resourceLabel,
            idpClientLabel,
          );
        }
        if (logger.isDebugEnabled) {
          logger.debug(`${logPrefix}: redirect_uri allowed (per-client)`, {
            clientId: effectiveClientId,
            uri: truncateUriForLog(redirectUri),
          });
        }
      } else {
        const match = matchesRedirectPattern(redirectUri, config.stateAllowedRedirectUris!);
        if (!match.allowed) {
          logger.warn(`${logPrefix}: redirect_uri rejected`, {
            reason: match.reason,
            uri: truncateUriForLog(redirectUri),
            clientId: effectiveClientId,
          });
          return reject(
            400,
            'invalid_request',
            'redirect_uri not allowed',
            'redirect_uri_rejected',
            resourceLabel,
            idpClientLabel,
          );
        }
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
    const filtered = filterScopes(scope, scopeConfig);
    if (filtered !== null) {
      params.set('scope', filtered);
    } else {
      params.delete('scope');
    }
  }

  return { ok: true, params, isCimd, resourceLabel, idpClientLabel };
}

/**
 * CIMD client_id rewrite only — used by /authorize when a PAR request_uri is present
 * (redirect_uri/state/scopes were already applied at PAR time).
 */
export async function applyCimdClientIdSubstitution(
  params: URLSearchParams,
  config: Pick<AuthRequestTransformConfig, 'cimdResolve' | 'cimdValidateAndCache' | 'knownIdpClients'>,
  logger: Logger,
  logPrefix: string,
): Promise<AuthRequestTransformResult> {
  const clientId = params.get('client_id') ?? '';
  if (!config.cimdResolve || !clientId || !isCimdClientId(clientId)) {
    const idpClientLabel: Record<string, string> = config.knownIdpClients?.has(clientId)
      ? { idp_client: clientId }
      : {};
    return {
      ok: true,
      params,
      isCimd: false,
      resourceLabel: {},
      idpClientLabel,
    };
  }

  const urlValidation = validateCimdUrl(clientId);
  if (!urlValidation.valid) {
    logger.warn(`${logPrefix}: invalid CIMD client_id URL`, {
      clientId: truncateClientIdForLog(clientId),
      reason: urlValidation.reason,
    });
    return reject(
      400,
      'invalid_client',
      `Invalid CIMD client_id URL: ${sanitizeForError(urlValidation.reason)}`,
      'cimd_url_invalid',
      {},
    );
  }

  const upstreamClientId = config.cimdResolve(clientId);
  if (!upstreamClientId) {
    logger.warn(`${logPrefix}: unknown CIMD client rejected`, { clientId: truncateClientIdForLog(clientId) });
    return reject(
      403,
      'invalid_client',
      `Unknown CIMD client: ${sanitizeForError(clientId)}`,
      'cimd_client_unknown',
      {},
    );
  }

  try {
    await config.cimdValidateAndCache!(clientId);
  } catch (err) {
    logger.error(`${logPrefix}: CIMD metadata fetch/validation failed`, {
      clientId: truncateClientIdForLog(clientId),
      error: String(err),
    });
    return reject(
      400,
      'invalid_client',
      'Failed to fetch or validate CIMD metadata document',
      'cimd_metadata_failed',
      {},
    );
  }

  params.set('client_id', upstreamClientId);
  const idpClientLabel: Record<string, string> = config.knownIdpClients?.has(upstreamClientId)
    ? { idp_client: upstreamClientId }
    : {};
  return {
    ok: true,
    params,
    isCimd: true,
    resourceLabel: {},
    idpClientLabel,
  };
}
