// NOVA AI server. Node 18+, zero dependencies. Run: node server.js  ->  http://localhost:3000
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = process.env.PORT || 3000, TTL = 30000;

// Admin-controlled allowlist. Add or remove assets here.
const ASSETS = [
  { id: "bitcoin", sym: "BTC", name: "Bitcoin", bn: "BTCUSDT" },
  { id: "ethereum", sym: "ETH", name: "Ethereum", bn: "ETHUSDT" },
  { id: "solana", sym: "SOL", name: "Solana", bn: "SOLUSDT" },
  { id: "dogecoin", sym: "DOGE", name: "Dogecoin", bn: "DOGEUSDT" },
  { id: "ripple", sym: "XRP", name: "XRP", bn: "XRPUSDT" },
  { id: "binancecoin", sym: "BNB", name: "BNB", bn: "BNBUSDT" },
  { id: "cardano", sym: "ADA", name: "Cardano", bn: "ADAUSDT" },
  { id: "avalanche-2", sym: "AVAX", name: "Avalanche", bn: "AVAXUSDT" },
  { id: "chainlink", sym: "LINK", name: "Chainlink", bn: "LINKUSDT" },
  { id: "litecoin", sym: "LTC", name: "Litecoin", bn: "LTCUSDT" },
  { id: "polkadot", sym: "DOT", name: "Polkadot", bn: "DOTUSDT" },
  { id: "tron", sym: "TRX", name: "TRON", bn: "TRXUSDT" },
];

const get = async (url) => {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "nova-ai/1.0" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(url.split("/")[2] + " HTTP " + r.status);
  return r.json();
};

async function fromCoinGecko() {
  const ids = ASSETS.map(a => a.id).join(",");
  const rows = await get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&sparkline=true&price_change_percentage=24h`);
  return rows.map(c => ({ id: c.id, price: c.current_price, change24h: c.price_change_percentage_24h, volume: c.total_volume, cap: c.market_cap, spark: c.sparkline_in_7d && c.sparkline_in_7d.price }));
}

async function fromBinance() {
  const syms = encodeURIComponent(JSON.stringify(ASSETS.map(a => a.bn)));
  const t = await get(`https://api.binance.com/api/v3/ticker/24hr?symbols=${syms}`);
  const out = [];
  for (const a of ASSETS) {
    const x = t.find(r => r.symbol === a.bn); if (!x) continue;
    let spark = null;
    try { spark = (await get(`https://api.binance.com/api/v3/klines?symbol=${a.bn}&interval=4h&limit=42`)).map(k => +k[4]); } catch (e) {}
    out.push({ id: a.id, price: +x.lastPrice, change24h: +x.priceChangePercent, volume: +x.quoteVolume, cap: null, spark });
  }
  return out;
}

let cache = null, inflight = null;
async function markets() {
  if (cache && Date.now() - cache.t < TTL) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const errors = [];
    for (const [name, fn] of [["coingecko", fromCoinGecko], ["binance", fromBinance]]) {
      try {
        const rows = await fn();
        if (rows.length) { cache = { t: Date.now(), source: name, data: rows.map(r => ({ ...r, ...ASSETS.find(a => a.id === r.id), bn: undefined })) }; return cache; }
      } catch (e) { errors.push(e.message); }
    }
    if (cache) return { ...cache, stale: true, errors };       // serve stale data, flagged
    throw new Error("All market sources failed: " + errors.join("; "));
  })().finally(() => { inflight = null; });
  return inflight;
}

// Very small per-IP rate limit
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
const limited = ip => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 120; };

const HEADERS = {
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.devnet.solana.com; img-src 'self' data:",
};

http.createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => { res.writeHead(code, { ...HEADERS, "Content-Type": type }); res.end(body); };
  if (limited(req.socket.remoteAddress)) return send(429, '{"error":"Too many requests"}');
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/markets" && req.method === "GET") {
    try { const m = await markets(); return send(200, JSON.stringify({ source: m.source, updated: m.t, stale: !!m.stale, data: m.data })); }
    catch (e) { return send(502, JSON.stringify({ error: e.message })); }
  }
  if (url.pathname === "/" || url.pathname === "/index.html") return send(200, fs.readFileSync(path.join(__dirname, "index.html")), "text/html; charset=utf-8");
  send(404, '{"error":"Not found"}');
}).listen(PORT, () => console.log("NOVA AI running on http://localhost:" + PORT));
