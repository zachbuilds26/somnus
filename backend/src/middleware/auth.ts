import type { Request, Response, NextFunction } from 'express';
import { verifyJWT } from '../services/auth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { address: string };
    }
  }
}

/** Guard for visitor-facing endpoints. Reads `Authorization: Bearer <jwt>` from
 *  the wallet-login flow and resolves the connected address. Without a valid
 *  token the request is rejected before it can touch any session or order. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['authorization'];
  if (!header) {
    res.status(401).json({ ok: false, error: 'auth required: connect your wallet and sign in' });
    return;
  }
  const m = header.match(/^Bearer (.+)$/);
  const token = (m ? m[1] : header) ?? '';
  const decoded = verifyJWT(token);
  if (!decoded?.sub) {
    res.status(401).json({ ok: false, error: 'invalid or expired token' });
    return;
  }
  req.user = { address: String(decoded.sub) };
  next();
}
