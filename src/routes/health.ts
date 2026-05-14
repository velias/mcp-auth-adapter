import { Router, Request, Response } from 'express';

export function createHealthRouter(
  isShuttingDown: () => boolean = () => false,
): Router {
  const router = Router();

  router.get('/health/live', (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  router.get('/health/ready', (_req: Request, res: Response) => {
    res.sendStatus(isShuttingDown() ? 503 : 200);
  });

  return router;
}
