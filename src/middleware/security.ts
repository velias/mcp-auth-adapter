import { Request, Response, NextFunction } from 'express';

/**
 * Enforces Content-Type: application/json on incoming requests.
 *
 * Required by RFC 7591 Section 3 for the DCR endpoint and doubles as
 * CSRF protection: HTML forms cannot send application/json, so
 * browser-based form submissions are blocked. Cross-origin fetch/XHR
 * with this content type triggers a CORS preflight which the app does
 * not answer, causing browsers to block the request.
 */
export function requireJsonContentType(req: Request, res: Response, next: NextFunction): void {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('application/json')) {
    res.status(415).json({
      error: 'invalid_request',
      error_description: 'Content-Type must be application/json',
    });
    return;
  }
  next();
}
