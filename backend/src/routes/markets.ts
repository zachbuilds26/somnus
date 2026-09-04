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

/** Top of book by query string.
 *
 *  Event Contract symbols contain `/` and `#` (`BTC-8087700-03SEP26-1538/tUSDC#YES`),
 *  so the path form below only works percent-encoded — `%2F` and `%23`. Unencoded,
 *  the `/` splits the path and the request 404s, which is exactly what the documented
 *  example did. A query parameter carries the raw symbol without that trap, so this
 *  is the form to reach for; the path form stays for compatibility.
 *
 *  Registered BEFORE `/markets/:symbol/book` — different segment counts, so they
 *  cannot collide, but ordering makes the intent obvious to the next reader.   */
marketsRouter.get('/markets/book', async (req, res) => {
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : '';
  if (!symbol) {
    res.status(400).json({
      ok: false,
      error:
        'pass ?symbol=<YES symbol> — e.g. /api/markets/book?symbol=BTC-8087700-03SEP26-1538/tUSDC%23YES. ' +
        'Get live symbols from GET /api/markets/events.',
    });
    return;
  }
  try {
    const book = await eventBook(symbol, 5);
    res.json({ ok: true, book });
  } catch (err) {
    res.status(503).json({ ok: false, error: message(err) });
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