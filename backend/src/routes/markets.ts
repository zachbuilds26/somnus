import { Router } from 'express';
import { fetchSpotMarkets } from '../services/markets';
import { eventBook, listEventMarkets } from '../services/sdk';

export const marketsRouter: Router = Router();

marketsRouter.get('/markets', async (_req, res) => {
  try {
    const markets = await fetchSpotMarkets();
    res.json({ ok: true, markets });
  } catch (err) {
    res.status(503).json({ ok: false, error: message(err) });
  }
});

marketsRouter.get('/markets/binary', async (_req, res) => {
  try {
    const markets = await listEventMarkets();
    res.json({ ok: true, markets, note: 'live Event Contract windows via SDK' });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: message(err),
      hint: 'Event Contract reads need no key — this is an indexer/network problem. Check INDEXER_URL and connectivity; spot markets remain on GET /api/markets',
    });
  }
});

marketsRouter.get('/markets/:symbol/book', async (req, res) => {
  try {
    const book = await eventBook(req.params.symbol, 5);
    res.json({ ok: true, book });
  } catch (err) {
    res.status(503).json({ ok: false, error: message(err) });
  }
});

function message(err: unknown): string {
  return (err as Error).message ?? String(err);
}