import http from "node:http";

const POLL_MS = 60_000;
const PORT = 4545;
let seen = new Set<string>();

function get(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, { timeout: 15_000 }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error("parse")); }
      });
    }).on("error", reject);
  });
}

async function poll(): Promise<boolean> {
  const loop = await get("/api/agent/loop");
  const s = loop.loop;
  const logs = await get("/api/agent/logs?limit=150");
  const fills: string[] = [];

  for (const e of logs.entries) {
    if (e.kind === "order" && e.payload.status === "submitted" && !seen.has(e.payload.txHash)) {
      seen.add(e.payload.txHash);
      const t = new Date(e.payload.ts).toISOString().slice(11, 19);
      const line = `${t} FILL: ${e.payload.symbol} @ ${e.payload.price} x${e.payload.size} tx=${e.payload.txHash}`;
      fills.push(line);
      console.log(`\x1b[32m${line}\x1b[0m`);
    }
  }

  const fails = logs.entries.filter((e: any) => e.kind === "order" && e.payload.status === "rejected");
  console.log(`cycle=${s.cycles} left=${s.tradesRemaining} writes_ok=${fails.filter((f: any) => f.payload.reason?.includes("fetch failed")).length === 0 ? "?" : "no"} fails=${fails.length}`);

  if (s.tradesRemaining <= 0) {
    const cl = await get("/api/agent/claimable");
    if (cl.claimable?.length > 0) {
      console.log(`\x1b[36m${cl.claimable.length} claimable winner(s) — run: npx tsx scripts/settle-claims.ts\x1b[0m`);
    }
    return true;
  }
  return false;
}

(async () => {
  console.log(`Watcher started. Polling every ${POLL_MS / 1000}s...`);
  while (true) {
    try { if (await poll()) break; } catch { console.log("poll error (venue down?)"); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
