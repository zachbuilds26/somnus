import { Router } from 'express';
import { issueChallenge, verifyChallenge } from '../services/auth';

export const authRouter = Router();

// Wallet login (web3 auth). A visitor signs a server-issued nonce; we recover
// their address from the signature and hand back a JWT. That JWT is what later
// scopes trades/state to their own wallet (Phase 2).
authRouter.post('/auth/challenge', (req, res) => {
  const address = req.body?.address;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    res.status(400).json({ ok: false, error: 'valid address required' });
    return;
  }
  const { nonce, message } = issueChallenge(address);
  res.json({ ok: true, nonce, message });
});

authRouter.post('/auth/verify', async (req, res) => {
  const { address, signature } = req.body ?? {};
  if (typeof address !== 'string' || typeof signature !== 'string') {
    res.status(400).json({ ok: false, error: 'address and signature required' });
    return;
  }
  const result = await verifyChallenge(address, signature);
  if (!result.ok) {
    res.status(401).json({ ok: false, error: result.reason });
    return;
  }
  res.json({ ok: true, token: result.token, address });
});
