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

export function createRegisterRouter(config: AppConfig, logger: Logger): Router {
  const router = Router();

  router.post('/register', requireJsonContentType, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    logger.debug('DCR register request', {
      ...requestMeta(req),
      contentType: req.get('content-type'),
      bodyKeys: Object.keys(body),
    });

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
