import { Request } from 'express';

export type Logger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
};

function formatValue(v: unknown): string {
  const s = String(v);
  if (s === '' || /[\s="\\]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function formatLine(level: string, message: string, meta?: Record<string, unknown>): string {
  let line = `ts=${new Date().toISOString()} level=${level} msg=${formatValue(message)}`;
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      if (v === undefined || v === null) continue;
      line += ` ${k}=${formatValue(v)}`;
    }
  }
  return line;
}

export function createLogger(debugEnabled: boolean): Logger {
  return {
    info: (message, meta?) => console.log(formatLine('info', message, meta)),
    warn: (message, meta?) => console.warn(formatLine('warn', message, meta)),
    error: (message, meta?) => console.error(formatLine('error', message, meta)),
    debug: (message, meta?) => {
      if (!debugEnabled) return;
      console.log(formatLine('debug', message, meta));
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
