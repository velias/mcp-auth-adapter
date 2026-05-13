import { Router, Request, Response } from 'express';

export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health/live', (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  router.get('/health/ready', (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  return router;
}
