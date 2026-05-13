import { Router, Request, Response } from 'express';
import { AppConfig } from '../config';
import { Logger, requestMeta } from '../logger';

/**
 * Constructs a fallback upstream document from the issuer URL using
 * Keycloak URL conventions. Used when the upstream well-known
 * fetch fails so the adapter can still announce meaningful endpoints.
 */
export function buildDefaultUpstreamDoc(issuerUrl: string): Record<string, unknown> {
  const oidcBase = `${issuerUrl}/protocol/openid-connect`;
  return {
    issuer: issuerUrl,
    authorization_endpoint: `${oidcBase}/auth`,
    token_endpoint: `${oidcBase}/token`,
    jwks_uri: `${oidcBase}/certs`,
    introspection_endpoint: `${oidcBase}/token/introspect`,
    userinfo_endpoint: `${oidcBase}/userinfo`,
    revocation_endpoint: `${oidcBase}/revoke`,
    registration_endpoint: `${issuerUrl}/clients-registrations/openid-connect`,
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'fragment'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
    token_endpoint_auth_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256'],
    subject_types_supported: ['public'],
    claims_supported: ['sub', 'iss', 'aud', 'name', 'email', 'preferred_username'],
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * Strict whitelist of upstream fields to include in our well-known document.
 * Any field not listed here is dropped, even if the upstream IdP adds new ones.
 */
const UPSTREAM_WHITELIST_FIELDS = [
  'issuer',
  'authorization_endpoint',
  'token_endpoint',
  'jwks_uri',
  'registration_endpoint',
  'scopes_supported',
  'response_types_supported',
  'response_modes_supported',
  'grant_types_supported',
  'token_endpoint_auth_methods_supported',
  'token_endpoint_auth_signing_alg_values_supported',
  'code_challenge_methods_supported',
  'id_token_signing_alg_values_supported',
  'subject_types_supported',
  'claims_supported',
  'introspection_endpoint',
  'userinfo_endpoint',
  'revocation_endpoint',
  'authorization_response_iss_parameter_supported',
];

export function buildWellKnownDocument(
  upstreamDoc: Record<string, unknown>,
  config: AppConfig,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};

  for (const field of UPSTREAM_WHITELIST_FIELDS) {
    if (upstreamDoc[field] !== undefined) {
      doc[field] = upstreamDoc[field];
    }
  }

  const hasAuthFlow =
    doc.authorization_endpoint !== undefined &&
    doc.token_endpoint !== undefined;

  if (hasAuthFlow) {
    if (!doc.response_types_supported) {
      doc.response_types_supported = ['code'];
    }
    if (!doc.grant_types_supported) {
      doc.grant_types_supported = ['authorization_code'];
    }
    if (!doc.code_challenge_methods_supported) {
      doc.code_challenge_methods_supported = ['S256'];
    }
  }

  // RFC 8414 §3.3: issuer MUST match the URL clients use for discovery
  doc.issuer = config.baseUrl;

  if (config.proxyDcrEndpoint) {
    doc.registration_endpoint = `${config.baseUrl}/register`;
  }

  if (config.proxyAuthEndpoint) {
    doc.authorization_endpoint = `${config.baseUrl}/authorize`;
    // RFC 9207: upstream would return its own issuer in the authorization
    // response `iss` parameter, which won't match our rewritten issuer.
    delete doc.authorization_response_iss_parameter_supported;
  }

  if (config.cimdEnabled) {
    doc.client_id_metadata_document_supported = true;
    doc.token_endpoint = `${config.baseUrl}/token`;
  }

  // Both DCR and CIMD expose public clients (token_endpoint_auth_method: "none"),
  // so the metadata must advertise that the token endpoint accepts it.
  if (config.proxyDcrEndpoint || config.cimdEnabled) {
    const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
      ? doc.token_endpoint_auth_methods_supported as string[]
      : [];
    if (!methods.includes('none')) {
      doc.token_endpoint_auth_methods_supported = [...methods, 'none'];
    }
  }

  if (config.scopesSupported && config.scopesSupported.length > 0) {
    doc.scopes_supported = config.scopesSupported;
  } else {
    delete doc.scopes_supported;
  }

  return doc;
}

/**
 * Checks the upstream well-known document for fields required by the MCP
 * authorization flow. Returns warning strings for any issues found.
 */
export function validateUpstreamDoc(
  upstreamDoc: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  if (!upstreamDoc.authorization_endpoint) {
    warnings.push('Upstream IdP compatibility: well-known is missing authorization_endpoint; MCP authorization flow will not work');
  }
  if (!upstreamDoc.token_endpoint) {
    warnings.push('Upstream IdP compatibility: well-known is missing token_endpoint; MCP authorization flow will not work');
  }
  if (!upstreamDoc.code_challenge_methods_supported) {
    warnings.push(
      'Upstream IdP compatibility: well-known does not include code_challenge_methods_supported;' +
      ' the adapter will advertise ["S256"] in its discovery document to satisfy the MCP PKCE requirement' +
      ' - if the upstream IdP does not actually support PKCE with S256, authorization will fail at token exchange',
    );
  } else if (
    Array.isArray(upstreamDoc.code_challenge_methods_supported) &&
    !(upstreamDoc.code_challenge_methods_supported as string[]).includes('S256')
  ) {
    warnings.push(
      'Upstream IdP compatibility: well-known advertises code_challenge_methods_supported without S256;' +
      ' MCP requires PKCE with S256 - authorization will likely fail at token exchange',
    );
  }
  return warnings;
}

export function createWellKnownRouter(
  getDocument: () => Record<string, unknown>,
  logger: Logger,
  refreshMinutes = 60,
): Router {
  const router = Router();
  const maxAgeSecs = Math.floor((refreshMinutes * 60) / 2);

  const handler = (req: Request, res: Response) => {
    logger.debug('well-known request', requestMeta(req));
    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', `public, max-age=${maxAgeSecs}`);
    res.json(getDocument());
  };

  router.get('/.well-known/oauth-authorization-server', handler);
  router.get('/.well-known/openid-configuration', handler);

  return router;
}
