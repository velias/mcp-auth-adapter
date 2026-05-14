import compression from 'compression';
import express, { Application } from 'express';
import { AppConfig } from './config';
import { createLogger } from './logger';
import { buildWellKnownDocument, createWellKnownRouter } from './routes/well-known';
import { createRegisterRouter } from './routes/register';
import { createAuthorizeRouter, AuthCimdConfig } from './routes/authorize';
import { createHealthRouter } from './routes/health';
import { createTokenRouter } from './routes/token';
import {
  CimdCache,
  fetchCimdDocument,
  resolveUpstreamClientId,
} from './cimd';

/**
 * Holds the current upstream state. Updated atomically by the
 * periodic refresh; routes read from this on every request.
 */
export interface UpstreamState {
  wellKnownDocument: Record<string, unknown>;
  upstreamAuthorizationEndpoint: string;
  upstreamTokenEndpoint: string;
}

export interface CreateAppOptions {
  config: AppConfig;
  upstreamDoc: Record<string, unknown>;
  /** Override CIMD document fetcher (for testing). Defaults to fetchCimdDocument. */
  cimdFetcher?: (url: string) => Promise<import('./cimd').CimdDocument>;
}

export function buildUpstreamState(
  upstreamDoc: Record<string, unknown>,
  config: AppConfig,
): UpstreamState {
  return {
    wellKnownDocument: buildWellKnownDocument(upstreamDoc, config),
    upstreamAuthorizationEndpoint: upstreamDoc.authorization_endpoint as string,
    upstreamTokenEndpoint: upstreamDoc.token_endpoint as string,
  };
}

export function createApp({ config, upstreamDoc, cimdFetcher }: CreateAppOptions): {
  app: Application;
  updateUpstream: (newUpstreamDoc: Record<string, unknown>) => void;
  setShuttingDown: () => void;
  isShuttingDown: () => boolean;
} {
  let state = buildUpstreamState(upstreamDoc, config);
  const logger = createLogger(config.debug);

  let shuttingDown = false;
  const setShuttingDown = () => { shuttingDown = true; };
  const isShuttingDown = () => shuttingDown;

  const updateUpstream = (newUpstreamDoc: Record<string, unknown>) => {
    state = buildUpstreamState(newUpstreamDoc, config);
  };

  const app = express();
  app.disable('x-powered-by');

  app.use(compression());
  app.use(createHealthRouter(isShuttingDown));
  app.use(express.json());

  app.use(createWellKnownRouter(() => state.wellKnownDocument, logger, config.wellKnownRefreshMinutes));

  if (config.proxyDcrEndpoint) {
    app.use(createRegisterRouter(config, logger));
  }

  let cimdConfig: AuthCimdConfig | undefined;

  if (config.cimdEnabled) {
    const pinnedUrls = new Set(Object.keys(config.cimdMap));
    const cimdCache = new CimdCache({
      ttlMinutes: config.cimdCacheMinutes,
      pinnedUrls,
    });

    const fetcher = cimdFetcher ?? fetchCimdDocument;
    cimdConfig = {
      resolve: (cimdUrl: string) => resolveUpstreamClientId(cimdUrl, config.cimdMap, config.cimdDefaultClientId),
      validateAndCache: (cimdUrl: string) => cimdCache.get(cimdUrl, fetcher),
    };

    app.use(createTokenRouter(
      () => state.upstreamTokenEndpoint,
      { map: config.cimdMap, defaultClientId: config.cimdDefaultClientId },
      logger,
    ));
  }

  if (config.proxyAuthEndpoint) {
    if (!state.upstreamAuthorizationEndpoint) {
      throw new Error('Upstream well-known document is missing authorization_endpoint');
    }
    app.use(createAuthorizeRouter(
      () => state.upstreamAuthorizationEndpoint,
      logger,
      { removed: config.authScopesRemoved, preserved: config.authScopesPreserved },
      cimdConfig,
    ));
  }

  return { app, updateUpstream, setShuttingDown, isShuttingDown };
}
