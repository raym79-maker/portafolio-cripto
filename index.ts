
const KEY = Bun.env.COINGECKO_API_KEY || "";
const CG = "https://api.coingecko.com/api/v3";
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", accept: "application/json,text/csv,*/*" };

async function cg(path: string) {
  const headers: Record<string, string> = { accept: "application/json" };
  if (KEY) headers["x-cg-demo-api-key"] = KEY;
  const res = await fetch(CG + path, { headers });
  if (!res.ok) throw Object.assign(new Error("CoinGecko " + res.status), { status: res.status });
  return res.json();
}

let papCache: { at: number; rows: any[] } | null = null;
async function paprikaRows(): Promise<any[]> {
  if (papCache && Date.now() - papCache.at < 5 * 60_000) return papCache.rows;
  const res = await fetch("https://api.coinpaprika.com/v1/tickers?quotes=USD");
  if (!res.ok) throw Object.assign(new Error("CoinPaprika " + res.status), { status: res.status });
  const list: any[] = await res.json();
  const rows = list.filter((t) => t && t.quotes && t.quotes.USD && t.rank > 0).map((t) => ({ symbol: String(t.symbol).toUpperCase(), current_price: t.quotes.USD.price }));
  papCache = { at: Date.now(), rows };
  return rows;
}

async function yahooPrice(sym: string): Promise<number | null> {
  const u = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?range=5d&interval=1d";
  const res = await fetch(u, { headers: UA });
  if (!res.ok) throw new Error("yahoo " + res.status);
  const j: any = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("yahoo sin datos");
  const meta = r.meta || {};
  if (isFinite(Number(meta.regularMarketPrice))) return Number(meta.regularMarketPrice);
  const q = r.indicators && r.indicators.quote && r.indicators.quote[0];
  const cl = (q && q.close) || [];
  for (let i = cl.length - 1; i >= 0; i--) if (cl[i] != null && isFinite(cl[i])) return Number(cl[i]);
  return null;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
const PORT_DIR = Bun.env.PORTAFOLIO_DIR || "/data";
const PORT_FILE = PORT_DIR + "/portafolio.json";
const PORT_PIN = (Bun.env.PORTAFOLIO_PIN || "").trim();
const PORT_TOKEN = (() => { const h = new Bun.CryptoHasher("sha256"); h.update("tablero-portafolio:" + PORT_PIN); return h.digest("hex").slice(0, 32); })();

const PORT_IDS: Record<string, string> = {
  BTC:"bitcoin",ETH:"ethereum",SOL:"solana",SOLANA:"solana",ADA:"cardano",HYPE:"hyperliquid",ZEC:"zcash",TAO:"bittensor",
  NEAR:"near",ONDO:"ondo-finance",KAS:"kaspa",LINK:"chainlink",AAVE:"aave",MORPHO:"morpho",FIL:"filecoin",XLM:"stellar",
  ETC:"ethereum-classic",WLD:"worldcoin-wld",PEPE:"pepe",WIF:"dogwifcoin",FARTCOIN:"fartcoin",SUI:"sui",ENA:"ethena",
  AVAX:"avalanche-2",DOGE:"dogecoin",XRP:"ripple",LTC:"litecoin",ARB:"arbitrum",OP:"optimism",INJ:"injective-protocol",
  RENDER:"render-token",TIA:"celestia",SEI:"sei-network",JUP:"jupiter-exchange-solana",PYTH:"pyth-network",BONK:"bonk",
  POPCAT:"popcat",VIRTUAL:"virtual-protocol",GRASS:"grass",EIGEN:"eigenlayer",ETHFI:"ether-fi",DOT:"polkadot",
  ATOM:"cosmos",UNI:"uniswap",APT:"aptos",FET:"fetch-ai",RUNE:"thorchain",CRV:"curve-dao-token",LDO:"lido-dao",
  HBAR:"hedera-hashgraph",ICP:"internet-computer",VET:"vechain",ALGO:"algorand",XMR:"monero",TON:"the-open-network",
  TRX:"tron",BCH:"bitcoin-cash",SHIB:"shiba-inu",MNT:"mantle",STX:"blockstack",IMX:"immutable-x",GALA:"gala",
  SAND:"the-sandbox",MANA:"decentraland",AXS:"axie-infinity",CHZ:"chiliz",FLOKI:"floki",BERA:"berachain-bera",
};

const PORT_SEED: any[] = []; // historico ya migrado al volumen; respaldo en el proyecto

const MOV_SEED: any[] = [
  { id: "m1", fecha: "2026-09-03", tipo: "deposito", monto: 700, a: "Spot", nota: "Capital inicial" },
  { id: "m2", fecha: "2026-09-22", tipo: "retiro", monto: 130, de: "Spot", nota: "Al banco" },
  { id: "m3", fecha: "2026-09-22", tipo: "deposito", monto: 30, a: "Spot", nota: "Revisar fecha" },
  { id: "m4", fecha: "2026-09-22", tipo: "transferencia", monto: 70, de: "Spot", a: "Futuros", nota: "Sin posicion; revisar fecha" },
  { id: "m5", fecha: "2026-09-03", tipo: "deposito", monto: 168.63, a: "Spot", nota: "Por identificar - confirmar monto y fecha" },
];
const DEP_FALTANTE = MOV_SEED[4];
const STORE_V = 4;

type Store = { pos: any[]; mov: any[]; snap?: any[]; v?: number };
let portMem: Store | null = null;

async function portLoad(): Promise<Store> {
  if (portMem) return portMem;
  try {
    const f = Bun.file(PORT_FILE);
    if (await f.exists()) {
      const j: any = await f.json();
      if (Array.isArray(j)) { portMem = { pos: j, mov: MOV_SEED.slice(), snap: [], v: STORE_V }; await portSave(portMem).catch(() => {}); return portMem; }
      if (j && Array.isArray(j.pos)) {
        let mov = Array.isArray(j.mov) ? j.mov : [];
        const ver = Number(j.v) || 0;
        const semillaVieja = mov.length === 2 && mov[0] && mov[0].id === "m1" && mov[1] && mov[1].id === "m2" && mov[1].tipo === "retiro" && Number(mov[1].monto) === 100;
        if (ver < 2 && semillaVieja) mov = MOV_SEED.slice();
        if (ver < 3 && !mov.some((m: any) => m && m.id === "m5")) mov = mov.concat([DEP_FALTANTE]);
        portMem = { pos: j.pos, mov, snap: Array.isArray(j.snap) ? j.snap : [], v: STORE_V };
        if (ver < STORE_V) await portSave(portMem).catch(() => {});
        return portMem;
      }
    }
  } catch (e: any) { console.error("portafolio leer", e.message); }
  portMem = { pos: PORT_SEED.slice(), mov: MOV_SEED.slice(), snap: [], v: STORE_V };
  await portSave(portMem).catch(() => {});
  return portMem;
}

function portValor(st: Store, px: Record<string, number>) {
  let invAb = 0, valAb = 0, pnlCe = 0;
  for (const r of st.pos) {
    if (r.estado === "cerrada") { pnlCe += r.cantidad * r.cierre - r.inversion; continue; }
    invAb += r.inversion;
    const p = px[r.s];
    valAb += (p != null && isFinite(p)) ? r.cantidad * p : r.inversion;
  }
  let caja = 0, dep = 0, ret = 0;
  for (const m of st.mov) {
    if (m.tipo === "retiro") { ret += m.monto; caja -= m.monto; }
    else if (m.tipo === "transferencia") { /* no cambia el total */ }
    else { dep += m.monto; caja += m.monto; }
  }
  caja += pnlCe - invAb;
  return { cuenta: caja + valAb, neto: dep - ret, invAb, valAb, efectivo: caja };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

async function portSnap(st: Store, px: Record<string, number>): Promise<any[]> {
  const snap: any[] = Array.isArray(st.snap) ? st.snap : (st.snap = []);
  if (!Object.keys(px).length) return snap;
  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
  const v = portValor(st, px);
  const fila = { d: hoy, v: r2(v.cuenta), n: r2(v.neto) };
  const i = snap.findIndex((x) => x && x.d === hoy);
  if (i >= 0) {
    if (Math.abs(snap[i].v - fila.v) < 0.5 && snap[i].n === fila.n) return snap;
    snap[i] = fila;
  } else {
    snap.push(fila);
    while (snap.length > 400) snap.shift();
  }
  await portSave(st).catch(() => {});
  return snap;
}

async function portSave(st: Store) {
  portMem = st;
  try { await Bun.write(PORT_FILE, JSON.stringify(st)); }
  catch (e: any) { console.error("portafolio guardar", e.message); throw e; }
}

function portCleanMov(rows: any[]): any[] {
  const num = (x: any) => { const n = Number(x); return isFinite(n) ? n : 0; };
  const cart = (x: any, def: string) => (String(x || "").trim().slice(0, 24) || def);
  return rows.slice(0, 500).map((r: any, i: number) => {
    const tipo = r.tipo === "retiro" ? "retiro" : r.tipo === "transferencia" ? "transferencia" : "deposito";
    const o: any = {
      id: String(r.id || ("m" + Date.now() + i)).slice(0, 40),
      tipo,
      fecha: String(r.fecha || "").slice(0, 10),
      monto: Math.abs(num(r.monto)),
      nota: String(r.nota || "").slice(0, 120),
    };
    if (tipo !== "deposito") o.de = cart(r.de, "Spot");
    if (tipo !== "retiro") o.a = cart(r.a, "Spot");
    if (tipo === "transferencia" && o.de === o.a) o.a = o.de === "Spot" ? "Futuros" : "Spot";
    return o;
  }).filter((r: any) => r.monto > 0);
}

function portClean(rows: any[]): any[] {
  const num = (x: any) => { const n = Number(x); return isFinite(n) ? n : 0; };
  return rows.slice(0, 500).map((r: any, i: number) => {
    const cerrada = r.estado === "cerrada";
    const o: any = {
      id: String(r.id || ("p" + Date.now() + i)).slice(0, 40),
      tipo: r.tipo === "accion" ? "accion" : "cripto",
      s: String(r.s || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12),
      fecha: String(r.fecha || "").slice(0, 10),
      inversion: num(r.inversion), cantidad: num(r.cantidad), compra: num(r.compra),
      estado: cerrada ? "cerrada" : "abierta",
      nota: String(r.nota || "").slice(0, 120),
    };
    if (cerrada) { o.cierre = num(r.cierre); o.fechaCierre = String(r.fechaCierre || o.fecha).slice(0, 10); }
    return o;
  }).filter((r: any) => r.s && r.cantidad > 0);
}

let portPxCache: { at: number; px: Record<string, number> } | null = null;
const pxOneCache = new Map<string, { at: number; p: number }>();

async function precioDe(s: string, tipo: string): Promise<number | null> {
  const key = tipo + ":" + s;
  const hit = pxOneCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  let p: number | null = null;
  if (tipo === "accion") p = await yahooPrice(s);
  else {
    const id = PORT_IDS[s];
    if (!id) return null;
    const j: any = await cg("/simple/price?ids=" + id + "&vs_currencies=usd");
    p = j[id] && isFinite(j[id].usd) ? j[id].usd : null;
  }
  if (p && p > 0) { pxOneCache.set(key, { at: Date.now(), p }); return p; }
  return null;
}

const velasCache = new Map<string, { at: number; d: any }>();

async function klines(sym: string, interval: string, limit: number) {
  const urls = [
    "https://data-api.binance.vision/api/v3/klines?symbol=" + sym + "&interval=" + interval + "&limit=" + limit,
    "https://api.mexc.com/api/v3/klines?symbol=" + sym + "&interval=" + (interval === "1h" ? "60m" : interval) + "&limit=" + limit,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const j: any = await r.json();
      if (Array.isArray(j) && j.length > 10) {
        const out = j.map((k: any) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[7]) || Number(k[5]) * Number(k[4]) || 0 }))
                     .filter((x: any) => isFinite(x.c) && x.c > 0);
        if (out.length > 10) return { velas: out, src: u.indexOf("binance") > -1 ? "Binance" : "MEXC" };
      }
    } catch {}
  }
  return null;
}

async function velasYahoo(sym: string, tf: string) {
  const range = tf === "4h" ? "1mo" : "6mo", interval = tf === "4h" ? "60m" : "1d";
  const u = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?range=" + range + "&interval=" + interval;
  const res = await fetch(u, { headers: UA });
  if (!res.ok) return null;
  const j: any = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return null;
  const q = r.indicators.quote[0];
  const out: any[] = [];
  r.timestamp.forEach((ts: number, i: number) => {
    const c = q.close[i];
    if (c == null || !isFinite(c)) return;
    const o = q.open && q.open[i] != null ? q.open[i] : c;
    out.push({ t: ts * 1000, o, h: q.high && q.high[i] != null ? q.high[i] : Math.max(o, c), l: q.low && q.low[i] != null ? q.low[i] : Math.min(o, c), c, v: (q.volume && q.volume[i] ? q.volume[i] * c : 0) });
  });
  return out.length > 10 ? { velas: out, src: "Yahoo Finance" } : null;
}

async function velasDe(s: string, tipo: string, tf: string) {
  const key = tipo + ":" + s + ":" + tf;
  const hit = velasCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.d;
  let d: any = null;
  if (tipo === "accion") d = await velasYahoo(s, tf);
  else {
    d = await klines(s + "USDT", tf === "4h" ? "4h" : "1d", tf === "4h" ? 240 : 200);
    if (!d) d = await velasYahoo(s + "-USD", tf);
  }
  if (d) velasCache.set(key, { at: Date.now(), d });
  return d;
}

const sigCache = new Map<string, { at: number; d: any }>();

function emaS(v: number[], n: number) {
  const k = 2 / (n + 1), out: (number | null)[] = [];
  let prev: number | null = null;
  for (let i = 0; i < v.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    if (prev === null) { let sum = 0; for (let j = 0; j < n; j++) sum += v[j]; prev = sum / n; }
    else prev = v[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsiS(v: number[], n = 14) {
  const out: (number | null)[] = v.map(() => null);
  if (v.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i-1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i-1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function senalDe(velas: any[]) {
  if (!velas || velas.length < 60) return null;
  const c = velas.map((x) => x.c), n = c.length, p = c[n-1];
  const e20 = emaS(c, 20)[n-1], e50 = emaS(c, 50)[n-1], r = rsiS(c, 14)[n-1];
  if (e20 == null || e50 == null) return null;
  const vols = velas.map((x) => x.v || 0);
  const vs = vols.slice(-7).reduce((a, b) => a + b, 0) / 7;
  const vl = vols.slice(-37, -7).reduce((a, b) => a + b, 0) / 30;
  const volTrend = vl ? vs / vl : null;
  let maxN = 0;
  for (const x of velas.slice(-90)) if (x.h > maxN) maxN = x.h;
  if (p > maxN) maxN = p;
  const desdeMax = maxN ? p / maxN - 1 : null;
  const dist = p / e20 - 1;
  const checks: Record<string, boolean> = {
    tendencia: p > e20 && e20 > e50,
    rsi: r != null && r >= 50 && r <= 65,
    cerca: dist >= -0.02 && dist <= 0.05,
    volumen: volTrend != null && volTrend >= 1.2,
    espacio: desdeMax != null && desdeMax <= -0.10 && desdeMax >= -0.40,
  };
  const pts = Object.keys(checks).filter((k) => checks[k]).length;
  let level = 1, label = "Neutral";
  if (p < e50) { level = 0; label = "Debil"; }
  else if ((r ?? 0) >= 70 || dist >= 0.10) { level = 2; label = "Esperar retroceso"; }
  else if (pts >= 4) { level = 3; label = "Zona de compra"; }
  return { level, label, pts, checks, dist, rsi: r, volTrend, desdeMax, e20, e50, precio: p };
}

async function senales(pos: any[]) {
  const vistos: Record<string, string> = {};
  for (const p of pos) if (!vistos[p.s]) vistos[p.s] = p.tipo;
  const out: Record<string, any> = {};
  await Promise.all(Object.keys(vistos).map(async (s) => {
    const tipo = vistos[s], key = s + ":" + tipo;
    const hit = sigCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) { if (hit.d) out[s] = hit.d; return; }
    try {
      const d = await velasDe(s, tipo, "1d");
      const sg = d ? senalDe(d.velas) : null;
      sigCache.set(key, { at: Date.now(), d: sg });
      if (sg) out[s] = sg;
    } catch (e: any) { console.error("senal", s, e.message); }
  }));
  return out;
}

let btcCache: { at: number; d: any } | null = null;
async function btcRef() {
  if (btcCache && Date.now() - btcCache.at < 60_000) return btcCache.d;
  const v = await velasDe("BTC", "cripto", "1d");
  const velas: any[] = v ? v.velas : [];
  const n = velas.length;
  let price: number | null = n ? velas[n - 1].c : null, d1: number | null = null;
  try {
    const j: any = await cg("/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true");
    if (j.bitcoin && isFinite(j.bitcoin.usd)) {
      price = j.bitcoin.usd;
      if (isFinite(j.bitcoin.usd_24h_change)) d1 = j.bitcoin.usd_24h_change / 100;
    }
  } catch {}
  if (d1 == null && n > 1 && price) d1 = price / velas[n - 2].c - 1;
  const d7 = n > 8 && price ? price / velas[n - 8].c - 1 : null;
  const sg = n ? senalDe(velas) : null;
  const d = { price, d1, d7, sig: sg ? { level: sg.level, label: sg.label, pts: sg.pts, rsi: sg.rsi, desdeMax: sg.desdeMax } : null };
  if (price != null) btcCache = { at: Date.now(), d };
  return d;
}

async function portPrices(rows: any[]): Promise<Record<string, number>> {
  if (portPxCache && Date.now() - portPxCache.at < 60_000) return portPxCache.px;
  const px: Record<string, number> = {};
  const cryptos = [...new Set(rows.filter((r) => r.tipo !== "accion").map((r) => r.s))];
  const stocks = [...new Set(rows.filter((r) => r.tipo === "accion").map((r) => r.s))];
  const ids = cryptos.map((s) => PORT_IDS[s]).filter(Boolean);
  if (ids.length) {
    try {
      const j: any = await cg("/simple/price?ids=" + [...new Set(ids)].join(",") + "&vs_currencies=usd");
      for (const s of cryptos) { const id = PORT_IDS[s]; if (id && j[id] && isFinite(j[id].usd)) px[s] = j[id].usd; }
    } catch (e: any) {
      console.error("portafolio precios cripto", e.message);
      try { const rws = await paprikaRows(); for (const s of cryptos) { const m = rws.find((x: any) => x.symbol === s); if (m && isFinite(m.current_price)) px[s] = m.current_price; } } catch {}
    }
  }
  for (const s of stocks) {
    try { const p = await yahooPrice(s); if (p && p > 0) px[s] = p; }
    catch (e: any) { console.error("portafolio precio accion", s, e.message); }
  }
  if (Object.keys(px).length) portPxCache = { at: Date.now(), px };
  return px;
}

function portAuthed(req: Request): boolean {
  if (!PORT_PIN) return false;
  const c = req.headers.get("cookie") || "";
  const m = c.match(/(?:^|;\s*)pf=([a-f0-9]+)/);
  return !!m && m[1] === PORT_TOKEN;
}
const PORT_DIAS = 30;
const PORT_COOKIE = "pf=" + PORT_TOKEN + "; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=" + (PORT_DIAS * 86400);

// Limite de intentos por IP. Vive en memoria: si el contenedor reinicia se
// reinicia el conteo, que para un solo usuario es suficiente.
const INTENTOS = new Map<string, { n: number; hasta: number }>();
const MAX_INTENTOS = 5;
const CASTIGO_MS = 10 * 60_000;

function quien(req: Request): string {
  const h = req.headers.get("x-forwarded-for") || "";
  return (h.split(",")[0] || "desconocido").trim();
}

function bloqueadoPor(ip: string): number {
  const e = INTENTOS.get(ip);
  if (!e) return 0;
  if (e.hasta > Date.now()) return Math.ceil((e.hasta - Date.now()) / 1000);
  if (e.hasta) INTENTOS.delete(ip);
  return 0;
}

function fallo(ip: string) {
  const e = INTENTOS.get(ip) || { n: 0, hasta: 0 };
  e.n++;
  if (e.n >= MAX_INTENTOS) { e.hasta = Date.now() + CASTIGO_MS; e.n = 0; }
  INTENTOS.set(ip, e);
  if (INTENTOS.size > 500) for (const [k, v] of INTENTOS) { if (v.hasta < Date.now()) INTENTOS.delete(k); }
}
const PAGE = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#EDF0F3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121A23" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex, nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Portafolio">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F512}</text></svg>">
<title>Portafolio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,500..800&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  box-sizing:border-box;
  padding-top:env(safe-area-inset-top,0px);
  padding-bottom:env(safe-area-inset-bottom,0px);
  --bg:#EDF0F3; --panel:#F8F9FA; --ink:#14202E; --soft:#5A6675; --rule:#D3D9DF;
  --up:#16704A; --upbg:#DDEFE5; --down:#B3302A; --downbg:#F6E0DE;
  --ath:#B8780A; --athbg:#F5E9CF; --track:#DCE1E6;
  --e20:#2F6FB0; --e50:#8A5CB8;
  --posbg:#E9F5EE; --posln:#BFDECB; --negbg:#FBEBE8; --negln:#EFC9C3;
  --posbg2:#CDEADA; --posln2:#8FC9AC; --negbg2:#F7D5CF; --negln2:#E0A49A;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#121A23; --panel:#18222D; --ink:#E4E9EE; --soft:#8E9AA8; --rule:#2A3643;
    --up:#4CC48A; --upbg:#173127; --down:#F07A70; --downbg:#3A1F1F;
    --ath:#E8B24A; --athbg:#3A2F17; --track:#26313D;
    --e20:#6FA8E0; --e50:#B891E0;
    --posbg:#15261E; --posln:#244534; --negbg:#2C1B19; --negln:#4A2B27;
    --posbg2:#1D3B2C; --posln2:#2F6349; --negbg2:#422422; --negln2:#6B3A34;
  }
}
*,*::before,*::after{box-sizing:inherit}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:"IBM Plex Sans",-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1240px;margin:0 auto;padding:26px 18px 48px}
header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:20px}
h1{font-family:Archivo,"Arial Narrow",sans-serif;font-stretch:78%;font-weight:800;
  font-size:clamp(34px,6vw,54px);line-height:.95;letter-spacing:-.01em;margin:0}
.sub{color:var(--soft);margin:6px 0 0;font-size:14px}
a{color:var(--ink)}
button{font:inherit;font-weight:600;font-size:14px;cursor:pointer;border-radius:8px;padding:9px 16px;
  border:1px solid var(--ink);background:var(--ink);color:var(--bg)}
button.ghost{background:transparent;color:var(--ink);border-color:var(--rule)}
button:disabled{opacity:.5;cursor:default}
button:focus-visible{outline:2px solid var(--ath);outline-offset:2px}
.tablebox{background:var(--panel);border:1px solid var(--rule);border-radius:12px;overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:900px;font-variant-numeric:tabular-nums}
th{font-size:12.5px;font-weight:500;color:var(--soft);text-align:right;padding:12px 14px;border-bottom:1px solid var(--rule);white-space:nowrap}
th:first-child{text-align:left}
td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--rule);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
.muted{color:var(--soft)}
.chg{font-weight:600}
.chg.up{color:var(--up)}
.chg.down{color:var(--down)}
footer{margin-top:22px;font-size:12.5px;color:var(--soft);max-width:78ch}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
.gate{max-width:360px;margin:40px auto;background:var(--panel);border:1px solid var(--rule);border-radius:14px;padding:26px 24px;text-align:center}
.gate h2{margin:0 0 6px;font-size:20px}
.gate p{margin:0 0 18px;color:var(--soft);font-size:13.5px}
.gate input{width:100%;box-sizing:border-box;text-align:center;letter-spacing:.5em;font-size:22px;font-variant-numeric:tabular-nums;padding:12px;border-radius:10px;border:1px solid var(--rule);background:var(--bg);color:var(--ink)}
.gate button{width:100%;margin-top:12px;padding:11px}
.gate .err{color:var(--down);font-size:13px;margin-top:10px;min-height:18px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 16px}
.tile{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:13px 15px}
.tile .k{font-size:11.5px;color:var(--soft);text-transform:uppercase;letter-spacing:.06em}
.tile .v{font-family:Archivo,sans-serif;font-stretch:85%;font-weight:700;font-size:22px;font-variant-numeric:tabular-nums;margin-top:3px}
.tile .x{font-size:12px;color:var(--soft);font-variant-numeric:tabular-nums}
.psec{margin:26px 0 0}
.psec h2{font-size:18px;margin:0 0 4px}
.psec .rsub{color:var(--soft);font-size:13px;margin:0 0 10px}
.ptable table{min-width:900px}
.ptable td,.ptable th{padding:9px 12px}
.pact{display:flex;gap:6px;justify-content:flex-end}
.pact button{padding:4px 9px;font-size:12px}
.pbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
.form{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:16px;margin:0 0 16px;display:none}
.form.show{display:block}
.form .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.form label{display:block;font-size:11.5px;color:var(--soft);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.form input,.form select{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--rule);background:var(--bg);color:var(--ink);font-size:14px;font-variant-numeric:tabular-nums}
.form .frow{margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.form .hint{color:var(--soft);font-size:12.5px;margin:10px 0 0}
.retro{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:16px 14px;overflow-x:auto}
.retro svg{display:block}
.retro .lg{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--soft);margin:10px 0 0;padding:0 4px}
.retro .lg i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.pie{display:flex;gap:26px;flex-wrap:wrap;align-items:center;justify-content:flex-start}
.pie .plist{flex:1;min-width:230px;display:grid;grid-template-columns:auto 1fr auto auto;gap:5px 10px;align-items:center;font-size:13.5px}
.pie .plist i{width:11px;height:11px;border-radius:3px;display:inline-block}
.pie .plist .nm{font-weight:600}
.pie .plist .vl,.pie .plist .sh{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.pie .plist .sh{color:var(--soft)}
.pie .hole .t{font-family:Archivo,sans-serif;font-stretch:85%;font-weight:700}
.tile.warn{border-color:var(--ath);background:var(--athbg)}
.movtable table{min-width:620px}
.pill{font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:999px;display:inline-block}
.pill.dep{background:var(--upbg);color:var(--up)}
.pill.ret{background:var(--downbg);color:var(--down)}
.aviso{background:var(--athbg);border:1px solid var(--ath);border-radius:10px;padding:12px 15px;margin:0 0 12px;font-size:13.5px}
.pill.tra{background:var(--track);color:var(--soft)}
.carts{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.cart{background:var(--panel);border:1px solid var(--rule);border-radius:10px;padding:8px 13px;font-size:13px}
.cart b{font-variant-numeric:tabular-nums;margin-left:6px}
.cart.neg b{color:var(--down)}
.ruta{color:var(--soft);font-size:12.5px;white-space:nowrap}
.pxhint{font-size:12.5px;color:var(--soft);margin-top:5px;min-height:18px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.pxhint b{color:var(--ink);font-variant-numeric:tabular-nums}
.pxhint button{padding:2px 9px;font-size:11.5px}
.pxnow{font-weight:700}
th .sb{all:unset;cursor:pointer;display:block;width:100%;padding:12px 14px;box-sizing:border-box;text-align:right;white-space:nowrap}
th:first-child .sb{text-align:left}
th.s{padding:0}
th .sb:hover{color:var(--ink)}
th .sb:focus-visible{outline:2px solid var(--ath);outline-offset:-2px}
th .sb[data-dir="desc"]::after{content:" \\2193";font-weight:700}
th .sb[data-dir="asc"]::after{content:" \\2191";font-weight:700}
th .sb[data-dir]{color:var(--ink);font-weight:700}
.filtros{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 11px;align-items:center}
.filtros button{padding:5px 12px;font-size:12.5px}
.filtros button[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.filtros .cnt{font-size:12.5px;color:var(--soft);margin-left:3px}
.agr{font-size:11px;font-weight:600;color:var(--soft);background:var(--track);padding:1px 6px;border-radius:999px;margin-left:6px}
.peso{margin-top:4px;display:flex;align-items:center;gap:6px;justify-content:flex-end}
.peso .bar{width:52px;height:5px;border-radius:3px;background:var(--track);overflow:hidden}
.peso .bar i{display:block;height:100%;background:var(--soft);border-radius:3px}
.peso .bar.alto i{background:var(--ath)}
.peso small{font-size:11px;color:var(--soft);font-variant-numeric:tabular-nums;min-width:34px;text-align:right}
tfoot td{border-top:2px solid var(--rule);border-bottom:0;font-weight:700;padding-top:11px;padding-bottom:11px;background:var(--panel)}
tfoot .lbl{text-align:left;font-weight:600;color:var(--soft);font-size:12.5px}
.alerta{background:var(--downbg);border:1px solid var(--down);border-radius:10px;padding:12px 15px;margin:0 0 12px;font-size:13.5px}
.alerta b{color:var(--down)}
.alerta ul{margin:7px 0 0;padding-left:19px}
.alerta li{margin:2px 0}
.curva{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:16px 14px;overflow-x:auto}
.curva svg{display:block}
.sym{cursor:pointer;border-bottom:1px dotted var(--soft)}
.sym:hover{border-bottom-color:var(--ink)}
#pf-graf{display:none;margin:0 0 18px;background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:15px 16px}
#pf-graf.show{display:block}
.ghead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.gtitle{font-family:Archivo,sans-serif;font-stretch:80%;font-weight:800;font-size:24px;display:flex;align-items:baseline;gap:9px}
.gtitle small{font-family:"IBM Plex Sans",sans-serif;font-stretch:100%;font-weight:400;font-size:13px;color:var(--soft)}
.gright{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.gright button{padding:5px 11px;font-size:13px}
.gright button[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.gsub{color:var(--soft);font-size:13px;margin:0 0 10px}
.gwrap{overflow-x:auto}
.glg{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--soft);margin:9px 0 0}
.glg i{display:inline-block;width:11px;height:11px;margin-right:5px;vertical-align:-1px}
.sg{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:999px;margin-left:7px;white-space:nowrap;letter-spacing:.02em}
.sg.s3{background:var(--upbg);color:var(--up)}
.sg.s2{background:var(--athbg);color:var(--ath)}
.sg.s1{background:var(--track);color:var(--soft)}
.sg.s0{background:var(--downbg);color:var(--down)}
.gsen{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 10px}
.gsen .big{font-size:13.5px;font-weight:700;padding:4px 11px;border-radius:999px}
.gsen .big.s3{background:var(--upbg);color:var(--up)}
.gsen .big.s2{background:var(--athbg);color:var(--ath)}
.gsen .big.s1{background:var(--track);color:var(--soft)}
.gsen .big.s0{background:var(--downbg);color:var(--down)}
.gchk{display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--soft)}
.gchk .ok{color:var(--up);font-weight:600}
.gchk .no{opacity:.65}
.gchk b{font-variant-numeric:tabular-nums;color:var(--ink)}
.btcbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:11px 16px;margin:0 0 12px;font-size:13.5px;font-variant-numeric:tabular-nums}
.btcbar:empty{display:none}
.btcbar .nm{font-family:Archivo,sans-serif;font-stretch:80%;font-weight:800;font-size:20px}
.btcbar .px{font-family:Archivo,sans-serif;font-stretch:85%;font-weight:700;font-size:20px}
.btcbar .k{color:var(--soft);margin-right:5px}
.btcbar a{margin-left:auto;font-size:12.5px;color:var(--soft)}
/* ---------- tarjetas: el modo por defecto en cualquier pantalla ---------- */
.ptable{overflow-x:visible}
.ptable table{min-width:0;display:block}
.ptable thead{display:none}
.ptable tbody,.ptable tfoot{display:block}
.ptable tr{display:block;padding:11px 13px;border-bottom:1px solid var(--rule)}
.ptable tbody tr:last-child{border-bottom:0}
.ptable td{display:flex;justify-content:space-between;align-items:baseline;gap:14px;
  padding:3px 0;border-bottom:0;text-align:right;white-space:normal}
.ptable td:empty{display:none}
.ptable td::before{content:attr(data-l);color:var(--soft);font-size:12.5px;
  text-align:left;flex:0 0 auto;white-space:nowrap}
.ptable td[data-l=""]::before,.ptable td:not([data-l])::before{content:none}
.ptable td.cab{display:block;text-align:left;margin-bottom:5px;font-size:16px}
.ptable td.cab::before{content:none}
.ptable .pact{justify-content:flex-start;margin-top:8px}
.ptable .peso{margin-top:0}
.ptable tfoot td{border-top:0;padding:3px 0}
.ptable tfoot tr{border-top:2px solid var(--rule);background:var(--panel)}
/* verde muy claro en ganancia, rojo claro en perdida */
.ptable tbody tr.pos{background:var(--posbg)}
.ptable tbody tr.neg{background:var(--negbg)}

@media (min-width: 761px){
  /* en pantalla ancha las tarjetas se acomodan en rejilla */
  .ptable:not(.tabla){background:transparent;border:0;border-radius:0}
  .ptable:not(.tabla) tbody{display:grid;gap:12px;
    grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
  .ptable:not(.tabla) tbody tr{border:1px solid var(--rule);border-radius:12px;
    background:var(--panel);padding:13px 15px}
  .ptable:not(.tabla) tbody tr.pos{border-color:var(--posln);background:var(--posbg)}
  .ptable:not(.tabla) tbody tr.neg{border-color:var(--negln);background:var(--negbg)}
  .ptable:not(.tabla) tbody tr:last-child{border-bottom:1px solid var(--rule)}
  .ptable:not(.tabla) tbody tr.pos:last-child{border-bottom-color:var(--posln)}
  .ptable:not(.tabla) tbody tr.neg:last-child{border-bottom-color:var(--negln)}
  .ptable:not(.tabla) tfoot tr{margin-top:12px;border:1px solid var(--rule);
    border-radius:12px;padding:13px 15px}
  .ptable:not(.tabla) td.cab{font-size:17px}
  .ptable:not(.tabla) tbody tr:empty{display:none}

  /* modo tabla, el de siempre */
  .ptable.tabla table{display:table;min-width:900px}
  .ptable.tabla thead{display:table-header-group}
  .ptable.tabla tbody{display:table-row-group}
  .ptable.tabla tfoot{display:table-footer-group}
  .ptable.tabla tr{display:table-row;padding:0}
  .ptable.tabla td{display:table-cell;padding:9px 12px;text-align:right;
    white-space:nowrap;border-bottom:1px solid var(--rule)}
  .ptable.tabla tbody tr:last-child td{border-bottom:0}
  .ptable.tabla td::before{content:none}
  .ptable.tabla td.cab{display:table-cell;margin:0;font-size:inherit;text-align:left}
  .ptable.tabla .pact{justify-content:flex-end;margin-top:0}
  .ptable.tabla .peso{margin-top:4px}
  .ptable.tabla tfoot td{border-top:2px solid var(--rule);padding:11px 12px}
  .ptable.tabla tfoot tr{margin:0;border:0;border-radius:0;padding:0}
}

@media (max-width: 760px){
  .wrap{padding:18px 13px 40px}
  body{font-size:15.5px}
  .movtable table{min-width:0}
  .movtable td,.movtable th{padding:8px 9px;font-size:13px}
  .tiles{grid-template-columns:repeat(auto-fit,minmax(132px,1fr))}
  .filtros .solo-ancho{display:none}
}
.filtros select{font:inherit;font-size:12.5px;padding:5px 9px;border-radius:8px;
  border:1px solid var(--rule);background:var(--panel);color:var(--ink)}
/* ---------- cerradas: mas apretadas y con color mas marcado ---------- */
.ptable.compacta tbody tr{font-size:13px;padding:9px 11px}
.ptable.compacta td{padding:1px 0;gap:10px}
.ptable.compacta td::before{font-size:11.5px}
.ptable.compacta td.cab{font-size:14.5px;margin-bottom:3px}
.ptable.compacta .pact{margin-top:6px;gap:5px}
.ptable.compacta .pact button{padding:3px 8px;font-size:11.5px}
.ptable.compacta .sg{font-size:9.5px;padding:1px 6px}
.ptable.compacta tbody tr.pos{background:var(--posbg2)}
.ptable.compacta tbody tr.neg{background:var(--negbg2)}
/* abiertas: franja de color al costado y el PNL resaltado */
.ptable.abiertas tbody tr{border-left:5px solid transparent}
.ptable.abiertas tbody tr.pos{border-left-color:var(--up)}
.ptable.abiertas tbody tr.neg{border-left-color:var(--down)}
.ptable.abiertas:not(.tabla) td[data-l="PNL"]{align-items:center;margin-top:2px}
.ptable.abiertas:not(.tabla) td[data-l="PNL"]::before{font-weight:600;color:var(--ink)}
.ptable.abiertas:not(.tabla) td[data-l="PNL"] .chg{font-size:15.5px;padding:3px 11px;
  border-radius:999px;font-weight:700}
.ptable.abiertas:not(.tabla) td[data-l="PNL"] .chg.up{background:var(--upbg);color:var(--up)}
.ptable.abiertas:not(.tabla) td[data-l="PNL"] .chg.down{background:var(--downbg);color:var(--down)}
@media (min-width: 761px){
  .ptable.compacta:not(.tabla) tbody{grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:9px}
  .ptable.compacta:not(.tabla) tbody tr{padding:10px 13px;border-radius:10px;
    display:grid;grid-template-columns:1fr 1fr;gap:0 16px;align-content:start}
  .ptable.compacta:not(.tabla) tbody tr > td.cab,
  .ptable.compacta:not(.tabla) tbody tr > td:last-child{grid-column:1 / -1}
  .ptable.compacta:not(.tabla) tbody tr.pos{border-color:var(--posln2);background:var(--posbg2)}
  .ptable.compacta:not(.tabla) tbody tr.neg{border-color:var(--negln2);background:var(--negbg2)}
  .ptable.compacta:not(.tabla) td.cab{font-size:15px}
  .ptable.compacta.tabla tbody tr.pos{background:var(--posbg2)}
  .ptable.compacta.tabla tbody tr.neg{background:var(--negbg2)}
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Portafolio</h1>
      <p class="sub" id="sub">Apartado privado</p>
    </div>
    <a href="https://tablero-production-356e.up.railway.app/#cripto"><button class="ghost">Ir al tablero</button></a>
  </header>

  <section id="portafolio" aria-labelledby="pf-h">
    <div class="gate" id="pf-gate">
      <h2>Apartado privado</h2>
      <p>Escribe tu PIN para ver y editar tus posiciones.</p>
      <input id="pf-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" aria-label="PIN">
      <button id="pf-entrar">Entrar</button>
      <div class="err" id="pf-err"></div>
    </div>

    <div id="pf-body" hidden>
      <div class="btcbar" id="pf-btc" aria-label="Bitcoin como referencia"></div>
      <div class="tiles" id="pf-tiles"></div>

      <div class="pbar">
        <button id="pf-nueva">Agregar posicion</button>
        <button class="ghost" id="pf-movnueva">Deposito / retiro</button>
        <button class="ghost" id="pf-recargar">Actualizar precios</button>
        <button class="ghost" id="pf-salir">Cerrar sesion</button>
        <span class="muted" id="pf-msg"></span>
      </div>

      <div class="form" id="pf-form">
        <div class="grid">
          <div><label for="f-s">Activo</label><input id="f-s" placeholder="SOL" maxlength="12"></div>
          <div><label for="f-tipo">Tipo</label><select id="f-tipo"><option value="cripto">Cripto</option><option value="accion">Accion</option></select></div>
          <div><label for="f-fecha">Fecha de compra</label><input id="f-fecha" type="date"></div>
          <div><label for="f-inv">Inversion (USD)</label><input id="f-inv" type="number" step="any" inputmode="decimal"></div>
          <div><label for="f-cant">Cantidad</label><input id="f-cant" type="number" step="any" inputmode="decimal"></div>
          <div><label for="f-compra">Precio de compra</label><input id="f-compra" type="number" step="any" inputmode="decimal"><div class="pxhint" id="f-px"></div></div>
          <div><label for="f-estado">Estado</label><select id="f-estado"><option value="abierta">Abierta</option><option value="cerrada">Cerrada</option></select></div>
          <div id="f-wrap-cierre" hidden><label for="f-cierre">Precio de venta</label><input id="f-cierre" type="number" step="any" inputmode="decimal"><div class="pxhint" id="f-pxv"></div></div>
          <div id="f-wrap-fcierre" hidden><label for="f-fcierre">Fecha de venta</label><input id="f-fcierre" type="date"></div>
        </div>
        <p class="hint">Escribe cantidad y precio de compra y la inversion se calcula sola. Si prefieres, escribe la inversion y se calcula la cantidad.</p>
        <div class="frow">
          <button id="f-guardar">Guardar</button>
          <button class="ghost" id="f-cancelar">Cancelar</button>
        </div>
      </div>

      <div class="form" id="pf-mform">
        <div class="grid">
          <div><label for="m-tipo">Movimiento</label><select id="m-tipo"><option value="deposito">Deposito (entra dinero nuevo)</option><option value="retiro">Retiro (sale al banco)</option><option value="transferencia">Transferencia entre carteras</option></select></div>
          <div><label for="m-fecha">Fecha</label><input id="m-fecha" type="date"></div>
          <div><label for="m-monto">Monto (USD)</label><input id="m-monto" type="number" step="any" inputmode="decimal"></div>
          <div id="m-wrap-de" hidden><label for="m-de">Sale de</label><input id="m-de" list="carteras" maxlength="24" placeholder="Spot"></div>
          <div id="m-wrap-a" hidden><label for="m-a">Entra a</label><input id="m-a" list="carteras" maxlength="24" placeholder="Spot"></div>
          <div><label for="m-nota">Nota (opcional)</label><input id="m-nota" maxlength="120" placeholder="Binance, banco..."></div>
        </div>
        <datalist id="carteras"></datalist>
        <p class="hint">Una transferencia mueve dinero entre tus propias carteras (Spot, Futuros): no cambia lo que has aportado, solo donde esta.</p>
        <div class="frow">
          <button id="m-guardar">Guardar</button>
          <button class="ghost" id="m-cancelar">Cancelar</button>
        </div>
      </div>

      <div id="pf-graf" aria-live="polite"></div>

      <section class="psec">
        <h2 id="pf-h">Posiciones abiertas</h2>
        <p class="rsub" id="pf-sub-ab">—</p>
        <div id="pf-alerta"></div>
        <div class="filtros" id="pf-filtros">
          <button class="ghost" data-f="all" aria-pressed="true">Todas</button>
          <button class="ghost" data-f="verde" aria-pressed="false">En verde</button>
          <button class="ghost" data-f="rojo" aria-pressed="false">En rojo</button>
          <button class="ghost" data-f="compra" aria-pressed="false">Zona de compra</button>
          <button class="ghost" data-f="retro" aria-pressed="false">Esperar retroceso</button>
          <button class="ghost" id="pf-agrupar" aria-pressed="false" title="Junta las compras del mismo activo en un solo renglon">Agrupar por activo</button>
          <select id="pf-orden" aria-label="Ordenar las posiciones">
            <option value="pct">Mayor % de ganancia</option>
            <option value="pnl">Mayor PNL en dolares</option>
            <option value="inversion">Mayor inversion</option>
            <option value="valor">Mayor valor de mercado</option>
            <option value="fecha">Mas reciente</option>
            <option value="s">Activo (A-Z)</option>
          </select>
          <button class="ghost solo-ancho" id="pf-vista" aria-pressed="false" title="Cambia entre tarjetas y tabla">Ver como tabla</button>
          <span class="cnt" id="pf-cnt"></span>
        </div>
        <div class="tablebox ptable abiertas">
          <table>
            <thead><tr id="pf-th-ab">
              <th class="s"><button class="sb" data-k="s">Activo</button></th>
              <th class="s"><button class="sb" data-k="fecha">Fecha</button></th>
              <th class="s"><button class="sb" data-k="inversion">Inversion</button></th>
              <th class="s"><button class="sb" data-k="cantidad">Cantidad</button></th>
              <th class="s"><button class="sb" data-k="compra">Precio compra</button></th>
              <th class="s"><button class="sb" data-k="px">Precio de mercado</button></th>
              <th class="s"><button class="sb" data-k="valor">Valor</button></th>
              <th class="s"><button class="sb" data-k="pnl">PNL</button></th>
              <th class="s"><button class="sb" data-k="pct">%</button></th>
              <th></th>
            </tr></thead>
            <tbody id="pf-rows-ab"></tbody>
            <tfoot id="pf-tot-ab"></tfoot>
          </table>
        </div>
      </section>

      <section class="psec">
        <h2>Posiciones cerradas</h2>
        <p class="rsub">Ordenadas de mayor a menor ganancia. "Mercado vs. tu venta" compara el precio actual del mercado contra el precio al que vendiste: en verde si el mercado retrocedio (vendiste bien), en rojo si siguio subiendo sin ti.</p>
        <div class="tablebox ptable compacta">
          <table>
            <thead><tr id="pf-th-ce">
              <th class="s"><button class="sb" data-k="s">Activo</button></th>
              <th class="s"><button class="sb" data-k="fecha">Fecha</button></th>
              <th class="s"><button class="sb" data-k="inversion">Inversion</button></th>
              <th class="s"><button class="sb" data-k="compra">Precio compra</button></th>
              <th class="s"><button class="sb" data-k="cierre">Precio venta</button></th>
              <th class="s"><button class="sb" data-k="pnl">PNL</button></th>
              <th class="s"><button class="sb" data-k="pct">%</button></th>
              <th class="s"><button class="sb" data-k="px">Precio de mercado</button></th>
              <th class="s"><button class="sb" data-k="dif">Mercado vs. tu venta</button></th>
              <th></th>
            </tr></thead>
            <tbody id="pf-rows-ce"></tbody>
            <tfoot id="pf-tot-ce"></tfoot>
          </table>
        </div>
      </section>

      <section class="psec">
        <h2>Movimientos de capital</h2>
        <p class="rsub" id="pf-sub-mov">—</p>
        <div class="carts" id="pf-carts"></div>
        <div id="pf-aviso"></div>
        <div class="tablebox movtable">
          <table>
            <thead><tr>
              <th style="text-align:left">Fecha</th><th style="text-align:left">Tipo</th><th>Monto</th>
              <th style="text-align:left">Ruta</th><th style="text-align:left">Nota</th><th>Aportado acumulado</th><th></th>
            </tr></thead>
            <tbody id="pf-rows-mov"></tbody>
          </table>
        </div>
      </section>

      <section class="psec">
        <h2>Evolucion de la cuenta</h2>
        <p class="rsub" id="pf-sub-curva">—</p>
        <div class="curva" id="pf-curva"></div>
      </section>

      <section class="psec">
        <h2>PNL positivo por cripto</h2>
        <p class="rsub" id="pf-sub-pie">—</p>
        <div class="retro" id="pf-pie"></div>
      </section>

      <section class="psec">
        <h2>Retroceso desde tus ventas</h2>
        <p class="rsub" id="pf-sub-re">—</p>
        <div class="retro" id="pf-retro"></div>
      </section>
    </div>
  </section>

  <footer id="foot">
    Apartado privado, protegido con PIN y guardado en el servidor: se ve igual desde cualquier dispositivo. Toca cualquier encabezado para ordenar por esa columna, usa los filtros para ver solo lo que te interesa y "Agrupar por activo" para juntar tus compras del mismo simbolo. La barrita bajo cada inversion es su peso en tu capital, en ambar cuando pasa del 18%. "Precio de mercado" es la cotizacion en vivo y se refresca cada minuto. La etiqueta junto a cada activo es la senal de 5 puntos del tablero; toca el simbolo para ver sus velas con tus compras (B) y ventas (S). Precios de CoinGecko y Yahoo Finance. No es asesoria financiera.
  </footer>
</div>

<script>
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
function fmtPrice(n){
  if (n == null || !isFinite(n)) return "—";
  var a = Math.abs(n);
  var d = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return n.toLocaleString("es-MX",{minimumFractionDigits:d,maximumFractionDigits:d});
}
function pctText(p){ return (p>0?"+":"") + (p*100).toFixed(1) + "%"; }
function fmtPct(p){
  if (p == null || !isFinite(p)) return '<span class="muted">—</span>';
  return '<span class="chg ' + (p>=0?"up":"down") + '">' + pctText(p) + '</span>';
}
function fmtDate(iso){ try { return new Date(iso + "T12:00:00").toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"}); } catch(e){ return iso || ""; } }

var pf = { auth:false, pos:[], mov:[], px:{}, edit:null, medit:null, loading:false, pxForm:null, pxTimer:null, graf:null, grafTipo:"cripto", gtf:"1d", velas:null, sig:{},
  ordAb:{k:"pct",dir:-1}, ordCe:{k:"pnl",dir:-1}, filtro:"all", agrupar:false, snap:[], vista:"tarjetas" };

try { var vg = localStorage.getItem("pf-vista"); if (vg === "tabla" || vg === "tarjetas") pf.vista = vg; } catch(e){}

function pfVistaAplica(){
  var tabla = pf.vista === "tabla";
  document.querySelectorAll(".ptable").forEach(function(x){ x.classList.toggle("tabla", tabla); });
  var b = $("pf-vista");
  if (b){ b.textContent = tabla ? "Ver como tarjetas" : "Ver como tabla"; b.setAttribute("aria-pressed", tabla ? "true" : "false"); }
  var sel = $("pf-orden");
  if (sel) sel.value = pf.ordAb.k;
}

var PF_TOL = 1;
function pfMsg(t){ $("pf-msg").textContent = t || ""; }
function pfUsd(n){ if (n == null || !isFinite(n)) return "—"; return (n<0?"-$":"$") + Math.abs(n).toLocaleString("es-MX",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function pfSign(n){ return n == null || !isFinite(n) ? '<span class="muted">—</span>' : '<span class="chg ' + (n>=0?"up":"down") + '">' + (n>0?"+":"") + pfUsd(n).replace("-","−") + '</span>'; }
function pfPx(r){ var p = pf.px[r.s]; return (p != null && isFinite(p)) ? p : null; }

function pfLogin(){
  var pin = $("pf-pin").value.trim();
  if (!pin) return;
  $("pf-err").textContent = ""; $("pf-entrar").disabled = true;
  fetch("/api/portafolio/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pin:pin})})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
    .then(function(res){
      $("pf-entrar").disabled = false;
      if (!res.ok){
        var e = res.j.error, m = "PIN incorrecto.";
        if (e === "sin_pin") m = "El servidor no tiene PIN configurado.";
        else if (e === "demasiados_intentos"){
          var seg = res.j.segundos || 600;
          m = "Demasiados intentos. Espera " + Math.ceil(seg / 60) + " minutos.";
        }
        $("pf-err").textContent = m; $("pf-pin").value = ""; return;
      }
      $("pf-pin").value = ""; pf.auth = true; pfShow(); pfLoad();
    })
    .catch(function(){ $("pf-entrar").disabled = false; $("pf-err").textContent = "Sin conexion."; });
}

function pfShow(){ $("pf-gate").style.display = pf.auth ? "none" : ""; $("pf-body").hidden = !pf.auth; }

function pfLoad(){
  if (pf.loading) return;
  pf.loading = true; pfMsg("Cargando precios…");
  fetch("/api/portafolio",{cache:"no-store"})
    .then(function(r){ return r.json().then(function(j){ return {st:r.status,j:j}; }); })
    .then(function(res){
      pf.loading = false;
      if (res.st === 401){ pf.auth = false; pfShow(); pfMsg(""); return; }
      if (res.st !== 200){ pfMsg("No se pudieron cargar los datos."); return; }
      pf.auth = true; pf.pos = res.j.pos || []; pf.mov = res.j.mov || []; pf.px = res.j.precios || {};
      pf.snap = res.j.snap || pf.snap;
      pfShow(); pfMsg("Actualizado " + new Date().toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"}));
      pfRender();
      pfSenales();
      pfBtc();
    })
    .catch(function(){ pf.loading = false; pfMsg("Sin conexion."); });
}

function pfSenales(){
  fetch("/api/portafolio/senales", {cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(j){ if (j && j.senales){ pf.sig = j.senales; pfRender(); } })
    .catch(function(){});
}

function pfBtc(){
  fetch("/api/portafolio/btc", {cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(b){
      if (!b || b.price == null) return;
      var s = b.sig;
      $("pf-btc").innerHTML = '<span class="nm">BTC</span><span class="px">$' + fmtPrice(b.price) + '</span>' +
        '<span><span class="k">24 h</span>' + fmtPct(b.d1) + '</span>' +
        '<span><span class="k">7 dias</span>' + fmtPct(b.d7) + '</span>' +
        (s ? '<span><span class="k">RSI</span><b>' + (s.rsi == null ? "—" : s.rsi.toFixed(0)) + '</b></span>' +
             '<span><span class="k">desde su maximo de 90 dias</span>' + fmtPct(s.desdeMax) + '</span>' +
             '<span class="sg ' + sgClase(s.level) + '" style="margin-left:0">' + esc(s.label) + ' · ' + s.pts + '/5</span>' : '') +
        '<a href="https://tablero-production-356e.up.railway.app/#cripto">Ver en el tablero</a>';
    })
    .catch(function(){});
}

function sgClase(l){ return "s" + l; }
function sgPill(sim){
  var g = pf.sig[sim];
  if (!g) return "";
  return '<span class="sg ' + sgClase(g.level) + '" title="' + esc(g.label) + ' · ' + g.pts + ' de 5 puntos">' + esc(g.label) + '</span>';
}

function pfSave(rows, movs){
  pfMsg("Guardando…");
  var body = {};
  if (rows) body.pos = rows;
  if (movs) body.mov = movs;
  return fetch("/api/portafolio",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){ return r.json().then(function(j){ return {st:r.status,j:j}; }); })
    .then(function(res){
      if (res.st === 401){ pf.auth = false; pfShow(); return; }
      if (res.st !== 200){ pfMsg("No se pudo guardar. Intenta de nuevo."); return; }
      pf.pos = res.j.pos || []; pf.mov = res.j.mov || []; pf.px = res.j.precios || pf.px;
      pf.snap = res.j.snap || pf.snap;
      pfMsg("Guardado"); pfRender();
    })
    .catch(function(){ pfMsg("Sin conexion; no se guardo."); });
}

function pfFormShow(row){
  pf.edit = row ? row.id : null;
  $("f-s").value = row ? row.s : "";
  $("f-tipo").value = row ? row.tipo : "cripto";
  $("f-fecha").value = row ? row.fecha : new Date().toISOString().slice(0,10);
  $("f-inv").value = row ? row.inversion : "";
  $("f-cant").value = row ? row.cantidad : "";
  $("f-compra").value = row ? row.compra : "";
  $("f-estado").value = row ? row.estado : "abierta";
  $("f-cierre").value = row && row.cierre ? row.cierre : "";
  $("f-fcierre").value = row && row.fechaCierre ? row.fechaCierre : "";
  pf.fUlt = null;
  pf.pxForm = null;
  $("f-px").innerHTML = ""; $("f-pxv").innerHTML = "";
  pfEstadoToggle();
  $("pf-form").classList.add("show");
  $("f-s").focus();
  if (row) pfPrecioVivo();
}
function pfEstadoToggle(){
  var c = $("f-estado").value === "cerrada";
  $("f-wrap-cierre").hidden = !c; $("f-wrap-fcierre").hidden = !c;
  if (c) pfPintaPrecio();
}

function pfPintaPrecio(){
  var p = pf.pxForm;
  var htmlC = p == null ? "" : 'Mercado ahora: <b>' + fmtPrice(p) + '</b> <button type="button" class="ghost" data-px="compra">Usar</button>';
  var htmlV = p == null ? "" : 'Mercado ahora: <b>' + fmtPrice(p) + '</b> <button type="button" class="ghost" data-px="venta">Usar</button>';
  $("f-px").innerHTML = htmlC;
  $("f-pxv").innerHTML = htmlV;
}

function pfPrecioVivo(){
  var s = $("f-s").value.trim().toUpperCase();
  pf.pxForm = null;
  if (!s){ $("f-px").innerHTML = ""; $("f-pxv").innerHTML = ""; return; }
  $("f-px").textContent = "Buscando precio…";
  var tipo = $("f-tipo").value;
  fetch("/api/portafolio/precio?tipo=" + encodeURIComponent(tipo) + "&s=" + encodeURIComponent(s), {cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if ($("f-s").value.trim().toUpperCase() !== s) return;
      if (!j || j.precio == null){
        pf.pxForm = null;
        $("f-px").innerHTML = '<span class="muted">Sin precio en vivo para ' + esc(s) + '</span>';
        $("f-pxv").innerHTML = "";
        return;
      }
      pf.pxForm = j.precio;
      pfPintaPrecio();
      if (!$("f-compra").value) $("f-compra").value = j.precio;
      if ($("f-estado").value === "cerrada" && !$("f-cierre").value) $("f-cierre").value = j.precio;
    })
    .catch(function(){ $("f-px").innerHTML = ""; });
}

function pfPrecioDebounce(){
  if (pf.pxTimer) clearTimeout(pf.pxTimer);
  pf.pxTimer = setTimeout(pfPrecioVivo, 650);
}
function pfFormHide(){ $("pf-form").classList.remove("show"); pf.edit = null; }

function pfFormSave(){
  var s = $("f-s").value.trim().toUpperCase();
  if (!s){ pfMsg("Falta el activo."); return; }
  var inv = parseFloat($("f-inv").value), cant = parseFloat($("f-cant").value), compra = parseFloat($("f-compra").value);
  if (!isFinite(compra) || compra <= 0){ pfMsg("Falta el precio de compra."); return; }
  if (!isFinite(cant) && isFinite(inv)) cant = inv / compra;
  if (!isFinite(inv) && isFinite(cant)) inv = cant * compra;
  if (!isFinite(cant) || cant <= 0){ pfMsg("Falta la cantidad o la inversion."); return; }
  var row = {
    id: pf.edit || ("p" + Date.now()),
    tipo: $("f-tipo").value, s: s, fecha: $("f-fecha").value,
    inversion: inv, cantidad: cant, compra: compra, estado: $("f-estado").value
  };
  if (row.estado === "cerrada"){
    var cv = parseFloat($("f-cierre").value);
    if (!isFinite(cv) || cv <= 0){ pfMsg("Falta el precio de venta."); return; }
    row.cierre = cv; row.fechaCierre = $("f-fcierre").value || row.fecha;
  }
  var rows = pf.pos.filter(function(r){ return r.id !== row.id; });
  rows.push(row);
  pfFormHide();
  pfSave(rows);
}

function pfCerrar(id){
  var r = pf.pos.find(function(x){ return x.id === id; });
  if (!r) return;
  var p = pfPx(r);
  var v = prompt("Precio de venta de " + r.s + ":", p != null ? String(p) : "");
  if (v === null) return;
  var n = parseFloat(v);
  if (!isFinite(n) || n <= 0){ pfMsg("Precio de venta invalido."); return; }
  var pnl = r.cantidad * n - r.inversion;
  if (!confirm("Cerrar " + r.s + " a " + fmtPrice(n) + "?\\n\\n" +
      "Invertiste " + pfUsd(r.inversion) + " y recibes " + pfUsd(r.cantidad * n) + ".\\n" +
      "Resultado: " + (pnl >= 0 ? "+" : "−") + pfUsd(Math.abs(pnl)) +
      " (" + pctText(pnl / r.inversion) + ").")) return;
  var rows = pf.pos.map(function(x){
    if (x.id !== id) return x;
    var y = Object.assign({}, x); y.estado = "cerrada"; y.cierre = n; y.fechaCierre = new Date().toISOString().slice(0,10); return y;
  });
  pfSave(rows);
}

function pfBorrar(id){
  var r = pf.pos.find(function(x){ return x.id === id; });
  if (!r) return;
  if (!confirm("Borrar la posicion de " + r.s + " del " + fmtDate(r.fecha) + "? No se puede deshacer.")) return;
  pfSave(pf.pos.filter(function(x){ return x.id !== id; }));
}

function pfRender(){
  var ab = pf.pos.filter(function(r){ return r.estado !== "cerrada"; });
  var ce = pf.pos.filter(function(r){ return r.estado === "cerrada"; });

  var invAb = 0, valAb = 0, sinPx = 0;
  ab.forEach(function(r){ invAb += r.inversion; var p = pfPx(r); if (p == null){ sinPx++; valAb += r.inversion; } else valAb += r.cantidad * p; });
  var pnlAb = valAb - invAb;
  var invCe = 0, pnlCe = 0, gan = 0;
  ce.forEach(function(r){ invCe += r.inversion; var pn = r.cantidad * r.cierre - r.inversion; pnlCe += pn; if (pn > 0) gan++; });

  var caja = pfCaja(invAb, pnlCe);
  var dep = caja.dep, ret = caja.ret, neto = caja.neto, efectivo = caja.total;
  var cuenta = efectivo + valAb;
  var pnlTot = pnlAb + pnlCe;

  $("pf-tiles").innerHTML =
    (neto > 0 ? tile("Valor de la cuenta", pfUsd(cuenta), "aportado neto " + pfUsd(neto)) : "") +
    (neto > 0 ? tile("Rendimiento sobre aportado", '<span class="chg ' + (cuenta>=neto?"up":"down") + '">' + pctText(cuenta/neto - 1) + '</span>', pfSign(pnlTot) + " acumulado") : "") +
    tile("Capital en posiciones", pfUsd(invAb), ab.length + (ab.length === 1 ? " posicion" : " posiciones")) +
    tile("Valor de mercado", pfUsd(valAb), (sinPx ? sinPx + " sin precio en vivo" : "precios en vivo")) +
    tileC("Efectivo libre", Math.abs(efectivo) < PF_TOL ? pfUsd(0) : pfUsd(efectivo),
      efectivo < -PF_TOL ? "no cuadra, revisa abajo"
        : Math.abs(efectivo) < PF_TOL && efectivo !== 0 ? "redondeo de las cerradas"
        : "en todas tus carteras",
      efectivo < -PF_TOL ? "warn" : "") +
    tile("PNL flotante", pfSign(pnlAb), invAb ? pctText(pnlAb/invAb) : "—") +
    tile("PNL realizado", pfSign(pnlCe), invCe ? pctText(pnlCe/invCe) + " sobre " + pfUsd(invCe) : "—") +
    tile("PNL total", pfSign(pnlTot), ce.length ? gan + " de " + ce.length + " cerradas en verde" : "—");

  pfMov(caja, invAb, valAb, pnlCe);

  $("pf-sub-ab").textContent = ab.length
    ? (pf.vista === "tabla" ? "Toca un encabezado para ordenar. " : "Verde claro: la posicion va ganando; rojo claro: va perdiendo. ") +
      "La barrita bajo cada inversion es su peso en tu capital; la etiqueta junto al activo es la senal del tablero y el simbolo abre sus velas."
    : "Todavia no hay posiciones abiertas.";

  pfAlerta(ab);
  pfTablaAb(ab);
  pfTablaCe(ce);

  pfCurva();
  pfPie(ce);
  pfRetro(ce);
  if (pf.graf && pf.velas) pfDibuja();
}

function pfAlerta(ab){
  var by = {};
  ab.forEach(function(r){
    var p = pfPx(r);
    if (p == null) return;
    var g = by[r.s] || (by[r.s] = { s:r.s, n:0, inv:0, pnl:0, q:0 });
    g.n++; g.inv += r.inversion; g.q += r.cantidad; g.pnl += r.cantidad * p - r.inversion;
  });
  var malos = Object.keys(by).map(function(k){ return by[k]; })
    .filter(function(g){ return g.n > 1 && g.pnl < 0; })
    .sort(function(a,b){ return a.pnl - b.pnl; });

  if (!malos.length){ $("pf-alerta").innerHTML = ""; return; }

  var exp = malos.reduce(function(a,g){ return a + g.inv; }, 0);
  var rojo = malos.reduce(function(a,g){ return a + g.pnl; }, 0);
  $("pf-alerta").innerHTML = '<div class="alerta"><b>Estas promediando a la baja en ' + malos.length +
    (malos.length === 1 ? " activo" : " activos") + '.</b> Son ' + pfUsd(exp) +
    ' comprometidos con ' + pfUsd(rojo).replace("-","−") + ' en contra. Cada compra nueva aqui baja tu promedio, pero tambien sube lo que arriesgas en una sola idea.' +
    '<ul>' + malos.map(function(g){
      return '<li><b>' + esc(g.s) + '</b> — ' + g.n + ' compras, ' + pfUsd(g.inv) +
        ' invertidos, promedio ' + fmtPrice(g.inv / g.q) + ', ' +
        '<span class="chg down">' + pctText(g.pnl / g.inv) + '</span></li>';
    }).join("") + '</ul></div>';
}

function pfCurva(){
  var box = $("pf-curva"), d = (pf.snap || []).slice().sort(function(a,b){ return a.d < b.d ? -1 : 1; });
  if (d.length < 2){
    box.innerHTML = '<p class="muted" style="margin:0">Guardo una foto del valor de la cuenta cada dia que abres esta pagina. ' +
      (d.length ? 'Llevo 1 dia registrado; con el de manana ya hay linea que dibujar.' : 'Todavia no hay ninguna.') + '</p>';
    $("pf-sub-curva").textContent = "—";
    return;
  }

  var W = Math.max(560, Math.min(1000, d.length * 26)), H = 220;
  var pT = 16, pB = 26, pL = 8, pR = 62;
  var plotW = W - pL - pR, plotH = H - pT - pB;
  var vals = [];
  d.forEach(function(r){ vals.push(r.v); vals.push(r.n); });
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  var span = (hi - lo) || (hi * 0.02) || 1;
  lo -= span * 0.12; hi += span * 0.12;
  var y = function(v){ return pT + plotH - ((v - lo) / (hi - lo)) * plotH; };
  var x = function(i){ return pL + (d.length === 1 ? plotW / 2 : (i * plotW) / (d.length - 1)); };

  var g = "";
  for (var k = 0; k <= 3; k++){
    var pv = lo + (hi - lo) * k / 3, yy = y(pv);
    g += '<line x1="' + pL + '" y1="' + yy.toFixed(1) + '" x2="' + (pL+plotW) + '" y2="' + yy.toFixed(1) + '" stroke="var(--rule)" stroke-width="0.7" stroke-dasharray="2 4"/>';
    g += '<text x="' + (pL+plotW+6) + '" y="' + (yy+3.5).toFixed(1) + '" font-size="10.5" fill="var(--soft)">' + pfUsd(pv) + '</text>';
  }
  var ruta = function(campo, col, dash){
    var p = "";
    d.forEach(function(r, i){ p += (i ? "L" : "M") + x(i).toFixed(1) + " " + y(r[campo]).toFixed(1) + " "; });
    return '<path d="' + p + '" fill="none" stroke="' + col + '" stroke-width="' + (dash ? 1.3 : 2) + '"' + (dash ? ' stroke-dasharray="5 4"' : '') + '/>';
  };
  g += ruta("n", "var(--soft)", true) + ruta("v", "var(--up)", false);
  d.forEach(function(r, i){
    g += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(r.v).toFixed(1) + '" r="2.6" fill="var(--up)"><title>' +
      fmtDate(r.d) + ' — cuenta ' + pfUsd(r.v) + ', aportado ' + pfUsd(r.n) + '</title></circle>';
  });
  var cada = Math.ceil(d.length / 7);
  d.forEach(function(r, i){
    if (i % cada && i !== d.length - 1) return;
    g += '<text x="' + x(i).toFixed(1) + '" y="' + (H-8) + '" text-anchor="middle" font-size="10" fill="var(--soft)">' +
      new Date(r.d + "T12:00:00").toLocaleDateString("es-MX",{day:"numeric",month:"short"}) + '</text>';
  });

  var ini = d[0], fin = d[d.length-1];
  $("pf-sub-curva").textContent = d.length + " dias registrados. Del " + fmtDate(ini.d) + " al " + fmtDate(fin.d) +
    " la cuenta paso de " + pfUsd(ini.v) + " a " + pfUsd(fin.v) + ".";
  box.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H +
    '" role="img" aria-label="Valor de la cuenta dia a dia contra lo aportado">' + g + '</svg>' +
    '<div class="lg"><span><i style="background:var(--up)"></i>Valor de la cuenta</span>' +
    '<span><i style="background:var(--soft)"></i>Aportado neto</span></div>';
}

function pfPasaFiltro(pnl, sim){
  var f = pf.filtro;
  if (f === "all") return true;
  if (f === "verde") return pnl != null && pnl > 0;
  if (f === "rojo") return pnl != null && pnl < 0;
  var g = pf.sig[sim];
  if (f === "compra") return !!g && g.level === 3;
  if (f === "retro") return !!g && g.level === 2;
  return true;
}

function pfOrdena(arr, ord){
  var k = ord.k, d = ord.dir;
  return arr.sort(function(a, b){
    var va = a[k], vb = b[k];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string") return va < vb ? -d : va > vb ? d : 0;
    return (va - vb) * d;
  });
}

function pfMarcaTh(id, ord){
  var th = $(id);
  if (!th) return;
  th.querySelectorAll(".sb").forEach(function(b){
    if (b.getAttribute("data-k") === ord.k) b.setAttribute("data-dir", ord.dir < 0 ? "desc" : "asc");
    else b.removeAttribute("data-dir");
  });
}

function pfPeso(inv, capital){
  if (!capital || capital <= 0) return "";
  var p = inv / capital;
  return '<div class="peso"><span class="bar' + (p >= 0.18 ? " alto" : "") + '"><i style="width:' + Math.min(100, p * 100).toFixed(1) + '%"></i></span>' +
    '<small>' + (p * 100).toFixed(1) + '%</small></div>';
}

function pfCnt(mostrados, total){
  $("pf-cnt").textContent = mostrados === total
    ? total + (total === 1 ? " posicion" : " posiciones")
    : "mostrando " + mostrados + " de " + total;
}

function pfTablaAb(ab){
  var filas = ab.map(function(r){
    var p = pfPx(r), val = p == null ? r.inversion : r.cantidad * p;
    return { id:r.id, s:r.s, tipo:r.tipo, fecha:r.fecha, inversion:r.inversion, cantidad:r.cantidad,
             compra:r.compra, px:p, valor:val, pnl: p == null ? null : val - r.inversion,
             pct: p == null ? null : (val - r.inversion) / r.inversion, n:1 };
  });

  if (pf.agrupar){
    var by = {};
    filas.forEach(function(f){
      var g = by[f.s];
      if (!g){ by[f.s] = { id:null, s:f.s, tipo:f.tipo, fecha:f.fecha, inversion:0, cantidad:0, px:f.px, n:0 }; g = by[f.s]; }
      g.inversion += f.inversion; g.cantidad += f.cantidad; g.n++;
      if (f.fecha > g.fecha) g.fecha = f.fecha;
    });
    filas = Object.keys(by).map(function(k){
      var g = by[k];
      g.compra = g.cantidad > 0 ? g.inversion / g.cantidad : 0;
      g.valor = g.px == null ? g.inversion : g.cantidad * g.px;
      g.pnl = g.px == null ? null : g.valor - g.inversion;
      g.pct = g.pnl == null ? null : g.pnl / g.inversion;
      return g;
    });
  }

  var total = filas.length;
  var capital = filas.reduce(function(a, f){ return a + f.inversion; }, 0);
  filas = filas.filter(function(f){ return pfPasaFiltro(f.pnl, f.s); });
  pfOrdena(filas, pf.ordAb);
  pfMarcaTh("pf-th-ab", pf.ordAb);
  pfCnt(filas.length, total);

  var tInv = 0, tVal = 0, tPnl = 0, hayPx = false;
  filas.forEach(function(f){ tInv += f.inversion; tVal += f.valor; if (f.pnl != null){ tPnl += f.pnl; hayPx = true; } });
  $("pf-tot-ab").innerHTML = filas.length ? '<tr><td class="lbl cab">' + (filas.length === total ? "Total" : "Total filtrado") + '</td><td></td>' +
    '<td data-l="Inversion">' + pfUsd(tInv) + '</td><td></td><td></td><td></td>' +
    '<td data-l="Valor">' + pfUsd(tVal) + '</td>' +
    '<td data-l="PNL">' + (hayPx ? pfSign(tPnl) : '<span class="muted">—</span>') + '</td>' +
    '<td data-l="%">' + (hayPx && tInv ? fmtPct(tPnl / tInv) : '<span class="muted">—</span>') + '</td><td></td></tr>' : "";

  $("pf-rows-ab").innerHTML = filas.length ? filas.map(function(f){
    var tono = f.pnl == null ? "" : (f.pnl > 0 ? " pos" : f.pnl < 0 ? " neg" : "");
    return '<tr class="' + tono.trim() + '"><td class="cab" style="text-align:left"><b class="sym" data-graf="' + esc(f.s) + '" data-gt="' + esc(f.tipo) + '">' + esc(f.s) + '</b>' + sgPill(f.s) +
      (f.n > 1 ? '<span class="agr">' + f.n + ' compras</span>' : '') +
      (f.tipo === "accion" ? ' <span class="muted">accion</span>' : '') + '</td>' +
      '<td data-l="Fecha">' + fmtDate(f.fecha) + '</td>' +
      '<td data-l="Inversion">' + pfUsd(f.inversion) + pfPeso(f.inversion, capital) + '</td>' +
      '<td data-l="Cantidad">' + fmtPrice(f.cantidad) + '</td>' +
      '<td data-l="Precio compra">' + fmtPrice(f.compra) + '</td>' +
      '<td data-l="Precio de mercado">' + (f.px == null ? '<span class="muted">—</span>' : '<span class="pxnow">' + fmtPrice(f.px) + '</span>') + '</td>' +
      '<td data-l="Valor">' + (f.px == null ? '<span class="muted">—</span>' : pfUsd(f.valor)) + '</td>' +
      '<td data-l="PNL">' + pfSign(f.pnl) + '</td>' +
      '<td data-l="%">' + (f.pct == null ? '<span class="muted">—</span>' : fmtPct(f.pct)) + '</td>' +
      '<td>' + (f.id == null
        ? '<span class="muted" style="font-size:12px">agrupado</span>'
        : '<div class="pact"><button class="ghost" data-act="cerrar" data-id="' + esc(f.id) + '">Cerrar</button>' +
          '<button class="ghost" data-act="editar" data-id="' + esc(f.id) + '">Editar</button>' +
          '<button class="ghost" data-act="borrar" data-id="' + esc(f.id) + '">Borrar</button></div>') + '</td></tr>';
  }).join("") : '<tr><td colspan="10" class="muted" style="text-align:left">' +
      (total ? "Ninguna posicion cumple este filtro." : 'Sin posiciones abiertas. Pulsa "Agregar posicion".') + '</td></tr>';
}

function pfTablaCe(ce){
  var filas = ce.map(function(r){
    var p = pfPx(r), pn = r.cantidad * r.cierre - r.inversion;
    return { id:r.id, s:r.s, tipo:r.tipo, fecha:(r.fechaCierre || r.fecha), inversion:r.inversion, cantidad:r.cantidad,
             compra:r.compra, cierre:r.cierre, pnl:pn, pct:pn / r.inversion, px:p,
             dif: p == null ? null : p / r.cierre - 1, n:1 };
  });

  if (pf.agrupar){
    var by = {};
    filas.forEach(function(f){
      var g = by[f.s];
      if (!g){ by[f.s] = { id:null, s:f.s, tipo:f.tipo, fecha:f.fecha, inversion:0, cantidad:0, pnl:0, px:f.px, wC:0, wV:0, n:0 }; g = by[f.s]; }
      g.inversion += f.inversion; g.cantidad += f.cantidad; g.pnl += f.pnl; g.n++;
      g.wC += f.compra * f.cantidad; g.wV += f.cierre * f.cantidad;
      if (f.fecha > g.fecha) g.fecha = f.fecha;
    });
    filas = Object.keys(by).map(function(k){
      var g = by[k];
      g.compra = g.cantidad > 0 ? g.wC / g.cantidad : 0;
      g.cierre = g.cantidad > 0 ? g.wV / g.cantidad : 0;
      g.pct = g.inversion > 0 ? g.pnl / g.inversion : null;
      g.dif = (g.px == null || !g.cierre) ? null : g.px / g.cierre - 1;
      return g;
    });
  }

  var total = filas.length;
  filas = filas.filter(function(f){ return pfPasaFiltro(f.pnl, f.s); });
  pfOrdena(filas, pf.ordCe);
  pfMarcaTh("pf-th-ce", pf.ordCe);

  var cInv = 0, cPnl = 0, cGan = 0;
  filas.forEach(function(f){ cInv += f.inversion; cPnl += f.pnl; if (f.pnl > 0) cGan++; });
  $("pf-tot-ce").innerHTML = filas.length ? '<tr><td class="lbl cab">' + (filas.length === total ? "Total" : "Total filtrado") +
    ' <span style="font-weight:400">· ' + cGan + ' de ' + filas.length + ' en verde</span></td><td></td>' +
    '<td data-l="Inversion">' + pfUsd(cInv) + '</td><td></td><td></td>' +
    '<td data-l="PNL">' + pfSign(cPnl) + '</td>' +
    '<td data-l="%">' + (cInv ? fmtPct(cPnl / cInv) : '<span class="muted">—</span>') + '</td><td></td><td></td><td></td></tr>' : "";

  $("pf-rows-ce").innerHTML = filas.length ? filas.map(function(f){
    var tono = f.pnl > 0 ? " pos" : f.pnl < 0 ? " neg" : "";
    return '<tr class="' + tono.trim() + '"><td class="cab" style="text-align:left"><b class="sym" data-graf="' + esc(f.s) + '" data-gt="' + esc(f.tipo) + '">' + esc(f.s) + '</b>' + sgPill(f.s) +
      (f.n > 1 ? '<span class="agr">' + f.n + ' ops</span>' : '') + '</td>' +
      '<td data-l="Fecha de venta">' + fmtDate(f.fecha) + '</td>' +
      '<td data-l="Inversion">' + pfUsd(f.inversion) + '</td>' +
      '<td data-l="Precio compra">' + fmtPrice(f.compra) + '</td>' +
      '<td data-l="Precio venta">' + fmtPrice(f.cierre) + '</td>' +
      '<td data-l="PNL">' + pfSign(f.pnl) + '</td>' +
      '<td data-l="%">' + (f.pct == null ? '<span class="muted">—</span>' : fmtPct(f.pct)) + '</td>' +
      '<td data-l="Precio de mercado">' + (f.px == null ? '<span class="muted">—</span>' : '<span class="pxnow">' + fmtPrice(f.px) + '</span>') + '</td>' +
      '<td data-l="Mercado vs. tu venta">' + (f.dif == null ? '<span class="muted">—</span>' : '<span class="chg ' + (f.dif <= 0 ? "up" : "down") + '">' + pctText(f.dif) + '</span>') + '</td>' +
      '<td>' + (f.id == null
        ? '<span class="muted" style="font-size:12px">agrupado</span>'
        : '<div class="pact"><button class="ghost" data-act="editar" data-id="' + esc(f.id) + '">Editar</button>' +
          '<button class="ghost" data-act="borrar" data-id="' + esc(f.id) + '">Borrar</button></div>') + '</td></tr>';
  }).join("") : '<tr><td colspan="10" class="muted" style="text-align:left">' +
      (total ? "Ninguna cerrada cumple este filtro." : "Sin posiciones cerradas.") + '</td></tr>';
}

function tile(k, v, x){ return tileC(k, v, x, ""); }
function tileC(k, v, x, cls){ return '<div class="tile' + (cls ? " " + cls : "") + '"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div><div class="x">' + x + '</div></div>'; }

function pfCaja(invAb, pnlCe){
  var saldo = { Spot: 0 }, dep = 0, ret = 0;
  var add = function(c, n){ c = c || "Spot"; saldo[c] = (saldo[c] || 0) + n; };
  pf.mov.forEach(function(m){
    if (m.tipo === "retiro"){ ret += m.monto; add(m.de, -m.monto); }
    else if (m.tipo === "transferencia"){ add(m.de, -m.monto); add(m.a, m.monto); }
    else { dep += m.monto; add(m.a, m.monto); }
  });
  add("Spot", pnlCe - invAb);
  var total = 0;
  Object.keys(saldo).forEach(function(k){ total += saldo[k]; });
  return { saldo: saldo, dep: dep, ret: ret, neto: dep - ret, total: total };
}

function pfCarteras(){
  var set = { Spot: 1, Futuros: 1 };
  pf.mov.forEach(function(m){ if (m.de) set[m.de] = 1; if (m.a) set[m.a] = 1; });
  return Object.keys(set);
}

function pfMov(caja, invAb, valAb, pnlCe){
  var ms = pf.mov.slice().sort(function(a,b){ return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0; });

  $("carteras").innerHTML = pfCarteras().map(function(c){ return '<option value="' + esc(c) + '">'; }).join("");

  $("pf-sub-mov").textContent = ms.length
    ? "Depositos " + pfUsd(caja.dep) + " · retiros " + pfUsd(caja.ret) + " · aportado neto " + pfUsd(caja.neto) + ". El rendimiento se mide contra ese neto; las transferencias entre tus carteras no lo cambian."
    : "Registra aqui cada deposito, retiro y transferencia para medir el rendimiento real de la cuenta.";

  var ks = Object.keys(caja.saldo);
  $("pf-carts").innerHTML = ks.length ? ks.map(function(c){
    var v = caja.saldo[c];
    return '<span class="cart' + (v < -PF_TOL ? " neg" : "") + '">' + esc(c) + '<b>' + (Math.abs(v) < PF_TOL ? pfUsd(0) : pfUsd(v)) + '</b></span>';
  }).join("") + '<span class="cart">Efectivo total<b>' + pfUsd(caja.total) + '</b></span>' : "";

  var faltan = -(caja.total);
  $("pf-aviso").innerHTML = caja.total < -PF_TOL
    ? '<div class="aviso"><b>Faltan ' + pfUsd(faltan) + ' por explicar.</b> Aportaste ' + pfUsd(caja.neto) +
      ' netos y llevas ' + pfUsd(pnlCe) + ' de ganancia realizada, o sea ' + pfUsd(caja.neto + pnlCe) +
      ' disponibles. Pero tienes ' + pfUsd(invAb) + ' en posiciones abiertas mas el efectivo parado en tus carteras. El efectivo no puede ser negativo, asi que falta registrar un deposito de alrededor de ' +
      pfUsd(faltan) + ', o alguna posicion cerrada quedo capturada con una inversion mayor a la real.</div>'
    : "";

  var acum = 0;
  $("pf-rows-mov").innerHTML = ms.length ? ms.map(function(m){
    var tra = m.tipo === "transferencia", re = m.tipo === "retiro";
    if (!tra) acum += (re ? -m.monto : m.monto);
    var ruta = tra ? esc(m.de) + " → " + esc(m.a) : re ? esc(m.de || "Spot") + " → banco" : "banco → " + esc(m.a || "Spot");
    return '<tr><td style="text-align:left">' + fmtDate(m.fecha) + '</td>' +
      '<td style="text-align:left"><span class="pill ' + (tra ? "tra" : re ? "ret" : "dep") + '">' + (tra ? "Transferencia" : re ? "Retiro" : "Deposito") + '</span></td>' +
      '<td>' + (tra ? '<span class="muted">' + pfUsd(m.monto) + '</span>' : '<span class="chg ' + (re ? "down" : "up") + '">' + (re ? "−" : "+") + pfUsd(m.monto) + '</span>') + '</td>' +
      '<td style="text-align:left"><span class="ruta">' + ruta + '</span></td>' +
      '<td style="text-align:left" class="muted">' + esc(m.nota || "—") + '</td>' +
      '<td>' + (tra ? '<span class="muted">—</span>' : pfUsd(acum)) + '</td>' +
      '<td><div class="pact"><button class="ghost" data-mact="editar" data-id="' + esc(m.id) + '">Editar</button>' +
      '<button class="ghost" data-mact="borrar" data-id="' + esc(m.id) + '">Borrar</button></div></td></tr>';
  }).join("") : '<tr><td colspan="7" class="muted" style="text-align:left">Sin movimientos. Pulsa "Deposito / retiro".</td></tr>';
}

function pfMTipoToggle(){
  var t = $("m-tipo").value;
  $("m-wrap-de").hidden = (t === "deposito");
  $("m-wrap-a").hidden = (t === "retiro");
}
function pfMFormShow(m){
  pf.medit = m ? m.id : null;
  $("m-tipo").value = m ? m.tipo : "deposito";
  $("m-fecha").value = m ? m.fecha : new Date().toISOString().slice(0,10);
  $("m-monto").value = m ? m.monto : "";
  $("m-de").value = m && m.de ? m.de : "Spot";
  $("m-a").value = m && m.a ? m.a : (m && m.tipo === "transferencia" ? "Futuros" : "Spot");
  $("m-nota").value = m ? (m.nota || "") : "";
  pfMTipoToggle();
  $("pf-mform").classList.add("show");
  $("m-monto").focus();
}
function pfMFormHide(){ $("pf-mform").classList.remove("show"); pf.medit = null; }

function pfMFormSave(){
  var monto = parseFloat($("m-monto").value);
  if (!isFinite(monto) || monto <= 0){ pfMsg("Pon un monto mayor a cero."); return; }
  var t = $("m-tipo").value;
  var de = ($("m-de").value || "Spot").trim(), a = ($("m-a").value || "Spot").trim();
  if (t === "transferencia" && de.toLowerCase() === a.toLowerCase()){ pfMsg("La transferencia necesita dos carteras distintas."); return; }
  var m = { id: pf.medit || ("m" + Date.now()), tipo: t, fecha: $("m-fecha").value, monto: Math.abs(monto), nota: $("m-nota").value };
  if (t !== "deposito") m.de = de;
  if (t !== "retiro") m.a = a;
  var movs = pf.mov.filter(function(x){ return x.id !== m.id; });
  movs.push(m);
  pfMFormHide();
  pfSave(null, movs);
}

function pfMBorrar(id){
  var m = pf.mov.find(function(x){ return x.id === id; });
  if (!m) return;
  if (!confirm("Borrar el " + (m.tipo === "retiro" ? "retiro" : m.tipo === "transferencia" ? "movimiento" : "deposito") + " de " + pfUsd(m.monto) + " del " + fmtDate(m.fecha) + "?")) return;
  pfSave(null, pf.mov.filter(function(x){ return x.id !== id; }));
}

function emaArr(v, n){
  var k = 2/(n+1), out = [], prev = null;
  for (var i=0;i<v.length;i++){
    if (i < n-1){ out.push(null); continue; }
    if (prev === null){ var sum=0; for (var j=0;j<n;j++) sum+=v[j]; prev = sum/n; }
    else prev = v[i]*k + prev*(1-k);
    out.push(prev);
  }
  return out;
}

function pfGrafica(sim, tipo){
  if (pf.graf === sim){ pfCierraGrafica(); return; }
  pf.graf = sim; pf.grafTipo = tipo || "cripto"; pf.velas = null;
  $("pf-graf").classList.add("show");
  pfPintaMarco("Cargando velas…");
  pfCargaVelas();
  $("pf-graf").scrollIntoView({block:"nearest", behavior:"smooth"});
}
function pfCierraGrafica(){ pf.graf = null; pf.velas = null; $("pf-graf").classList.remove("show"); $("pf-graf").innerHTML = ""; }

function pfPintaMarco(msg){
  var tfb = ["1d","4h"].map(function(t){
    return '<button class="ghost" data-gtf="' + t + '" aria-pressed="' + (pf.gtf===t?"true":"false") + '">' + (t==="1d"?"1D":"4H") + '</button>';
  }).join("");
  $("pf-graf").innerHTML =
    '<div class="ghead"><div class="gtitle">' + esc(pf.graf) + '<small id="g-src"></small></div>' +
    '<div class="gright">' + tfb + '<button class="ghost" id="g-cerrar">Cerrar</button></div></div>' +
    '<p class="gsub" id="g-sub">' + esc(msg || "") + '</p><div class="gwrap" id="g-body"></div>';
}

function pfCargaVelas(){
  var sim = pf.graf, tf = pf.gtf;
  fetch("/api/portafolio/velas?tipo=" + encodeURIComponent(pf.grafTipo) + "&tf=" + tf + "&s=" + encodeURIComponent(sim), {cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (pf.graf !== sim || pf.gtf !== tf) return;
      if (!j || !j.velas || !j.velas.length){
        pf.velas = null;
        $("g-body").innerHTML = '<p class="muted" style="margin:0">No encontre velas para ' + esc(sim) + ' en este exchange.</p>';
        $("g-sub").textContent = "";
        return;
      }
      pf.velas = j.velas; pf.velasSrc = j.src;
      pfDibuja();
    })
    .catch(function(){ if (pf.graf === sim) $("g-body").innerHTML = '<p class="muted" style="margin:0">Sin conexion.</p>'; });
}

function pfDibuja(){
  if (!pf.graf || !pf.velas || !$("g-body")) return;
  var sim = pf.graf, v = pf.velas, n = v.length;
  var mias = pf.pos.filter(function(r){ return r.s === sim; });
  var ab = mias.filter(function(r){ return r.estado !== "cerrada"; });

  var qTot = 0, cTot = 0;
  ab.forEach(function(r){ qTot += r.cantidad; cTot += r.inversion; });
  var prom = qTot > 0 ? cTot / qTot : null;
  var hoy = pf.px[sim] != null ? pf.px[sim] : v[n-1].c;

  var t0 = v[0].t, paso = n > 1 ? (v[1].t - v[0].t) : 86400000;
  var idxDe = function(iso){
    if (!iso) return -1;
    var ts = Date.parse(iso + "T12:00:00Z");
    if (!isFinite(ts)) return -1;
    var i = Math.round((ts - t0) / paso);
    return (i >= 0 && i < n) ? i : -1;
  };
  var marcas = [];
  mias.forEach(function(r){
    var ic = idxDe(r.fecha);
    if (ic >= 0) marcas.push({ i: ic, p: r.compra, tipo: "B", fecha: r.fecha, q: r.cantidad, inv: r.inversion });
    if (r.estado === "cerrada"){
      var iv = idxDe(r.fechaCierre || r.fecha);
      if (iv >= 0) marcas.push({ i: iv, p: r.cierre, tipo: "S", fecha: r.fechaCierre || r.fecha, q: r.cantidad, inv: r.inversion });
    }
  });

  var W = Math.max(720, Math.min(1100, n * 9)), H = 330;
  var pT = 16, pB = 26, pL = 6, pR = 66;
  var plotW = W - pL - pR, plotH = H - pT - pB;

  var lo = Infinity, hi = -Infinity;
  v.forEach(function(c){ if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; });
  marcas.forEach(function(m){ if (m.p < lo) lo = m.p; if (m.p > hi) hi = m.p; });
  if (prom != null){ if (prom < lo) lo = prom; if (prom > hi) hi = prom; }
  if (hoy < lo) lo = hoy;
  if (hoy > hi) hi = hoy;
  var span = (hi - lo) || (hi * 0.02) || 1;
  lo -= span * 0.08; hi += span * 0.08;
  var y = function(p){ return pT + plotH - ((p - lo) / (hi - lo)) * plotH; };
  var x = function(i){ return pL + (i + 0.5) * (plotW / n); };
  var cw = Math.max(1.6, Math.min(11, plotW / n * 0.62));

  var cl = v.map(function(c){ return c.c; });
  var e20 = emaArr(cl, 20), e50 = emaArr(cl, 50);
  var linea = function(arr, col){
    var d = "", started = false;
    for (var i=0;i<arr.length;i++){
      if (arr[i] == null) continue;
      d += (started ? "L" : "M") + x(i).toFixed(1) + " " + y(arr[i]).toFixed(1) + " ";
      started = true;
    }
    return d ? '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.3" opacity="0.85"/>' : "";
  };

  var g = "";
  for (var k=0;k<=4;k++){
    var pv = lo + (hi - lo) * k / 4, yy = y(pv);
    g += '<line x1="' + pL + '" y1="' + yy.toFixed(1) + '" x2="' + (pL+plotW) + '" y2="' + yy.toFixed(1) + '" stroke="var(--rule)" stroke-width="0.7" stroke-dasharray="2 4"/>';
    g += '<text x="' + (pL+plotW+6) + '" y="' + (yy+3.5).toFixed(1) + '" font-size="10.5" fill="var(--soft)">' + fmtPrice(pv) + '</text>';
  }
  v.forEach(function(c, i){
    var up = c.c >= c.o, col = up ? "var(--up)" : "var(--down)";
    var xc = x(i);
    g += '<line x1="' + xc.toFixed(1) + '" y1="' + y(c.h).toFixed(1) + '" x2="' + xc.toFixed(1) + '" y2="' + y(c.l).toFixed(1) + '" stroke="' + col + '" stroke-width="1"/>';
    var yo = y(c.o), yc = y(c.c), top = Math.min(yo,yc), alto = Math.max(1, Math.abs(yc-yo));
    g += '<rect x="' + (xc-cw/2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + cw.toFixed(1) + '" height="' + alto.toFixed(1) + '" fill="' + col + '" opacity="0.9"/>';
  });
  g += linea(e20, "var(--e20)") + linea(e50, "var(--e50)");

  if (prom != null){
    g += '<line x1="' + pL + '" y1="' + y(prom).toFixed(1) + '" x2="' + (pL+plotW) + '" y2="' + y(prom).toFixed(1) + '" stroke="var(--ath)" stroke-width="1.4" stroke-dasharray="6 4"/>';
  }
  g += '<line x1="' + pL + '" y1="' + y(hoy).toFixed(1) + '" x2="' + (pL+plotW) + '" y2="' + y(hoy).toFixed(1) + '" stroke="var(--ink)" stroke-width="1" opacity="0.55"/>';
  g += '<rect x="' + (pL+plotW+2) + '" y="' + (y(hoy)-8).toFixed(1) + '" width="62" height="16" rx="3" fill="var(--ink)"/>';
  g += '<text x="' + (pL+plotW+6) + '" y="' + (y(hoy)+3.5).toFixed(1) + '" font-size="10.5" fill="var(--bg)" font-weight="600">' + fmtPrice(hoy) + '</text>';

  marcas.forEach(function(m){
    var xc = x(m.i), yc = y(m.p), esB = m.tipo === "B";
    var col = esB ? "var(--up)" : "var(--down)";
    var tri = esB
      ? (xc) + "," + (yc+4) + " " + (xc-5.5) + "," + (yc+13) + " " + (xc+5.5) + "," + (yc+13)
      : (xc) + "," + (yc-4) + " " + (xc-5.5) + "," + (yc-13) + " " + (xc+5.5) + "," + (yc-13);
    g += '<circle cx="' + xc.toFixed(1) + '" cy="' + yc.toFixed(1) + '" r="2.6" fill="' + col + '"/>';
    g += '<polygon points="' + tri + '" fill="' + col + '"><title>' + m.tipo + ' ' + esc(sim) + ' · ' + fmtDate(m.fecha) + ' · ' + fmtPrice(m.p) + ' · ' + pfUsd(m.inv) + '</title></polygon>';
    g += '<text x="' + xc.toFixed(1) + '" y="' + (esB ? yc+25 : yc-16).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="700" fill="' + col + '">' + m.tipo + '</text>';
  });

  var cada = Math.ceil(n / 8);
  v.forEach(function(c, i){
    if (i % cada) return;
    var d = new Date(c.t);
    g += '<text x="' + x(i).toFixed(1) + '" y="' + (H-8) + '" text-anchor="middle" font-size="10" fill="var(--soft)">' + d.toLocaleDateString("es-MX",{day:"numeric",month:"short"}) + '</text>';
  });

  var sg = pf.sig[sim], sgHtml = "", stats = [];
  if (prom != null){
    var difP = hoy / prom - 1;
    stats.push('<span><b style="color:var(--ath)">Tu promedio ' + fmtPrice(prom) + '</b> <span class="chg ' + (difP >= 0 ? "up" : "down") + '">' + pctText(difP) + '</span></span>');
  }
  if (sg){
    stats.push('<span>RSI <b>' + (sg.rsi == null ? "—" : sg.rsi.toFixed(0)) + '</b></span>');
    stats.push('<span>vs. EMA 20 <b>' + pctText(sg.dist) + '</b></span>');
    stats.push('<span>desde su maximo de 90 dias <b>' + (sg.desdeMax == null ? "—" : pctText(sg.desdeMax)) + '</b></span>');
  }
  if (stats.length || sg){
    sgHtml = '<div class="gsen">' +
      (sg ? '<span class="big ' + sgClase(sg.level) + '">' + esc(sg.label) + ' · ' + sg.pts + '/5</span>' : '') +
      '<span class="gchk">' + stats.join("") + '</span></div>';
    if (sg){
      var nom = { tendencia:"Tendencia alcista", rsi:"RSI 50-65", cerca:"Cerca de la EMA 20", volumen:"Volumen 1.2x", espacio:"10-40% bajo su maximo de 90 dias" };
      sgHtml += '<div class="gchk" style="margin:0 0 10px">' + Object.keys(nom).map(function(kk){
        return '<span class="' + (sg.checks[kk] ? "ok" : "no") + '">' + (sg.checks[kk] ? "✓ " : "· ") + nom[kk] + '</span>';
      }).join("") + '</div>';
    }
  }

  $("g-body").innerHTML = sgHtml + '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Velas de ' + esc(sim) + ' con tus compras y ventas">' + g + '</svg>' +
    '<div class="glg"><span><i style="background:var(--up)"></i>B = tu compra</span><span><i style="background:var(--down)"></i>S = tu venta</span>' +
    (prom != null ? '<span><i style="background:var(--ath)"></i>Tu promedio de entrada</span>' : '') +
    '<span><i style="background:var(--e20)"></i>EMA 20</span><span><i style="background:var(--e50)"></i>EMA 50</span></div>';

  $("g-src").textContent = (pf.velasSrc || "") + " · " + (pf.gtf === "4h" ? "velas de 4 horas" : "velas diarias");

  var nB = marcas.filter(function(m){ return m.tipo === "B"; }).length;
  var nS = marcas.length - nB;
  var txt = nB + (nB===1?" compra":" compras") + " y " + nS + (nS===1?" venta":" ventas") + " en pantalla.";
  if (prom != null){
    txt += " Mercado en " + fmtPrice(hoy) + ".";
  } else if (mias.length) {
    txt += " No tienes posicion abierta en " + sim + "; el mercado cotiza en " + fmtPrice(hoy) + ".";
  }
  $("g-sub").textContent = txt;
}

var PIE_COLORS = ["#3B7DD8","#16A085","#E8A33D","#B15CD1","#D9534F","#2FA4A0","#7A8CD9","#C77D3B","#5BA85B","#D35B92","#6C7BE0","#A0894A"];

function pfPie(ce){
  var box = $("pf-pie");
  var by = {};
  ce.forEach(function(r){
    var pn = r.cantidad * r.cierre - r.inversion;
    if (!by[r.s]) by[r.s] = { s: r.s, pnl: 0, ops: 0, inv: 0 };
    by[r.s].pnl += pn; by[r.s].ops++; by[r.s].inv += r.inversion;
  });
  var all = Object.keys(by).map(function(k){ return by[k]; });
  var pos = all.filter(function(x){ return x.pnl > 0; }).sort(function(a,b){ return b.pnl - a.pnl; });
  var neg = all.filter(function(x){ return x.pnl <= 0; });
  if (!pos.length){ box.innerHTML = '<p class="muted" style="margin:0">Todavia no hay criptos con ganancia realizada.</p>'; $("pf-sub-pie").textContent = "—"; return; }

  var total = pos.reduce(function(a,b){ return a + b.pnl; }, 0);
  var perdido = neg.reduce(function(a,b){ return a + b.pnl; }, 0);
  $("pf-sub-pie").textContent = "Reparto de " + pfUsd(total) + " de ganancia realizada entre " + pos.length +
    (pos.length === 1 ? " cripto" : " criptos") +
    (neg.length ? ". Fuera del pastel: " + neg.map(function(x){ return x.s; }).join(", ") + " con " + pfUsd(perdido) + " en rojo." : ".");

  var S = 250, cx = S/2, cy = S/2, R = 104, r0 = 62;
  var a = -Math.PI/2, g = "";
  var pt = function(ang, rad){ return [(cx + rad*Math.cos(ang)).toFixed(2), (cy + rad*Math.sin(ang)).toFixed(2)]; };

  pos.forEach(function(x, i){
    var frac = x.pnl / total, a2 = a + frac * Math.PI * 2;
    var col = PIE_COLORS[i % PIE_COLORS.length];
    x.col = col; x.frac = frac;
    if (frac > 0.9999){
      g += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((R+r0)/2) + '" fill="none" stroke="' + col + '" stroke-width="' + (R-r0) + '"><title>' + esc(x.s) + ' — ' + pfUsd(x.pnl) + '</title></circle>';
    } else {
      var big = frac > 0.5 ? 1 : 0;
      var o1 = pt(a, R), o2 = pt(a2, R), i1 = pt(a2, r0), i2 = pt(a, r0);
      g += '<path d="M ' + o1[0] + ' ' + o1[1] + ' A ' + R + ' ' + R + ' 0 ' + big + ' 1 ' + o2[0] + ' ' + o2[1] +
           ' L ' + i1[0] + ' ' + i1[1] + ' A ' + r0 + ' ' + r0 + ' 0 ' + big + ' 0 ' + i2[0] + ' ' + i2[1] + ' Z" fill="' + col +
           '" stroke="var(--panel)" stroke-width="2"><title>' + esc(x.s) + ' — ' + pfUsd(x.pnl) + ' (' + (frac*100).toFixed(1) + '% de la ganancia)</title></path>';
    }
    a = a2;
  });

  g += '<text class="t" x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" font-size="22" fill="var(--up)">' + pfUsd(total) + '</text>';
  g += '<text x="' + cx + '" y="' + (cy + 15) + '" text-anchor="middle" font-size="11.5" fill="var(--soft)">ganancia realizada</text>';

  var list = pos.map(function(x){
    return '<i style="background:' + x.col + '"></i>' +
      '<span class="nm">' + esc(x.s) + ' <span class="muted" style="font-weight:400">(' + x.ops + (x.ops === 1 ? " op" : " ops") + ')</span></span>' +
      '<span class="vl">' + pfUsd(x.pnl) + '</span>' +
      '<span class="sh">' + (x.frac*100).toFixed(1) + '%</span>';
  }).join("");

  box.innerHTML = '<div class="pie"><svg width="' + S + '" height="' + S + '" viewBox="0 0 ' + S + ' ' + S +
    '" role="img" aria-label="Reparto de la ganancia realizada por cripto">' + g + '</svg>' +
    '<div class="plist">' + list + '</div></div>';
}

function pfRetro(ce){
  var box = $("pf-retro");
  var rows = ce.map(function(r){ var p = pfPx(r); return p == null ? null : { s: r.s, f: r.fechaCierre || r.fecha, d: p / r.cierre - 1, cierre: r.cierre, hoy: p }; })
                .filter(Boolean)
                .sort(function(a,b){ return a.d - b.d; });
  if (!rows.length){ box.innerHTML = '<p class="muted" style="margin:0">Sin precios en vivo para comparar todavia.</p>'; $("pf-sub-re").textContent = "—"; return; }

  var bien = rows.filter(function(r){ return r.d <= 0; }).length;
  $("pf-sub-re").textContent = "En " + bien + " de " + rows.length + " ventas el mercado esta hoy por debajo de tu precio de salida. Barras a la izquierda: el activo retrocedio despues de que vendiste. A la derecha: siguio subiendo sin ti.";

  var W = 760, rowH = 22, padT = 28, padB = 26, padL = 92, padR = 54;
  var H = padT + rows.length * rowH + padB;
  var mx = Math.max(0.05, Math.max.apply(null, rows.map(function(r){ return Math.abs(r.d); })));
  mx = Math.ceil(mx * 20) / 20;
  var cx = padL + (W - padL - padR) / 2, half = (W - padL - padR) / 2;
  var x = function(d){ return cx + (d / mx) * half; };

  var g = "";
  var ticks = [-mx, -mx/2, 0, mx/2, mx];
  ticks.forEach(function(t){
    g += '<line x1="' + x(t).toFixed(1) + '" y1="' + (padT - 8) + '" x2="' + x(t).toFixed(1) + '" y2="' + (H - padB + 2) + '" stroke="var(--rule)" stroke-width="' + (t === 0 ? 1.4 : 0.8) + '"' + (t === 0 ? '' : ' stroke-dasharray="3 3"') + '/>';
    g += '<text x="' + x(t).toFixed(1) + '" y="' + (H - padB + 16) + '" text-anchor="middle" font-size="10.5" fill="var(--soft)">' + (t*100).toFixed(0) + '%</text>';
  });

  rows.forEach(function(r, i){
    var y = padT + i * rowH, h = 13, xa = x(0), xb = x(r.d);
    var col = r.d <= 0 ? "var(--up)" : "var(--down)";
    g += '<text x="' + (padL - 8) + '" y="' + (y + 10) + '" text-anchor="end" font-size="11" fill="var(--ink)">' + esc(r.s) + '</text>';
    g += '<rect x="' + Math.min(xa,xb).toFixed(1) + '" y="' + (y + 1) + '" width="' + Math.max(1.5, Math.abs(xb-xa)).toFixed(1) + '" height="' + h + '" rx="2.5" fill="' + col + '" opacity="0.85"><title>' + esc(r.s) + ' — vendiste en ' + fmtPrice(r.cierre) + ', mercado en ' + fmtPrice(r.hoy) + ' (' + pctText(r.d) + ')</title></rect>';
    g += '<text x="' + (xb + (r.d <= 0 ? -6 : 6)).toFixed(1) + '" y="' + (y + 11) + '" text-anchor="' + (r.d <= 0 ? "end" : "start") + '" font-size="10.5" fill="var(--soft)">' + pctText(r.d) + '</text>';
  });

  g += '<text x="' + (cx - 10) + '" y="' + (padT - 14) + '" text-anchor="end" font-size="11" fill="var(--soft)">← retrocedio</text>';
  g += '<text x="' + (cx + 10) + '" y="' + (padT - 14) + '" text-anchor="start" font-size="11" fill="var(--soft)">siguio subiendo →</text>';

  box.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Precio de mercado contra tu precio de venta, por posicion cerrada">' + g + '</svg>' +
    '<div class="lg"><span><i style="background:var(--up)"></i>Vendiste arriba del precio de mercado</span><span><i style="background:var(--down)"></i>El activo siguio subiendo despues de tu venta</span></div>';
}

$("pf-entrar").addEventListener("click", pfLogin);
$("pf-pin").addEventListener("keydown", function(e){ if (e.key === "Enter") pfLogin(); });
$("pf-nueva").addEventListener("click", function(){ pfMFormHide(); pfFormShow(null); });
$("pf-movnueva").addEventListener("click", function(){ pfFormHide(); pfMFormShow(null); });
$("m-guardar").addEventListener("click", pfMFormSave);
$("m-cancelar").addEventListener("click", pfMFormHide);
$("m-tipo").addEventListener("change", pfMTipoToggle);
$("pf-rows-mov").addEventListener("click", function(e){
  var b = e.target.closest("button[data-mact]");
  if (!b) return;
  var id = b.getAttribute("data-id");
  if (b.getAttribute("data-mact") === "editar") pfMFormShow(pf.mov.find(function(x){ return x.id === id; }));
  else pfMBorrar(id);
});
$("pf-recargar").addEventListener("click", function(){ pfLoad(); });
$("pf-salir").addEventListener("click", function(){ fetch("/api/portafolio/salir",{method:"POST"}).then(function(){ pf.auth = false; pf.pos = []; pfCierraGrafica(); pfShow(); }); });
$("f-guardar").addEventListener("click", pfFormSave);
$("f-cancelar").addEventListener("click", pfFormHide);
$("f-estado").addEventListener("change", pfEstadoToggle);
function pfNum(id){ var v = parseFloat($(id).value); return isFinite(v) ? v : null; }
function pfCalc(){
  var inv = pfNum("f-inv"), cant = pfNum("f-cant"), compra = pfNum("f-compra");
  if (compra == null || compra <= 0) return;
  if (pf.fUlt === "inv"){
    if (inv != null && inv > 0) $("f-cant").value = parseFloat((inv / compra).toFixed(8));
  } else {
    if (cant != null && cant > 0) $("f-inv").value = parseFloat((cant * compra).toFixed(2));
  }
}
$("f-inv").addEventListener("input", function(){ pf.fUlt = "inv"; pfCalc(); });
$("f-cant").addEventListener("input", function(){ pf.fUlt = "cant"; pfCalc(); });
$("f-compra").addEventListener("input", pfCalc);
$("f-s").addEventListener("input", pfPrecioDebounce);
$("f-s").addEventListener("change", pfPrecioVivo);
$("f-tipo").addEventListener("change", pfPrecioVivo);
$("pf-graf").addEventListener("click", function(e){
  var c = e.target.closest("#g-cerrar");
  if (c){ pfCierraGrafica(); return; }
  var t = e.target.closest("button[data-gtf]");
  if (!t) return;
  pf.gtf = t.getAttribute("data-gtf");
  pfPintaMarco("Cargando velas…");
  pfCargaVelas();
});
document.addEventListener("click", function(e){
  var b = e.target.closest("button[data-px]");
  if (!b || pf.pxForm == null) return;
  $(b.getAttribute("data-px") === "venta" ? "f-cierre" : "f-compra").value = pf.pxForm;
  pfCalc();
});
function pfClicks(e){
  var sy = e.target.closest("[data-graf]");
  if (sy){ pfGrafica(sy.getAttribute("data-graf"), sy.getAttribute("data-gt")); return; }
  var b = e.target.closest("button[data-act]");
  if (!b) return;
  var id = b.getAttribute("data-id"), act = b.getAttribute("data-act");
  if (act === "editar") pfFormShow(pf.pos.find(function(x){ return x.id === id; }));
  else if (act === "borrar") pfBorrar(id);
  else if (act === "cerrar") pfCerrar(id);
}
$("pf-rows-ab").addEventListener("click", pfClicks);
$("pf-rows-ce").addEventListener("click", pfClicks);
function pfOrdClick(e, ord){
  var b = e.target.closest(".sb");
  if (!b) return;
  var k = b.getAttribute("data-k");
  if (ord.k === k) ord.dir *= -1;
  else { ord.k = k; ord.dir = (k === "s" || k === "fecha") ? 1 : -1; }
  var sel = $("pf-orden");
  if (sel && ord === pf.ordAb) sel.value = ord.k;
  pfRender();
}
$("pf-orden").addEventListener("change", function(){
  var k = this.value;
  pf.ordAb.k = k;
  pf.ordAb.dir = (k === "s") ? 1 : -1;
  pfRender();
});
$("pf-vista").addEventListener("click", function(){
  pf.vista = pf.vista === "tabla" ? "tarjetas" : "tabla";
  try { localStorage.setItem("pf-vista", pf.vista); } catch(e){}
  pfVistaAplica();
});
$("pf-th-ab").addEventListener("click", function(e){ pfOrdClick(e, pf.ordAb); });
$("pf-th-ce").addEventListener("click", function(e){ pfOrdClick(e, pf.ordCe); });
$("pf-filtros").addEventListener("click", function(e){
  var b = e.target.closest("button[data-f]");
  if (b){
    pf.filtro = b.getAttribute("data-f");
    $("pf-filtros").querySelectorAll("button[data-f]").forEach(function(x){ x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    pfRender();
    return;
  }
  if (e.target.closest("#pf-agrupar")){
    pf.agrupar = !pf.agrupar;
    $("pf-agrupar").setAttribute("aria-pressed", pf.agrupar ? "true" : "false");
    pfRender();
  }
});
setInterval(function(){ if (!document.hidden && pf.auth) pfLoad(); }, 60000);
document.addEventListener("visibilitychange", function(){ if (!document.hidden && pf.auth) pfLoad(); });
pfVistaAplica();
pfLoad();

</script>
</body>
</html>
`;

Bun.serve({
  port: Number(Bun.env.PORT) || 3000,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/portafolio/login" && req.method === "POST") {
      if (!PORT_PIN) return json({ error: "sin_pin" }, 503);
      const ip = quien(req);
      const espera = bloqueadoPor(ip);
      if (espera) return json({ error: "demasiados_intentos", segundos: espera }, 429);
      let pin = "";
      try { pin = String(((await req.json()) as any).pin || "").trim(); } catch {}
      await Bun.sleep(400);
      if (pin !== PORT_PIN) {
        fallo(ip);
        const quedan = bloqueadoPor(ip);
        if (quedan) return json({ error: "demasiados_intentos", segundos: quedan }, 429);
        return json({ error: "pin_invalido" }, 401);
      }
      INTENTOS.delete(ip);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": PORT_COOKIE } });
    }
    if (url.pathname === "/api/portafolio/salir" && req.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json; charset=utf-8", "set-cookie": "pf=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0" } });
    }
    if (url.pathname === "/api/portafolio") {
      if (!portAuthed(req)) return json({ error: "no_autorizado" }, 401);
      if (req.method === "POST") {
        let body: any = null;
        try { body = await req.json(); } catch { return json({ error: "json_invalido" }, 400); }
        if (!body || (!Array.isArray(body.pos) && !Array.isArray(body.mov))) return json({ error: "formato" }, 400);
        const prev = await portLoad();
        const st = {
          pos: Array.isArray(body.pos) ? portClean(body.pos) : prev.pos,
          mov: Array.isArray(body.mov) ? portCleanMov(body.mov) : prev.mov,
          snap: Array.isArray(prev.snap) ? prev.snap : [],
          v: STORE_V,
        };
        try { await portSave(st); } catch { return json({ error: "no_se_pudo_guardar" }, 500); }
        let px: Record<string, number> = {};
        try { px = await portPrices(st.pos); } catch {}
        let snap: any[] = st.snap || [];
        try { snap = await portSnap(st, px); } catch {}
        return json({ pos: st.pos, mov: st.mov, precios: px, snap, updated: Date.now() });
      }
      const st = await portLoad();
      let px: Record<string, number> = {};
      try { px = await portPrices(st.pos); } catch (e: any) { console.error("portafolio precios", e.message); }
      let snap: any[] = st.snap || [];
      try { snap = await portSnap(st, px); } catch (e: any) { console.error("portafolio foto", e.message); }
      // renueva la sesion mientras sigas usando el portafolio
      return new Response(JSON.stringify({ pos: st.pos, mov: st.mov, precios: px, snap, updated: Date.now() }),
        { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": PORT_COOKIE } });
    }
    if (url.pathname === "/api/portafolio/precio") {
      if (!portAuthed(req)) return json({ error: "no_autorizado" }, 401);
      const sim = String(url.searchParams.get("s") || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12);
      const tipo = url.searchParams.get("tipo") === "accion" ? "accion" : "cripto";
      if (!sim) return json({ error: "sin_simbolo" }, 400);
      try { return json({ s: sim, precio: await precioDe(sim, tipo) }); }
      catch (e: any) { console.error("precio", sim, e.message); return json({ s: sim, precio: null }); }
    }
    if (url.pathname === "/api/portafolio/senales") {
      if (!portAuthed(req)) return json({ error: "no_autorizado" }, 401);
      const st = await portLoad();
      try { return json({ senales: await senales(st.pos) }); }
      catch (e: any) { console.error("senales", e.message); return json({ senales: {} }); }
    }
    if (url.pathname === "/api/portafolio/btc") {
      if (!portAuthed(req)) return json({ error: "no_autorizado" }, 401);
      try { return json(await btcRef()); }
      catch (e: any) { console.error("btc", e.message); return json({ price: null }); }
    }
    if (url.pathname === "/api/portafolio/velas") {
      if (!portAuthed(req)) return json({ error: "no_autorizado" }, 401);
      const sim = String(url.searchParams.get("s") || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12);
      const tipo = url.searchParams.get("tipo") === "accion" ? "accion" : "cripto";
      const tf = url.searchParams.get("tf") === "4h" ? "4h" : "1d";
      if (!sim) return json({ error: "sin_simbolo" }, 400);
      try {
        const d = await velasDe(sim, tipo, tf);
        if (!d) return json({ s: sim, tf, velas: [], src: null });
        return json({ s: sim, tf, velas: d.velas, src: d.src });
      } catch (e: any) { console.error("velas", sim, e.message); return json({ s: sim, tf, velas: [], src: null }); }
    }
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" } });
    }
    return new Response("No encontrado", { status: 404 });
  },
});

portLoad()
  .then((r) => console.log("portafolio listo:", r.pos.length, "posiciones,", r.mov.length, "movimientos", PORT_PIN ? "(PIN activo)" : "(SIN PIN: define PORTAFOLIO_PIN)"))
  .catch((e) => console.error("arranque portafolio:", e.message));
