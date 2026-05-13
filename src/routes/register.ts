import { Router, Request, Response } from 'express';
import { AppConfig } from '../config';
import { Logger, requestMeta } from '../logger';
import { requireJsonContentType } from '../middleware/security';

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
      ...body,
      client_id: config.clientId,
      token_endpoint_auth_method: 'none',
    };

    res.status(201)
      .set('Cache-Control', 'no-store')
      .json(response);
  });

  return router;
}
