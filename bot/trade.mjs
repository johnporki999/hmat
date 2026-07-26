/**
 * HAJSOMAT — bot tradingowy SOL/USDC odpalany cyklicznie z GitHub Actions.
 *
 * Jeden przebieg = jedna decyzja:
 *   1. pobierz swiece SOL/USD i policz wskazniki,
 *   2. pobierz realne saldo portfela z lancucha,
 *   3. sprawdz stopy/take-profit otwartej pozycji albo warunki wejscia,
 *   4. jesli trzeba — wykonaj swap przez Jupiter,
 *   5. zapisz stan i historie do plikow JSON (czyta je apka).
 *
 * Bot nigdy nie trzyma stanu w pamieci miedzy przebiegami — wszystko leci
 * do state/*.json, ktore workflow commituje z powrotem do repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguracja
// ─────────────────────────────────────────────────────────────────────────────

const env = (k, d = '') => {
  const v = process.env[k];
  return v == null || String(v).trim() === '' ? d : String(v).trim();
};
const envNum = (k, d) => {
  const v = Number.parseFloat(env(k));
  return Number.isFinite(v) ? v : d;
};
const envBool = (k, d) => {
  const v = env(k).toLowerCase();
  if (!v) return d;
  return ['1', 'true', 'yes', 'y', 'on', 'tak'].includes(v);
};

const CFG = {
  // Tryb
  DRY_RUN: envBool('DRY_RUN', true),
  FORCE_SELL: envBool('FORCE_SELL', false),
  RESET_HALT: envBool('RESET_HALT', false),

  // Siec
  RPC_URL: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  JUP_BASE: env('JUP_API_KEY') ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1',
  JUP_API_KEY: env('JUP_API_KEY'),

  // Rynek
  CANDLE_MINUTES: envNum('CANDLE_MINUTES', 15),

  // Wskazniki
  EMA_FAST: envNum('EMA_FAST', 21),
  EMA_SLOW: envNum('EMA_SLOW', 55),
  EMA_TREND: envNum('EMA_TREND', 200),
  RSI_LEN: envNum('RSI_LEN', 14),
  ATR_LEN: envNum('ATR_LEN', 14),

  // Wejscie
  RSI_MIN: envNum('RSI_MIN', 38),        // ponizej = spadajacy noz, nie lapiemy
  RSI_MAX: envNum('RSI_MAX', 68),        // powyzej = przegrzane, nie gonimy
  MAX_EXT_ATR: envNum('MAX_EXT_ATR', 1.6), // max oddalenie ceny od EMA fast w ATR
  MIN_VOL_PCT: envNum('MIN_VOL_PCT', 0.0012), // ATR/cena — ponizej rynek martwy
  MAX_VOL_PCT: envNum('MAX_VOL_PCT', 0.035),  // powyzej rynek oszalal

  // Wyjscie
  STOP_ATR: envNum('STOP_ATR', 1.6),
  TRAIL_ATR: envNum('TRAIL_ATR', 2.0),
  TRAIL_ARM_ATR: envNum('TRAIL_ARM_ATR', 1.0), // od jakiego zysku uzbroic trailing
  TAKE_PROFIT_ATR: envNum('TAKE_PROFIT_ATR', 3.2),
  MAX_HOLD_HOURS: envNum('MAX_HOLD_HOURS', 36),

  // Wielkosc pozycji i limity
  ALLOC_PCT: envNum('ALLOC_PCT', 0.6),       // ile % kapitalu wchodzi w jedna pozycje
  MAX_TRADE_USD: envNum('MAX_TRADE_USD', 250),
  MIN_TRADE_USD: envNum('MIN_TRADE_USD', 6),
  FEE_RESERVE_SOL: envNum('FEE_RESERVE_SOL', 0.02), // zawsze zostaje na oplaty
  SLIPPAGE_BPS: envNum('SLIPPAGE_BPS', 50),
  PRIORITY_FEE_MAX_LAMPORTS: envNum('PRIORITY_FEE_MAX_LAMPORTS', 2_000_000),
  EST_COST_PCT: envNum('EST_COST_PCT', 0.004), // szacunek kosztu rundy (fee+spread+slippage)

  // Bezpieczniki
  MAX_TRADES_PER_DAY: envNum('MAX_TRADES_PER_DAY', 6),
  COOLDOWN_MIN: envNum('COOLDOWN_MIN', 45),        // po stracie
  DAILY_LOSS_LIMIT_PCT: envNum('DAILY_LOSS_LIMIT_PCT', 0.06),
  MAX_DRAWDOWN_PCT: envNum('MAX_DRAWDOWN_PCT', 0.25),
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Zastepnik adresu, gdy symulacja leci bez zadnego portfela.
const NO_WALLET = '11111111111111111111111111111111';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const F_STATE = path.join(STATE_DIR, 'state.json');
const F_TRADES = path.join(STATE_DIR, 'trades.json');
const F_EQUITY = path.join(STATE_DIR, 'equity.json');

const MAX_TRADES_KEPT = 500;
const MAX_EQUITY_KEPT = 3000;

// ─────────────────────────────────────────────────────────────────────────────
// Narzedzia
// ─────────────────────────────────────────────────────────────────────────────

const LOG = [];
const log = (...a) => {
  const line = a
    .map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)))
    .join(' ');
  LOG.push(line);
  console.log(line);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const pct = (n) => `${(Number(n || 0) * 100).toFixed(2)}%`;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const nowISO = () => new Date().toISOString();
const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

async function fetchJSON(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 20000);
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: {
          'user-agent': 'hajsomat-bot/1.0',
          accept: 'application/json',
          ...(opts.headers || {}),
        },
      });
      clearTimeout(t);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url} :: ${text.slice(0, 300)}`);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log(`! nie udalo sie odczytac ${path.basename(file)}: ${e.message}`);
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Dane rynkowe — swiece SOL/USD, trzy zrodla na wypadek awarii jednego
// ─────────────────────────────────────────────────────────────────────────────

async function candlesKraken(minutes) {
  const j = await fetchJSON(
    `https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=${minutes}`
  );
  if (j.error?.length) throw new Error(`kraken: ${j.error.join(',')}`);
  const key = Object.keys(j.result).find((k) => k !== 'last');
  return j.result[key].map((c) => ({
    t: c[0] * 1000,
    o: +c[1],
    h: +c[2],
    l: +c[3],
    c: +c[4],
    v: +c[6],
  }));
}

async function candlesCoinbase(minutes) {
  const g = minutes * 60;
  const arr = await fetchJSON(
    `https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=${g}`
  );
  return arr
    .map((c) => ({ t: c[0] * 1000, l: +c[1], h: +c[2], o: +c[3], c: +c[4], v: +c[5] }))
    .sort((a, b) => a.t - b.t);
}

async function candlesBinance(minutes) {
  const arr = await fetchJSON(
    `https://api.binance.com/api/v3/klines?symbol=SOLUSDC&interval=${minutes}m&limit=500`
  );
  return arr.map((c) => ({ t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
}

async function getCandles(minutes) {
  const sources = [
    ['kraken', candlesKraken],
    ['coinbase', candlesCoinbase],
    ['binance', candlesBinance],
  ];
  for (const [name, fn] of sources) {
    try {
      const c = await fn(minutes);
      if (c.length >= 60) {
        log(`> swiece: ${name}, ${c.length} x ${minutes}m, ostatnia ${usd(c.at(-1).c)}`);
        return { candles: c, source: name };
      }
      log(`! zrodlo ${name} dalo tylko ${c.length} swiec — za malo`);
    } catch (e) {
      log(`! zrodlo ${name} padlo: ${e.message.slice(0, 160)}`);
    }
  }
  throw new Error('zadne zrodlo swiec nie odpowiedzialo');
}

// ─────────────────────────────────────────────────────────────────────────────
// Wskazniki
// ─────────────────────────────────────────────────────────────────────────────

function ema(values, len) {
  if (values.length < len) return [];
  const k = 2 / (len + 1);
  const out = new Array(values.length).fill(null);
  let acc = values.slice(0, len).reduce((a, b) => a + b, 0) / len;
  out[len - 1] = acc;
  for (let i = len; i < values.length; i++) {
    acc = values[i] * k + acc * (1 - k);
    out[i] = acc;
  }
  return out;
}

function rsi(closes, len) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < len + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= len;
  loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (len - 1) + Math.max(d, 0)) / len;
    loss = (loss * (len - 1) + Math.max(-d, 0)) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atr(candles, len) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < len + 1) return out;
  const trs = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1].c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p)));
  }
  let a = trs.slice(1, len + 1).reduce((x, y) => x + y, 0) / len;
  out[len] = a;
  for (let i = len + 1; i < candles.length; i++) {
    a = (a * (len - 1) + trs[i]) / len;
    out[i] = a;
  }
  return out;
}

function analyze(candles) {
  const closes = candles.map((c) => c.c);
  const eFast = ema(closes, CFG.EMA_FAST);
  const eSlow = ema(closes, CFG.EMA_SLOW);
  const eTrend = ema(closes, Math.min(CFG.EMA_TREND, Math.floor(closes.length * 0.8)));
  const r = rsi(closes, CFG.RSI_LEN);
  const a = atr(candles, CFG.ATR_LEN);
  const i = closes.length - 1;

  const trendNow = eTrend[i];
  const trendPrev = eTrend[i - 10] ?? eTrend[i];
  const slope = trendNow && trendPrev ? (trendNow - trendPrev) / trendPrev : 0;

  return {
    price: closes[i],
    emaFast: eFast[i],
    emaSlow: eSlow[i],
    emaTrend: trendNow,
    emaFastPrev: eFast[i - 1],
    emaSlowPrev: eSlow[i - 1],
    rsi: r[i],
    rsiPrev: r[i - 1],
    atr: a[i],
    trendSlope: slope,
    volPct: a[i] && closes[i] ? a[i] / closes[i] : 0,
    barTs: candles[i].t,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Portfel
// ─────────────────────────────────────────────────────────────────────────────

function loadKeypair() {
  const raw = env('SOLANA_PRIVATE_KEY');
  if (!raw) return null;
  try {
    if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch (e) {
    throw new Error(`SOLANA_PRIVATE_KEY nie da sie sparsowac (base58 albo tablica JSON): ${e.message}`);
  }
}

async function getBalances(conn, owner) {
  const lamports = await conn.getBalance(owner, 'confirmed');
  let usdc = 0;
  try {
    const res = await conn.getParsedTokenAccountsByOwner(
      owner,
      { mint: new PublicKey(USDC_MINT) },
      'confirmed'
    );
    for (const acc of res.value) {
      usdc += acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
    }
  } catch (e) {
    log(`! nie udalo sie odczytac USDC: ${e.message.slice(0, 140)}`);
  }
  return { sol: lamports / LAMPORTS_PER_SOL, usdc };
}

// ─────────────────────────────────────────────────────────────────────────────
// Jupiter — kwotowanie i swap
// ─────────────────────────────────────────────────────────────────────────────

const jupHeaders = () => (CFG.JUP_API_KEY ? { 'x-api-key': CFG.JUP_API_KEY } : {});

async function jupQuote(inputMint, outputMint, amountRaw) {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(Math.floor(amountRaw)),
    slippageBps: String(Math.round(CFG.SLIPPAGE_BPS)),
    restrictIntermediateTokens: 'true',
  });
  return fetchJSON(`${CFG.JUP_BASE}/quote?${q}`, { headers: jupHeaders() });
}

/** Cena realnie wykonalna: ile USDC dostaniemy za 1 SOL. */
async function livePrice() {
  try {
    const q = await jupQuote(SOL_MINT, USDC_MINT, 1 * LAMPORTS_PER_SOL);
    return Number(q.outAmount) / 1e6;
  } catch (e) {
    log(`! Jupiter nie dal ceny: ${e.message.slice(0, 140)}`);
    return null;
  }
}

async function confirmSig(conn, sig, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await conn.getSignatureStatuses([sig]);
    const s = st?.value?.[0];
    if (s) {
      if (s.err) throw new Error(`transakcja odrzucona: ${JSON.stringify(s.err)}`);
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return true;
    }
    await sleep(2500);
  }
  throw new Error('transakcja nie potwierdzona w limicie czasu');
}

async function swap(conn, keypair, inputMint, outputMint, amountRaw) {
  const quote = await jupQuote(inputMint, outputMint, amountRaw);
  const impact = Number(quote.priceImpactPct || 0);
  log(`> kwota: in=${quote.inAmount} out=${quote.outAmount} impact=${pct(impact)} route=${quote.routePlan?.length || '?'}`);

  if (impact > 0.02) throw new Error(`price impact ${pct(impact)} za wysoki — odpuszczam`);

  const body = {
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: Math.round(CFG.PRIORITY_FEE_MAX_LAMPORTS),
        priorityLevel: 'high',
      },
    },
  };

  const res = await fetchJSON(`${CFG.JUP_BASE}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...jupHeaders() },
    body: JSON.stringify(body),
  });

  const tx = VersionedTransaction.deserialize(Buffer.from(res.swapTransaction, 'base64'));
  tx.sign([keypair]);

  const sim = await conn.simulateTransaction(tx, { replaceRecentBlockhash: true, commitment: 'processed' });
  if (sim.value.err) {
    throw new Error(`symulacja nieudana: ${JSON.stringify(sim.value.err)} :: ${(sim.value.logs || []).slice(-3).join(' | ')}`);
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  log(`> wyslano tx ${sig}`);
  await confirmSig(conn, sig);
  log(`> potwierdzone: https://solscan.io/tx/${sig}`);
  return { sig, quote };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stan
// ─────────────────────────────────────────────────────────────────────────────

function freshState(wallet) {
  return {
    version: 1,
    wallet,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    mode: CFG.DRY_RUN ? 'DRY' : 'LIVE',
    position: null,
    startEquity: null,
    peakEquity: null,
    halted: false,
    haltReason: null,
    cooldownUntil: 0,
    day: { date: utcDay(), startEquity: null, realized: 0, trades: 0 },
    stats: {
      trades: 0,
      wins: 0,
      losses: 0,
      realizedPnl: 0,
      volumeUsd: 0,
      feesUsd: 0,
      bestUsd: 0,
      worstUsd: 0,
    },
    lastRun: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategia
// ─────────────────────────────────────────────────────────────────────────────

/** Czy warto wejsc w SOL? Zwraca {enter, reason, score}. */
function entrySignal(m) {
  const reasons = [];
  let score = 0;

  const trendUp = m.price > m.emaTrend && m.emaFast > m.emaSlow;
  if (!trendUp) {
    return { enter: false, score: 0, reason: 'brak trendu wzrostowego (cena pod EMA trend albo EMA fast < slow)' };
  }
  score += 3;
  reasons.push('trend wzrostowy');

  if (m.trendSlope > 0.0005) {
    score += 1;
    reasons.push('EMA trend rosnie');
  }

  if (m.volPct < CFG.MIN_VOL_PCT) {
    return { enter: false, score, reason: `zmiennosc za niska (${pct(m.volPct)}) — koszty zjedza ruch` };
  }
  if (m.volPct > CFG.MAX_VOL_PCT) {
    return { enter: false, score, reason: `zmiennosc za wysoka (${pct(m.volPct)}) — rynek szaleje, stoje z boku` };
  }
  score += 1;

  if (m.rsi < CFG.RSI_MIN) {
    return { enter: false, score, reason: `RSI ${m.rsi.toFixed(1)} — spadajacy noz, czekam na odbicie` };
  }
  if (m.rsi > CFG.RSI_MAX) {
    return { enter: false, score, reason: `RSI ${m.rsi.toFixed(1)} — przegrzane, nie gonie` };
  }
  score += 1;
  reasons.push(`RSI ${m.rsi.toFixed(1)} w oknie`);

  // Nie kupujemy wysoko nad srednia — czekamy na cofniecie do EMA fast.
  const ext = (m.price - m.emaFast) / m.atr;
  if (ext > CFG.MAX_EXT_ATR) {
    return { enter: false, score, reason: `cena ${ext.toFixed(2)} ATR nad EMA${CFG.EMA_FAST} — za daleko, czekam na cofniecie` };
  }
  score += 2;
  reasons.push(`cofniecie do sredniej (${ext.toFixed(2)} ATR)`);

  // RSI zawraca w gore — potwierdzenie, ze cofniecie sie konczy.
  if (m.rsi > m.rsiPrev) {
    score += 1;
    reasons.push('RSI zawraca w gore');
  }

  // Czy w ogole jest z czego zarobic po kosztach?
  const expectedMove = (CFG.TAKE_PROFIT_ATR * m.atr) / m.price;
  if (expectedMove < CFG.EST_COST_PCT * 2.5) {
    return { enter: false, score, reason: `potencjal ${pct(expectedMove)} zbyt maly wobec kosztow ${pct(CFG.EST_COST_PCT)}` };
  }

  const enter = score >= 7;
  return {
    enter,
    score,
    reason: enter
      ? `WEJSCIE: ${reasons.join(', ')} (score ${score})`
      : `score ${score}/7 za niski: ${reasons.join(', ')}`,
  };
}

/** Czy zamknac pozycje? Zwraca {exit, reason}. */
function exitSignal(pos, m, price) {
  const entry = pos.entryPrice;
  const a = pos.atrAtEntry || m.atr;
  const gainAtr = (price - entry) / a;
  const heldH = (Date.now() - new Date(pos.entryTs).getTime()) / 3600000;

  if (price <= pos.stopPrice) {
    return { exit: true, reason: `STOP LOSS przy ${usd(price)} (stop ${usd(pos.stopPrice)})` };
  }
  if (price >= pos.takeProfit) {
    return { exit: true, reason: `TAKE PROFIT przy ${usd(price)} (+${gainAtr.toFixed(2)} ATR)` };
  }
  if (pos.trailArmed) {
    const trail = pos.maxPrice - CFG.TRAIL_ATR * a;
    if (price <= trail) {
      return { exit: true, reason: `TRAILING STOP — szczyt ${usd(pos.maxPrice)}, zejscie do ${usd(price)}` };
    }
  }
  if (m.emaFast < m.emaSlow && price < m.emaTrend) {
    return { exit: true, reason: 'trend sie odwrocil (EMA fast < slow i cena pod EMA trend)' };
  }
  if (heldH > CFG.MAX_HOLD_HOURS && price < entry) {
    return { exit: true, reason: `stop czasowy — ${heldH.toFixed(1)}h pod woda` };
  }
  return { exit: false, reason: `trzymam: ${gainAtr >= 0 ? '+' : ''}${gainAtr.toFixed(2)} ATR, ${heldH.toFixed(1)}h` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log(`=== HAJSOMAT ${nowISO()} | tryb ${CFG.DRY_RUN ? 'DRY-RUN (symulacja)' : 'LIVE'} ===`);

  const keypair = loadKeypair();
  if (!keypair && !CFG.DRY_RUN) {
    throw new Error('brak SOLANA_PRIVATE_KEY — w trybie LIVE bot nie ma czym podpisac transakcji');
  }
  // Bez klucza i bez adresu da sie jeszcze odpalic sucha symulacje na pustym
  // adresie — po to, zeby sprawdzic instalacje zanim w ogole powstanie portfel.
  let walletStr = keypair ? keypair.publicKey.toBase58() : env('WALLET_ADDRESS', '');
  if (!walletStr) {
    if (!CFG.DRY_RUN) {
      throw new Error('nie znam adresu portfela (SOLANA_PRIVATE_KEY albo WALLET_ADDRESS)');
    }
    walletStr = NO_WALLET;
    log('> brak portfela — jade na wirtualnym kapitale, sam test instalacji');
  }
  const owner = new PublicKey(walletStr);
  log(`> portfel: ${walletStr}`);

  const conn = new Connection(CFG.RPC_URL, 'confirmed');
  const base = freshState(walletStr);
  const saved = readJSON(F_STATE, {});
  const state = {
    ...base,
    ...saved,
    stats: { ...base.stats, ...(saved.stats || {}) },
    day: { ...base.day, ...(saved.day || {}) },
  };
  delete state.lastError;
  state.wallet = walletStr;
  state.mode = CFG.DRY_RUN ? 'DRY' : 'LIVE';
  const trades = readJSON(F_TRADES, []);
  const equity = readJSON(F_EQUITY, []);

  if (CFG.RESET_HALT && state.halted) {
    log('> reczny reset bezpiecznika');
    state.halted = false;
    state.haltReason = null;
    state.cooldownUntil = 0;
  }

  // Dane rynkowe
  const { candles, source } = await getCandles(CFG.CANDLE_MINUTES);
  const m = analyze(candles);
  if (!m.emaTrend || !m.atr || !m.rsi) throw new Error('za malo swiec na policzenie wskaznikow');

  const jupPrice = await livePrice();
  const price = jupPrice || m.price;
  log(
    `> cena ${usd(price)} | EMA${CFG.EMA_FAST} ${usd(m.emaFast)} | EMA${CFG.EMA_SLOW} ${usd(m.emaSlow)} | ` +
      `RSI ${m.rsi.toFixed(1)} | ATR ${usd(m.atr)} (${pct(m.volPct)})`
  );

  // Saldo
  let bal;
  if (CFG.DRY_RUN && !keypair) {
    bal = { sol: state.simSol ?? 0, usdc: state.simUsdc ?? envNum('DRY_START_USDC', 500) };
    log(`> saldo symulowane: ${bal.sol.toFixed(4)} SOL + ${usd(bal.usdc)} USDC`);
  } else if (CFG.DRY_RUN) {
    const real = await getBalances(conn, owner);
    bal = {
      sol: state.simSol ?? real.sol,
      usdc: state.simUsdc ?? (real.usdc || envNum('DRY_START_USDC', 500)),
    };
    log(`> saldo realne: ${real.sol.toFixed(4)} SOL + ${usd(real.usdc)} USDC | symulacja jedzie na ${bal.sol.toFixed(4)} SOL + ${usd(bal.usdc)} USDC`);
  } else {
    bal = await getBalances(conn, owner);
    log(`> saldo: ${bal.sol.toFixed(4)} SOL + ${usd(bal.usdc)} USDC`);
  }

  // W czystej symulacji nikt nie placi za gaz, wiec nie blokujemy rezerwy.
  const pureSim = CFG.DRY_RUN && !keypair;
  const feeReserve = pureSim ? 0 : CFG.FEE_RESERVE_SOL;
  const tradableSol = Math.max(0, bal.sol - feeReserve);
  const equityUsd = bal.usdc + bal.sol * price;
  log(`> kapital: ${usd(equityUsd)}`);

  if (state.startEquity == null) state.startEquity = equityUsd;
  state.peakEquity = Math.max(state.peakEquity ?? equityUsd, equityUsd);

  // Nowa doba UTC — reset dziennych licznikow
  if (state.day?.date !== utcDay()) {
    state.day = { date: utcDay(), startEquity: equityUsd, realized: 0, trades: 0 };
    if (state.haltReason === 'dzienny limit straty') {
      state.halted = false;
      state.haltReason = null;
      log('> nowa doba — dzienny bezpiecznik zdjety');
    }
  }
  if (state.day.startEquity == null) state.day.startEquity = equityUsd;

  // Bezpieczniki
  const dd = state.peakEquity > 0 ? (state.peakEquity - equityUsd) / state.peakEquity : 0;
  if (!state.halted && dd > CFG.MAX_DRAWDOWN_PCT) {
    state.halted = true;
    state.haltReason = `obsuniecie ${pct(dd)} przekroczylo limit ${pct(CFG.MAX_DRAWDOWN_PCT)}`;
    log(`!! STOP: ${state.haltReason}`);
  }
  const dayLoss = state.day.startEquity > 0 ? -state.day.realized / state.day.startEquity : 0;
  if (!state.halted && dayLoss > CFG.DAILY_LOSS_LIMIT_PCT) {
    state.halted = true;
    state.haltReason = 'dzienny limit straty';
    log(`!! STOP na dzis: strata dnia ${pct(dayLoss)}`);
  }

  // Adopcja pozycji — portfel ma SOL, a bot o zadnej pozycji nie wie
  if (!state.position && tradableSol * price > Math.max(CFG.MIN_TRADE_USD, equityUsd * 0.3)) {
    state.position = {
      entryPrice: price,
      entryTs: nowISO(),
      sizeSol: tradableSol,
      costUsd: tradableSol * price,
      atrAtEntry: m.atr,
      stopPrice: price - CFG.STOP_ATR * m.atr,
      takeProfit: price + CFG.TAKE_PROFIT_ATR * m.atr,
      maxPrice: price,
      trailArmed: false,
      adopted: true,
      sig: null,
    };
    log(`> zastalem ${tradableSol.toFixed(4)} SOL w portfelu — przyjmuje jako pozycje po ${usd(price)}`);
  }

  let action = 'HOLD';
  let reason = '';
  let tradeRecord = null;

  // ── Pozycja otwarta: pilnujemy stopow ─────────────────────────────────────
  if (state.position) {
    const pos = state.position;
    pos.maxPrice = Math.max(pos.maxPrice || pos.entryPrice, price);
    if (!pos.trailArmed && price - pos.entryPrice >= CFG.TRAIL_ARM_ATR * (pos.atrAtEntry || m.atr)) {
      pos.trailArmed = true;
      log('> trailing stop uzbrojony');
    }

    const ex = CFG.FORCE_SELL
      ? { exit: true, reason: 'reczne wymuszenie sprzedazy' }
      : state.halted
        ? { exit: true, reason: `bezpiecznik: ${state.haltReason}` }
        : exitSignal(pos, m, price);

    reason = ex.reason;

    if (ex.exit && tradableSol > 0.0005) {
      const sellSol = Math.min(tradableSol, pos.sizeSol || tradableSol);
      log(`> SPRZEDAJE ${sellSol.toFixed(4)} SOL — ${ex.reason}`);
      action = 'SELL';

      let gotUsdc;
      let sig = null;
      if (CFG.DRY_RUN) {
        gotUsdc = sellSol * price * (1 - CFG.EST_COST_PCT / 2);
        state.simSol = bal.sol - sellSol;
        state.simUsdc = bal.usdc + gotUsdc;
      } else {
        const before = await getBalances(conn, owner);
        const r = await swap(conn, keypair, SOL_MINT, USDC_MINT, Math.floor(sellSol * LAMPORTS_PER_SOL));
        sig = r.sig;
        await sleep(4000);
        const after = await getBalances(conn, owner);
        gotUsdc = Math.max(0, after.usdc - before.usdc);
        bal = after;
      }

      const pnlUsd = gotUsdc - pos.costUsd;
      const pnlPct = pos.costUsd > 0 ? pnlUsd / pos.costUsd : 0;
      const holdMs = Date.now() - new Date(pos.entryTs).getTime();

      state.stats.trades += 1;
      state.stats.realizedPnl += pnlUsd;
      state.stats.volumeUsd += gotUsdc;
      if (pnlUsd >= 0) state.stats.wins += 1;
      else state.stats.losses += 1;
      state.stats.bestUsd = Math.max(state.stats.bestUsd || 0, pnlUsd);
      state.stats.worstUsd = Math.min(state.stats.worstUsd || 0, pnlUsd);
      state.day.realized += pnlUsd;
      state.day.trades += 1;

      if (pnlUsd < 0) {
        state.cooldownUntil = Date.now() + CFG.COOLDOWN_MIN * 60000;
        log(`> strata — pauza do ${new Date(state.cooldownUntil).toISOString()}`);
      }

      tradeRecord = {
        id: `${Date.now()}`,
        ts: nowISO(),
        type: 'SELL',
        price,
        sol: sellSol,
        usd: gotUsdc,
        pnlUsd,
        pnlPct,
        holdMs,
        entryPrice: pos.entryPrice,
        reason: ex.reason,
        sig,
        dry: CFG.DRY_RUN,
      };
      state.position = null;
      log(`> zamkniete: ${pnlUsd >= 0 ? '+' : ''}${usd(pnlUsd)} (${pct(pnlPct)})`);
    } else if (ex.exit) {
      log(`> chcialbym sprzedac (${ex.reason}) ale nie ma czego`);
      state.position = null;
    } else {
      log(`> ${ex.reason}`);
    }
  }

  // ── Brak pozycji: szukamy wejscia ─────────────────────────────────────────
  else {
    const sig = entrySignal(m);
    reason = sig.reason;

    const blockers = [];
    if (state.halted) blockers.push(`bezpiecznik: ${state.haltReason}`);
    if (Date.now() < (state.cooldownUntil || 0)) {
      const left = Math.ceil((state.cooldownUntil - Date.now()) / 60000);
      blockers.push(`pauza po stracie jeszcze ${left} min`);
    }
    if (state.day.trades >= CFG.MAX_TRADES_PER_DAY) {
      blockers.push(`limit ${CFG.MAX_TRADES_PER_DAY} trejdow na dobe wyczerpany`);
    }
    if (CFG.FORCE_SELL) blockers.push('tryb wymuszonej sprzedazy');

    const budget = Math.min(bal.usdc, equityUsd * CFG.ALLOC_PCT, CFG.MAX_TRADE_USD);
    if (budget < CFG.MIN_TRADE_USD) {
      blockers.push(`budzet ${usd(budget)} ponizej minimum ${usd(CFG.MIN_TRADE_USD)}`);
    }
    if (!pureSim && bal.sol < CFG.FEE_RESERVE_SOL / 2) {
      blockers.push(`za malo SOL na oplaty (${bal.sol.toFixed(4)}) — dorzuc troche SOL`);
    }

    if (sig.enter && blockers.length === 0) {
      log(`> KUPUJE za ${usd(budget)} — ${sig.reason}`);
      action = 'BUY';
      reason = sig.reason;

      let gotSol;
      let txSig = null;
      if (CFG.DRY_RUN) {
        gotSol = (budget / price) * (1 - CFG.EST_COST_PCT / 2);
        state.simSol = bal.sol + gotSol;
        state.simUsdc = bal.usdc - budget;
      } else {
        const before = await getBalances(conn, owner);
        const r = await swap(conn, keypair, USDC_MINT, SOL_MINT, Math.floor(budget * 1e6));
        txSig = r.sig;
        await sleep(4000);
        const after = await getBalances(conn, owner);
        gotSol = Math.max(0, after.sol - before.sol);
        bal = after;
      }

      const costUsd = budget;
      state.position = {
        entryPrice: gotSol > 0 ? costUsd / gotSol : price,
        entryTs: nowISO(),
        sizeSol: gotSol,
        costUsd,
        atrAtEntry: m.atr,
        stopPrice: price - CFG.STOP_ATR * m.atr,
        takeProfit: price + CFG.TAKE_PROFIT_ATR * m.atr,
        maxPrice: price,
        trailArmed: false,
        adopted: false,
        sig: txSig,
      };
      state.stats.volumeUsd += costUsd;
      state.day.trades += 1;

      tradeRecord = {
        id: `${Date.now()}`,
        ts: nowISO(),
        type: 'BUY',
        price: state.position.entryPrice,
        sol: gotSol,
        usd: costUsd,
        pnlUsd: null,
        pnlPct: null,
        reason: sig.reason,
        stopPrice: state.position.stopPrice,
        takeProfit: state.position.takeProfit,
        sig: txSig,
        dry: CFG.DRY_RUN,
      };
      log(`> wszedlem: ${gotSol.toFixed(4)} SOL po ${usd(state.position.entryPrice)}, stop ${usd(state.position.stopPrice)}, TP ${usd(state.position.takeProfit)}`);
    } else {
      if (blockers.length) reason = `${blockers.join(' | ')}`;
      log(`> stoje z boku: ${reason}`);
    }
  }

  // ── Zapis stanu ───────────────────────────────────────────────────────────
  const finalEquity = bal.usdc + bal.sol * price;
  const unrealized = state.position
    ? state.position.sizeSol * price - state.position.costUsd
    : 0;

  state.updatedAt = nowISO();
  state.lastRun = {
    ts: nowISO(),
    action,
    reason,
    price,
    source,
    equityUsd: finalEquity,
    unrealizedUsd: unrealized,
    indicators: {
      emaFast: m.emaFast,
      emaSlow: m.emaSlow,
      emaTrend: m.emaTrend,
      rsi: m.rsi,
      atr: m.atr,
      volPct: m.volPct,
      trendSlope: m.trendSlope,
    },
    balances: { sol: bal.sol, usdc: bal.usdc },
  };
  state.peakEquity = Math.max(state.peakEquity ?? finalEquity, finalEquity);

  if (tradeRecord) {
    trades.push(tradeRecord);
    while (trades.length > MAX_TRADES_KEPT) trades.shift();
  }

  equity.push({
    ts: Date.now(),
    equityUsd: finalEquity,
    price,
    sol: bal.sol,
    usdc: bal.usdc,
    pos: state.position ? 1 : 0,
    realized: state.stats.realizedPnl,
  });
  while (equity.length > MAX_EQUITY_KEPT) equity.shift();

  writeJSON(F_STATE, state);
  writeJSON(F_TRADES, trades);
  writeJSON(F_EQUITY, equity);

  const roi = state.startEquity > 0 ? (finalEquity - state.startEquity) / state.startEquity : 0;
  log(`=== ${action} | kapital ${usd(finalEquity)} | zrealizowane ${usd(state.stats.realizedPnl)} | ROI ${pct(roi)} ===`);

  return { action, reason, finalEquity, roi, price, state };
}

function writeSummary(result, error) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  const lines = ['# Hajsomat', ''];
  if (error) {
    lines.push(`**Blad:** \`${error.message}\``, '');
  } else if (result) {
    const s = result.state;
    lines.push(
      `**Akcja:** ${result.action}`,
      `**Powod:** ${result.reason}`,
      '',
      '| | |',
      '|---|---|',
      `| Tryb | ${CFG.DRY_RUN ? 'DRY-RUN' : 'LIVE'} |`,
      `| Cena SOL | ${usd(result.price)} |`,
      `| Kapital | ${usd(result.finalEquity)} |`,
      `| ROI | ${pct(result.roi)} |`,
      `| Zrealizowane | ${usd(s.stats.realizedPnl)} |`,
      `| Trejdy | ${s.stats.trades} (${s.stats.wins}W / ${s.stats.losses}L) |`,
      `| Pozycja | ${s.position ? `${s.position.sizeSol.toFixed(4)} SOL @ ${usd(s.position.entryPrice)}` : 'brak (cash)'} |`,
      `| Bezpiecznik | ${s.halted ? `AKTYWNY — ${s.haltReason}` : 'ok'} |`,
      ''
    );
  }
  lines.push('<details><summary>Log</summary>', '', '```', ...LOG, '```', '</details>');
  try {
    fs.appendFileSync(f, lines.join('\n') + '\n');
  } catch {
    /* summary to tylko kosmetyka */
  }
}

try {
  const result = await main();
  writeSummary(result, null);
} catch (e) {
  log(`!! BLAD: ${e.message}`);
  if (e.stack) console.error(e.stack);
  writeSummary(null, e);
  // Zapisujemy slad bledu, zeby apka pokazala ze cos jest nie tak.
  try {
    const st = readJSON(F_STATE, null);
    if (st) {
      st.lastError = { ts: nowISO(), message: e.message };
      writeJSON(F_STATE, st);
    }
  } catch {
    /* trudno */
  }
  process.exit(1);
}
