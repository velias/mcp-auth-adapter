import { Request, Response } from 'express';

export type Logger = {
  isDebugEnabled: boolean;
  isAccessLogEnabled: boolean;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  accessLog: (message: string, req: Request, res: Response, meta?: Record<string, unknown>) => void;
};

function formatValue(v: unknown): string {
  return `"${String(v).replace(/"/g, "'")}"`;
}

function formatLine(level: string, message: string, meta?: Record<string, unknown>): string {
  let line = `ts="${new Date().toISOString()}" level="${level}" msg=${formatValue(message)}`;
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined || v === null) continue;
      line += ` ${k}=${formatValue(v)}`;
    }
  }
  return line;
}

export function createLogger(debugEnabled: boolean, accessLogEnabled: boolean = true): Logger {
  return {
    isDebugEnabled: debugEnabled,
    isAccessLogEnabled: accessLogEnabled,
    info: (message, meta?) => console.log(formatLine('info', message, meta)),
    warn: (message, meta?) => console.warn(formatLine('warn', message, meta)),
    error: (message, meta?) => console.error(formatLine('error', message, meta)),
    debug: (message, meta?) => {
      if (!debugEnabled) return;
      console.log(formatLine('debug', message, meta));
    },
    accessLog: (message, req, res, meta?) => {
      if (!accessLogEnabled) return;
      const baseMeta = { ...requestMeta(req), ...meta };
      res.on('finish', () => {
        console.log(formatLine('info', message, { ...baseMeta, status: res.statusCode }));
      });
    },
  };
}

export function requestMeta(req: Request): Record<string, unknown> {
  return {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  };
}
