import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reporter, type ToolExtra } from '../src/mcp/shared';

/** Progress belongs to the SERVER, not to one client's settings.
 *
 *  `somnus_my_quote` reads an order book per window and takes tens of seconds. All of
 *  that was silence: a caller's agent showed a spinner and then, abruptly, an answer.
 *  The tempting fix was a verbosity flag in one editor's config — which would have
 *  helped exactly one person on one machine. `notifications/progress` is part of MCP,
 *  so emitting it here means every client that renders progress gets it, from any
 *  editor or agent, with nothing to configure.
 *
 *  Two properties make it safe to call from inside business logic, and both are the
 *  point of this file. It must be a NO-OP when the client did not ask for progress —
 *  the spec forbids sending it unrequested, and a tool must behave identically
 *  without a token. And it must never be able to fail a tool: a dropped progress line
 *  is cosmetic, a trade turned into an error because a client hung up is not. */

/** Records what would have gone over the wire. */
function spy(): { extra: ToolExtra; sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    extra: {
      _meta: { progressToken: 'tok-1' },
      sendNotification: async (n) => {
        sent.push(n);
      },
    },
  };
}

describe('mcp progress: silent unless the client asked', () => {
  it('does nothing when there is no progressToken', async () => {
    const sent: unknown[] = [];
    const report = reporter({
      sendNotification: async (n) => {
        sent.push(n);
      },
    });
    report('pricing 1 of 8');
    await Promise.resolve();
    // Not "sent an empty message" — sent nothing at all. A server that volunteers
    // progress the client never requested is out of spec.
    assert.equal(sent.length, 0);
  });

  it('does nothing when the transport offers no way to notify', () => {
    const report = reporter({ _meta: { progressToken: 'tok-1' } });
    assert.doesNotThrow(() => report('pricing 1 of 8'));
  });

  it('does nothing, and does not throw, with no extra at all', () => {
    // The stdio path and any test calling a service directly land here.
    assert.doesNotThrow(() => reporter(undefined)('anything'));
  });

  it('treats a zero progressToken as present, not as missing', () => {
    // `0` is a legal token and falsy. A truthiness check here would silently drop
    // progress for any client that numbers its tokens from zero.
    const sent: unknown[] = [];
    const report = reporter({
      _meta: { progressToken: 0 },
      sendNotification: async (n) => {
        sent.push(n);
      },
    });
    report('working');
    assert.equal(sent.length, 1);
  });
});

describe('mcp progress: what goes on the wire', () => {
  it('echoes the caller\'s token and the message', () => {
    const { extra, sent } = spy();
    reporter(extra)('pricing 5m BTC (1 of 8)', 0, 8);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-1',
        progress: 0,
        total: 8,
        message: 'pricing 5m BTC (1 of 8)',
      },
    });
  });

  it('counts by itself when the caller gives no number', () => {
    // Some clients render the counter and ignore the message, so a prose-only call
    // still has to advance something.
    const { extra, sent } = spy();
    const report = reporter(extra);
    report('first');
    report('second');
    report('third');
    const progress = sent.map((n) => (n as { params: { progress: number } }).params.progress);
    assert.deepEqual(progress, [1, 2, 3]);
  });

  it('omits total rather than sending an undefined one', () => {
    const { extra, sent } = spy();
    reporter(extra)('no denominator yet');
    assert.equal('total' in (sent[0] as { params: Record<string, unknown> }).params, false);
  });

  it('keeps an explicit zero instead of falling back to the counter', () => {
    // `progress ?? seq` — with `||` the first tick of a 0-of-N loop would report 1.
    const { extra, sent } = spy();
    reporter(extra)('starting', 0, 8);
    assert.equal((sent[0] as { params: { progress: number } }).params.progress, 0);
  });
});

describe('mcp progress: cannot break the tool it narrates', () => {
  it('swallows a rejected notification', async () => {
    const report = reporter({
      _meta: { progressToken: 'tok-1' },
      sendNotification: async () => {
        throw new Error('client hung up');
      },
    });
    assert.doesNotThrow(() => report('submitting the order'));
    // The rejection is handled on a later tick; if it were unhandled, node would
    // surface it here rather than let the test settle cleanly.
    await new Promise((r) => setTimeout(r, 10));
  });

  it('does not make the caller wait on the client', () => {
    // Fire-and-forget: `report` returns void, so no tool body can accidentally await
    // a slow or dead client between reading a book and placing an order.
    const report = reporter({
      _meta: { progressToken: 'tok-1' },
      sendNotification: () => new Promise<void>(() => undefined), // never settles
    });
    const before = Date.now();
    report('submitting');
    assert.ok(Date.now() - before < 50);
    assert.equal(report('again'), undefined);
  });

  it('keeps reporting after one send fails', async () => {
    // A single dropped frame must not silently end progress for the rest of the call.
    const sent: unknown[] = [];
    let first = true;
    const report = reporter({
      _meta: { progressToken: 'tok-1' },
      sendNotification: async (n) => {
        if (first) {
          first = false;
          throw new Error('transient');
        }
        sent.push(n);
      },
    });
    report('one');
    report('two');
    report('three');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.length, 2);
  });
});
