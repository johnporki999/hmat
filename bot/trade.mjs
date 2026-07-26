/**
 * HAJSOMAT — bot tradingowy na Solanie, odpalany cyklicznie z GitHub Actions.
 *
 * Skanuje kilkanascie aktywow notowanych za USDC, wybiera najlepiej rokujace
 * i trzyma naraz maksymalnie kilka pozycji. Jeden przebieg = jeden cykl:
 *   1. swiece i wskazniki dla kazdego aktywa z listy,
 *   2. realne salda portfela z lancucha,
 *   3. stopy i take-profity otwartych pozycji,
 *   4. ranking kandydatow i ewentualne wejscie,
 *   5. zapis stanu i historii do plikow JSON (czyta je apka).
 *
 * Bot nie trzyma nic w pamieci miedzy przebiegami — wszystko leci do state/*.json,
 * ktore workflow commituje z powrotem do repo.
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
// Uniwersum
//
// Minty sprawdzone w API Jupitera pod katem flagi "verified". To nie jest
// formalnosc: dla kazdego z tych symboli istnieja na Solanie podszywajace sie
// tokeny o identycznej nazwie. Nie dopisuj tu nic bez sprawdzenia mintu —
// pomylka oznacza swap w bezwartosciowy token.
//
// costMul podnosi szacowany koszt rundy dla aktywow o szerszym spreadzie, przez
// co filtr oplacalnosci jest dla nich surowszy niz dla SOL.
// ─────────────────────────────────────────────────────────────────────────────

const UNIVERSE = {
  SOL: { mint: 'So11111111111111111111111111111111111111112', dec: 9, kraken: 'SOLUSD', costMul: 1.0 },
  JUP: { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', dec: 6, kraken: 'JUPUSD', costMul: 1.3 },
  JTO: { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', dec: 9, kraken: 'JTOUSD', costMul: 1.4 },
  PYTH: { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', dec: 6, kraken: 'PYTHUSD', costMul: 1.4 },
  RAY: { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', dec: 6, kraken: 'RAYUSD', costMul: 1.3 },
  ORCA: { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', dec: 6, kraken: 'ORCAUSD', costMul: 1.5 },
  RENDER: { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', dec: 8, kraken: 'RENDERUSD', costMul: 1.4 },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', dec: 5, kraken: 'BONKUSD', costMul: 1.6 },
  // Ponizsze sa wylaczone domyslnie — wlacz przez zmienna ASSETS, jesli chcesz.
  W: { mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', dec: 6, kraken: 'WUSD', costMul: 1.5 },
  TNSR: { mint: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6', dec: 9, kraken: 'TNSRUSD', costMul: 1.6 },
  DRIFT: { mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', dec: 6, kraken: 'DRIFTUSD', costMul: 1.6 },
  KMNO: { mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', dec: 6, kraken: 'KMNOUSD', costMul: 1.6 },
  PENGU: { mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', dec: 6, kraken: 'PENGUUSD', costMul: 1.7 },
};

const USDC = { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', dec: 6 };
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const NO_WALLET = '11111111111111111111111111111111';

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
  DRY_RUN: envBool('DRY_RUN', true),
  FORCE_SELL: envBool('FORCE_SELL', false),
  RESET_HALT: envBool('RESET_HALT', false),

  RPC_URL: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  JUP_BASE: env('JUP_API_KEY') ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1',
  JUP_API_KEY: env('JUP_API_KEY'),

  ASSETS: env('ASSETS', 'SOL,JUP,JTO,PYTH,RAY,ORCA,RENDER,BONK')
    .toUpperCase()
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  MAX_POSITIONS: envNum('MAX_POSITIONS', 2),

  CANDLE_MINUTES: envNum('CANDLE_MINUTES', 15),

  EMA_FAST: envNum('EMA_FAST', 21),
  EMA_SLOW: envNum('EMA_SLOW', 55),
  EMA_TREND: envNum('EMA_TREND', 200),
  RSI_LEN: envNum('RSI_LEN', 14),
  ATR_LEN: envNum('ATR_LEN', 14),

  RSI_MIN: envNum('RSI_MIN', 38),
  RSI_MAX: envNum('RSI_MAX', 68),
  MAX_EXT_ATR: envNum('MAX_EXT_ATR', 1.6),
  MIN_VOL_PCT: envNum('MIN_VOL_PCT', 0.0012),
  MAX_VOL_PCT: envNum('MAX_VOL_PCT', 0.045),

  STOP_ATR: envNum('STOP_ATR', 1.6),
  TRAIL_ATR: envNum('TRAIL_ATR', 2.0),
  TRAIL_ARM_ATR: envNum('TRAIL_ARM_ATR', 1.0),
  TAKE_PROFIT_ATR: envNum('TAKE_PROFIT_ATR', 3.2),
  MAX_HOLD_HOURS: envNum('MAX_HOLD_HOURS', 36),

  ALLOC_PCT: envNum('ALLOC_PCT', 0.45),
  MAX_TRADE_USD: envNum('MAX_TRADE_USD', 250),
  MIN_TRADE_USD: envNum('MIN_TRADE_USD', 6),
  FEE_RESERVE_SOL: envNum('FEE_RESERVE_SOL', 0.02),
  SLIPPAGE_BPS: envNum('SLIPPAGE_BPS', 50),
  PRIORITY_FEE_MAX_LAMPORTS: envNum('PRIORITY_FEE_MAX_LAMPORTS', 2_000_000),
  EST_COST_PCT: envNum('EST_COST_PCT', 0.004),
  MAX_PRICE_IMPACT: envNum('MAX_PRICE_IMPACT', 0.02),

  MAX_TRADES_PER_DAY: envNum('MAX_TRADES_PER_DAY', 8),
  COOLDOWN_MIN: envNum('COOLDOWN_MIN', 45),
  DAILY_LOSS_LIMIT_PCT: envNum('DAILY_LOSS_LIMIT_PCT', 0.06),
  MAX_DRAWDOWN_PCT: envNum('MAX_DRAWDOWN_PCT', 0.25),
  MIN_SCORE: envNum('MIN_SCORE', 7),
};

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
  const line = a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
  LOG.push(line);
  console.log(line);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const pct = (n) => `${(Number(n || 0) * 100).toFixed(2)}%`;
const nowISO = () => new Date().toISOString();
const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
/** Ilosc tokena czytelnie — BONK ma inny rzad wielkosci niz SOL. */
const qty = (n) => (Math.abs(n) >= 1000 ? Number(n).toFixed(0) : Number(n).toPrecision(6));

async function fetchJSON(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 20000);
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: { 'user-agent': 'hajsomat-bot/2.0', accept: 'application/json', ...(opts.headers || {}) },
      });
      clearTimeout(t);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url} :: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1000 * (i + 1));
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
// Dane rynkowe
// ─────────────────────────────────────────────────────────────────────────────

async function candlesKraken(sym, minutes) {
  const pair = UNIVERSE[sym].kraken;
  const j = await fetchJSON(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${minutes}`);
  if (j.error?.length) throw new Error(`kraken: ${j.error.join(',')}`);
  const key = Object.keys(j.result).find((k) => k !== 'last');
  return j.result[key].map((c) => ({ t: c[0] * 1000, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[6] }));
}

async function candlesCoinbase(sym, minutes) {
  const arr = await fetchJSON(
    `https://api.exchange.coinbase.com/products/${sym}-USD/candles?granularity=${minutes * 60}`
  );
  return arr
    .map((c) => ({ t: c[0] * 1000, l: +c[1], h: +c[2], o: +c[3], c: +c[4], v: +c[5] }))
    .sort((a, b) => a.t - b.t);
}

async function candlesBinance(sym, minutes) {
  const arr = await fetchJSON(
    `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${minutes}m&limit=500`
  );
  return arr.map((c) => ({ t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
}

async function getCandles(sym, minutes) {
  for (const [name, fn] of [
    ['kraken', candlesKraken],
    ['coinbase', candlesCoinbase],
    ['binance', candlesBinance],
  ]) {
    try {
      const c = await fn(sym, minutes);
      if (c.length >= 60) return { candles: c, source: name };
    } catch {
      /* nastepne zrodlo */
    }
  }
  throw new Error(`brak swiec dla ${sym}`);
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

  return {
    price: closes[i],
    emaFast: eFast[i],
    emaSlow: eSlow[i],
    emaTrend: trendNow,
    rsi: r[i],
    rsiPrev: r[i - 1],
    atr: a[i],
    trendSlope: trendNow && trendPrev ? (trendNow - trendPrev) / trendPrev : 0,
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

/** Jedno zapytanie na wszystkie tokeny zamiast osobnego na kazdy. */
async function getBalances(conn, owner) {
  const [lamports, res] = await Promise.all([
    conn.getBalance(owner, 'confirmed'),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM }, 'confirmed'),
  ]);
  const tok = {};
  for (const acc of res.value) {
    const info = acc.account.data.parsed.info;
    tok[info.mint] = (tok[info.mint] || 0) + (info.tokenAmount.uiAmount || 0);
  }
  return { sol: lamports / LAMPORTS_PER_SOL, usdc: tok[USDC.mint] || 0, tok };
}

/** Ile mamy danego aktywa. SOL liczymy z salda natywnego. */
function heldQty(bal, sym) {
  if (sym === 'SOL') return bal.sol;
  return bal.tok?.[UNIVERSE[sym].mint] || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Jupiter
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

/** Cena realnie wykonalna: ile USDC za jedna jednostke aktywa. */
async function livePrice(sym) {
  const a = UNIVERSE[sym];
  try {
    const q = await jupQuote(a.mint, USDC.mint, 10 ** a.dec);
    return Number(q.outAmount) / 10 ** USDC.dec;
  } catch (e) {
    log(`! Jupiter nie dal ceny ${sym}: ${e.message.slice(0, 100)}`);
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
  log(`  kwota in=${quote.inAmount} out=${quote.outAmount} impact=${pct(impact)}`);
  if (impact > CFG.MAX_PRICE_IMPACT) throw new Error(`price impact ${pct(impact)} za wysoki`);

  const res = await fetchJSON(`${CFG.JUP_BASE}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...jupHeaders() },
    body: JSON.stringify({
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
    }),
  });

  const tx = VersionedTransaction.deserialize(Buffer.from(res.swapTransaction, 'base64'));
  tx.sign([keypair]);

  const sim = await conn.simulateTransaction(tx, { replaceRecentBlockhash: true, commitment: 'processed' });
  if (sim.value.err) {
    throw new Error(
      `symulacja nieudana: ${JSON.stringify(sim.value.err)} :: ${(sim.value.logs || []).slice(-3).join(' | ')}`
    );
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  log(`  wyslano ${sig}`);
  await confirmSig(conn, sig);
  log(`  potwierdzone: https://solscan.io/tx/${sig}`);
  return { sig, quote };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stan
// ─────────────────────────────────────────────────────────────────────────────

function freshState(wallet) {
  return {
    version: 2,
    wallet,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    mode: CFG.DRY_RUN ? 'DRY' : 'LIVE',
    positions: {},
    cooldowns: {},
    startEquity: null,
    peakEquity: null,
    halted: false,
    haltReason: null,
    day: { date: utcDay(), startEquity: null, realized: 0, trades: 0 },
    stats: { trades: 0, wins: 0, losses: 0, realizedPnl: 0, volumeUsd: 0, bestUsd: 0, worstUsd: 0 },
    perAsset: {},
    lastRun: null,
  };
}

/** Stan z wersji jednoaktywowej: pojedyncza pozycja SOL staje sie wpisem w mapie. */
function migrate(saved) {
  if (saved && saved.version === 1) {
    saved.positions = saved.position ? { SOL: { ...saved.position, sym: 'SOL', qty: saved.position.sizeSol } } : {};
    saved.cooldowns = saved.cooldownUntil ? { SOL: saved.cooldownUntil } : {};
    delete saved.position;
    delete saved.cooldownUntil;
    saved.version = 2;
    log('> stan przeniesiony z wersji jednoaktywowej');
  }
  return saved || {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategia
// ─────────────────────────────────────────────────────────────────────────────

/** Ocena kandydata. Zwraca {score, enter, reason} — im wyzszy score, tym lepiej. */
function entrySignal(sym, m) {
  const costPct = CFG.EST_COST_PCT * (UNIVERSE[sym].costMul || 1);
  const good = [];
  let score = 0;

  if (!(m.price > m.emaTrend && m.emaFast > m.emaSlow)) {
    return { score: 0, enter: false, reason: 'brak trendu wzrostowego' };
  }
  score += 3;
  good.push('trend');

  if (m.trendSlope > 0.0005) {
    score += 1;
    good.push('trend rosnie');
  }

  if (m.volPct < CFG.MIN_VOL_PCT) {
    return { score, enter: false, reason: `zmiennosc ${pct(m.volPct)} za niska` };
  }
  if (m.volPct > CFG.MAX_VOL_PCT) {
    return { score, enter: false, reason: `zmiennosc ${pct(m.volPct)} za wysoka` };
  }
  score += 1;

  if (m.rsi < CFG.RSI_MIN) return { score, enter: false, reason: `RSI ${m.rsi.toFixed(1)} — spadajacy noz` };
  if (m.rsi > CFG.RSI_MAX) return { score, enter: false, reason: `RSI ${m.rsi.toFixed(1)} — przegrzane` };
  score += 1;
  good.push(`RSI ${m.rsi.toFixed(1)}`);

  const ext = (m.price - m.emaFast) / m.atr;
  if (ext > CFG.MAX_EXT_ATR) {
    return { score, enter: false, reason: `${ext.toFixed(2)} ATR nad srednia — za daleko` };
  }
  score += 2;
  good.push('cofniecie do sredniej');

  if (m.rsi > m.rsiPrev) {
    score += 1;
    good.push('RSI zawraca');
  }

  const expectedMove = (CFG.TAKE_PROFIT_ATR * m.atr) / m.price;
  if (expectedMove < costPct * 2.5) {
    return { score, enter: false, reason: `potencjal ${pct(expectedMove)} maly wobec kosztow ${pct(costPct)}` };
  }
  score += 1;

  const enter = score >= CFG.MIN_SCORE;
  return {
    score,
    enter,
    reason: enter ? `gotowy: ${good.join(', ')}` : `score ${score}/${CFG.MIN_SCORE}: ${good.join(', ')}`,
  };
}

function exitSignal(pos, m, price) {
  const a = pos.atrAtEntry || m.atr;
  const gainAtr = (price - pos.entryPrice) / a;
  const heldH = (Date.now() - new Date(pos.entryTs).getTime()) / 3600000;

  if (price <= pos.stopPrice) return { exit: true, reason: `STOP LOSS przy ${usd(price)}` };
  if (price >= pos.takeProfit) return { exit: true, reason: `TAKE PROFIT (+${gainAtr.toFixed(2)} ATR)` };
  if (pos.trailArmed && price <= pos.maxPrice - CFG.TRAIL_ATR * a) {
    return { exit: true, reason: `TRAILING STOP — szczyt ${usd(pos.maxPrice)}` };
  }
  if (m.emaFast < m.emaSlow && price < m.emaTrend) {
    return { exit: true, reason: 'trend sie odwrocil' };
  }
  if (heldH > CFG.MAX_HOLD_HOURS && price < pos.entryPrice) {
    return { exit: true, reason: `stop czasowy — ${heldH.toFixed(1)}h pod woda` };
  }
  return { exit: false, reason: `${gainAtr >= 0 ? '+' : ''}${gainAtr.toFixed(2)} ATR, ${heldH.toFixed(1)}h` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log(`=== HAJSOMAT ${nowISO()} | ${CFG.DRY_RUN ? 'DRY-RUN (symulacja)' : 'LIVE'} ===`);

  const unknown = CFG.ASSETS.filter((s) => !UNIVERSE[s]);
  if (unknown.length) log(`! pomijam nieznane aktywa: ${unknown.join(', ')}`);
  const assets = CFG.ASSETS.filter((s) => UNIVERSE[s]);
  if (!assets.length) throw new Error('lista ASSETS jest pusta albo zawiera same nieznane symbole');

  const keypair = loadKeypair();
  if (!keypair && !CFG.DRY_RUN) {
    throw new Error('brak SOLANA_PRIVATE_KEY — w trybie LIVE bot nie ma czym podpisac transakcji');
  }
  let walletStr = keypair ? keypair.publicKey.toBase58() : env('WALLET_ADDRESS', '');
  if (!walletStr) {
    if (!CFG.DRY_RUN) throw new Error('nie znam adresu portfela (SOLANA_PRIVATE_KEY albo WALLET_ADDRESS)');
    walletStr = NO_WALLET;
    log('> brak portfela — jade na wirtualnym kapitale, sam test instalacji');
  }
  const owner = new PublicKey(walletStr);
  log(`> portfel: ${walletStr}`);
  log(`> aktywa: ${assets.join(', ')} | max pozycji: ${CFG.MAX_POSITIONS}`);

  const conn = new Connection(CFG.RPC_URL, 'confirmed');
  const base = freshState(walletStr);
  const saved = migrate(readJSON(F_STATE, {}));
  const state = {
    ...base,
    ...saved,
    stats: { ...base.stats, ...(saved.stats || {}) },
    day: { ...base.day, ...(saved.day || {}) },
    positions: saved.positions || {},
    cooldowns: saved.cooldowns || {},
    perAsset: saved.perAsset || {},
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
    state.cooldowns = {};
  }

  // ── Skan rynku ────────────────────────────────────────────────────────────
  // Trzymane aktywa skanujemy nawet gdy wypadly z listy — trzeba je domknac.
  const toScan = [...new Set([...assets, ...Object.keys(state.positions)])].filter((s) => UNIVERSE[s]);
  const mkt = {};
  for (const sym of toScan) {
    try {
      const { candles, source } = await getCandles(sym, CFG.CANDLE_MINUTES);
      const m = analyze(candles);
      if (m.emaTrend && m.atr && m.rsi != null) mkt[sym] = { ...m, source };
      else log(`! ${sym}: za malo swiec na wskazniki`);
    } catch (e) {
      log(`! ${sym}: ${e.message.slice(0, 100)}`);
    }
    await sleep(350);
  }
  if (!Object.keys(mkt).length) throw new Error('nie udalo sie pobrac zadnych danych rynkowych');
  log(`> zeskanowano ${Object.keys(mkt).length}/${toScan.length} aktywow`);

  // ── Salda ─────────────────────────────────────────────────────────────────
  const pureSim = CFG.DRY_RUN && !keypair;
  let bal;
  if (pureSim) {
    bal = { sol: state.simSol ?? 0, usdc: state.simUsdc ?? envNum('DRY_START_USDC', 500), tok: state.simTok || {} };
  } else if (CFG.DRY_RUN) {
    const real = await getBalances(conn, owner);
    bal = {
      sol: state.simSol ?? real.sol,
      usdc: state.simUsdc ?? (real.usdc || envNum('DRY_START_USDC', 500)),
      tok: state.simTok || real.tok,
    };
    log(`> saldo realne ${real.sol.toFixed(4)} SOL + ${usd(real.usdc)} USDC; symulacja jedzie osobno`);
  } else {
    bal = await getBalances(conn, owner);
  }
  const feeReserve = pureSim ? 0 : CFG.FEE_RESERVE_SOL;

  // ── Ceny i kapital ────────────────────────────────────────────────────────
  const prices = {};
  for (const sym of Object.keys(mkt)) prices[sym] = mkt[sym].price;
  for (const sym of Object.keys(state.positions)) {
    if (!pureSim) {
      const p = await livePrice(sym);
      if (p) prices[sym] = p;
    }
  }

  const valueOf = (sym) => heldQty(bal, sym) * (prices[sym] || 0);
  const equityUsd =
    bal.usdc + [...new Set([...Object.keys(prices), 'SOL'])].reduce((a, s) => a + (prices[s] ? valueOf(s) : 0), 0);
  log(`> kapital ${usd(equityUsd)} (${usd(bal.usdc)} gotowki)`);

  if (state.startEquity == null) state.startEquity = equityUsd;
  state.peakEquity = Math.max(state.peakEquity ?? equityUsd, equityUsd);

  if (state.day?.date !== utcDay()) {
    state.day = { date: utcDay(), startEquity: equityUsd, realized: 0, trades: 0 };
    if (state.haltReason === 'dzienny limit straty') {
      state.halted = false;
      state.haltReason = null;
      log('> nowa doba — dzienny bezpiecznik zdjety');
    }
  }
  if (state.day.startEquity == null) state.day.startEquity = equityUsd;

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

  const actions = [];
  const newTrades = [];

  // ── Wyjscia ───────────────────────────────────────────────────────────────
  for (const sym of Object.keys(state.positions)) {
    const pos = state.positions[sym];
    const m = mkt[sym];
    const price = prices[sym];
    if (!m || !price) {
      log(`! ${sym}: brak danych, zostawiam pozycje bez zmian`);
      continue;
    }

    pos.maxPrice = Math.max(pos.maxPrice || pos.entryPrice, price);
    if (!pos.trailArmed && price - pos.entryPrice >= CFG.TRAIL_ARM_ATR * (pos.atrAtEntry || m.atr)) {
      pos.trailArmed = true;
      log(`> ${sym}: trailing stop uzbrojony`);
    }

    const ex = CFG.FORCE_SELL
      ? { exit: true, reason: 'reczne wymuszenie sprzedazy' }
      : state.halted
        ? { exit: true, reason: `bezpiecznik: ${state.haltReason}` }
        : exitSignal(pos, m, price);

    const available = sym === 'SOL' ? Math.max(0, heldQty(bal, sym) - feeReserve) : heldQty(bal, sym);
    const sellQty = Math.min(available, pos.qty || available);

    if (!ex.exit) {
      log(`> ${sym}: trzymam (${ex.reason})`);
      continue;
    }
    if (sellQty <= 0) {
      log(`! ${sym}: mialem sprzedac (${ex.reason}) ale nie ma czego — zamykam wpis`);
      delete state.positions[sym];
      continue;
    }

    log(`> ${sym}: SPRZEDAJE ${qty(sellQty)} — ${ex.reason}`);
    let gotUsdc;
    let sig = null;
    try {
      if (CFG.DRY_RUN) {
        gotUsdc = sellQty * price * (1 - (CFG.EST_COST_PCT * UNIVERSE[sym].costMul) / 2);
        if (sym === 'SOL') bal.sol -= sellQty;
        else bal.tok[UNIVERSE[sym].mint] = (bal.tok[UNIVERSE[sym].mint] || 0) - sellQty;
        bal.usdc += gotUsdc;
      } else {
        const before = await getBalances(conn, owner);
        const r = await swap(
          conn,
          keypair,
          UNIVERSE[sym].mint,
          USDC.mint,
          Math.floor(sellQty * 10 ** UNIVERSE[sym].dec)
        );
        sig = r.sig;
        await sleep(4000);
        const after = await getBalances(conn, owner);
        gotUsdc = Math.max(0, after.usdc - before.usdc);
        bal = after;
      }
    } catch (e) {
      log(`! ${sym}: sprzedaz nieudana — ${e.message.slice(0, 160)}`);
      continue;
    }

    const pnlUsd = gotUsdc - pos.costUsd;
    const pnlPct = pos.costUsd > 0 ? pnlUsd / pos.costUsd : 0;

    state.stats.trades += 1;
    state.stats.realizedPnl += pnlUsd;
    state.stats.volumeUsd += gotUsdc;
    if (pnlUsd >= 0) state.stats.wins += 1;
    else state.stats.losses += 1;
    state.stats.bestUsd = Math.max(state.stats.bestUsd || 0, pnlUsd);
    state.stats.worstUsd = Math.min(state.stats.worstUsd || 0, pnlUsd);
    state.day.realized += pnlUsd;
    state.day.trades += 1;

    const pa = state.perAsset[sym] || { trades: 0, wins: 0, pnl: 0 };
    pa.trades += 1;
    if (pnlUsd >= 0) pa.wins += 1;
    pa.pnl += pnlUsd;
    state.perAsset[sym] = pa;

    if (pnlUsd < 0) {
      state.cooldowns[sym] = Date.now() + CFG.COOLDOWN_MIN * 60000;
      log(`> ${sym}: strata — pauza na ${CFG.COOLDOWN_MIN} min`);
    }

    newTrades.push({
      id: `${Date.now()}-${sym}`,
      ts: nowISO(),
      sym,
      type: 'SELL',
      price,
      qty: sellQty,
      usd: gotUsdc,
      pnlUsd,
      pnlPct,
      holdMs: Date.now() - new Date(pos.entryTs).getTime(),
      entryPrice: pos.entryPrice,
      reason: ex.reason,
      sig,
      dry: CFG.DRY_RUN,
    });
    delete state.positions[sym];
    actions.push(`SELL ${sym}`);
    log(`> ${sym}: zamkniete ${pnlUsd >= 0 ? '+' : ''}${usd(pnlUsd)} (${pct(pnlPct)})`);
  }

  // ── Skan kandydatow ───────────────────────────────────────────────────────
  const scan = [];
  for (const sym of assets) {
    const m = mkt[sym];
    if (!m) {
      scan.push({ sym, score: 0, reason: 'brak danych', held: false });
      continue;
    }
    const held = !!state.positions[sym];
    const cd = state.cooldowns[sym] || 0;
    const sig = entrySignal(sym, m);
    scan.push({
      sym,
      price: m.price,
      score: sig.score,
      rsi: m.rsi,
      volPct: m.volPct,
      trend: m.emaFast > m.emaSlow && m.price > m.emaTrend ? 'up' : 'down',
      reason: held
        ? 'trzymam pozycje'
        : Date.now() < cd
          ? `pauza po stracie jeszcze ${Math.ceil((cd - Date.now()) / 60000)} min`
          : sig.reason,
      enter: sig.enter && !held && Date.now() >= cd,
      held,
    });
  }
  scan.sort((a, b) => b.score - a.score);
  log('> skaner:');
  for (const c of scan) {
    const t = c.trend === 'up' ? 'trend+' : 'trend-';
    const r = c.rsi != null ? `RSI ${c.rsi.toFixed(1)}` : 'RSI —';
    log(`   ${c.sym.padEnd(7)} score ${String(c.score).padStart(2)}  ${t}  ${r.padEnd(9)}  ${c.reason}`);
  }

  // ── Wejscia ───────────────────────────────────────────────────────────────
  const blockers = [];
  if (state.halted) blockers.push(`bezpiecznik: ${state.haltReason}`);
  if (CFG.FORCE_SELL) blockers.push('tryb wymuszonej sprzedazy');
  if (state.day.trades >= CFG.MAX_TRADES_PER_DAY) {
    blockers.push(`limit ${CFG.MAX_TRADES_PER_DAY} trejdow na dobe wyczerpany`);
  }
  if (!pureSim && bal.sol < CFG.FEE_RESERVE_SOL / 2) {
    blockers.push(`za malo SOL na oplaty (${bal.sol.toFixed(4)}) — dorzuc troche SOL`);
  }

  let slots = CFG.MAX_POSITIONS - Object.keys(state.positions).length;
  if (slots <= 0) blockers.push(`wszystkie ${CFG.MAX_POSITIONS} sloty zajete`);

  if (!blockers.length) {
    for (const cand of scan.filter((c) => c.enter)) {
      if (slots <= 0) break;
      const sym = cand.sym;
      const m = mkt[sym];
      const budget = Math.min(bal.usdc, equityUsd * CFG.ALLOC_PCT, CFG.MAX_TRADE_USD);
      if (budget < CFG.MIN_TRADE_USD) {
        log(`> ${sym}: budzet ${usd(budget)} ponizej minimum, koniec wejsc`);
        break;
      }

      const price = (!pureSim && (await livePrice(sym))) || m.price;
      log(`> ${sym}: KUPUJE za ${usd(budget)} — ${cand.reason}`);

      let gotQty;
      let txSig = null;
      try {
        if (CFG.DRY_RUN) {
          gotQty = (budget / price) * (1 - (CFG.EST_COST_PCT * UNIVERSE[sym].costMul) / 2);
          if (sym === 'SOL') bal.sol += gotQty;
          else bal.tok[UNIVERSE[sym].mint] = (bal.tok[UNIVERSE[sym].mint] || 0) + gotQty;
          bal.usdc -= budget;
        } else {
          const before = await getBalances(conn, owner);
          const r = await swap(
            conn,
            keypair,
            USDC.mint,
            UNIVERSE[sym].mint,
            Math.floor(budget * 10 ** USDC.dec)
          );
          txSig = r.sig;
          await sleep(4000);
          const after = await getBalances(conn, owner);
          gotQty = Math.max(0, heldQty(after, sym) - heldQty(before, sym));
          bal = after;
        }
      } catch (e) {
        log(`! ${sym}: zakup nieudany — ${e.message.slice(0, 160)}`);
        continue;
      }

      if (gotQty <= 0) {
        log(`! ${sym}: swap nie dodal nic do salda, pomijam`);
        continue;
      }

      const entryPrice = budget / gotQty;
      state.positions[sym] = {
        sym,
        entryPrice,
        entryTs: nowISO(),
        qty: gotQty,
        costUsd: budget,
        atrAtEntry: m.atr,
        stopPrice: price - CFG.STOP_ATR * m.atr,
        takeProfit: price + CFG.TAKE_PROFIT_ATR * m.atr,
        maxPrice: price,
        trailArmed: false,
        sig: txSig,
      };
      state.stats.volumeUsd += budget;
      state.day.trades += 1;
      slots -= 1;

      newTrades.push({
        id: `${Date.now()}-${sym}`,
        ts: nowISO(),
        sym,
        type: 'BUY',
        price: entryPrice,
        qty: gotQty,
        usd: budget,
        pnlUsd: null,
        pnlPct: null,
        reason: cand.reason,
        stopPrice: state.positions[sym].stopPrice,
        takeProfit: state.positions[sym].takeProfit,
        sig: txSig,
        dry: CFG.DRY_RUN,
      });
      actions.push(`BUY ${sym}`);
      log(`> ${sym}: wszedlem ${qty(gotQty)} po ${usd(entryPrice)}, stop ${usd(state.positions[sym].stopPrice)}`);
    }
  } else {
    log(`> nie kupuje: ${blockers.join(' | ')}`);
  }

  // ── Zapis ─────────────────────────────────────────────────────────────────
  const finalEquity =
    bal.usdc + [...new Set([...Object.keys(prices), 'SOL'])].reduce((a, s) => a + (prices[s] ? valueOf(s) : 0), 0);
  const unrealized = Object.entries(state.positions).reduce(
    (a, [sym, p]) => a + (prices[sym] ? p.qty * prices[sym] - p.costUsd : 0),
    0
  );

  if (pureSim) {
    state.simSol = bal.sol;
    state.simUsdc = bal.usdc;
    state.simTok = bal.tok;
  }

  const action = actions.length ? actions.join(', ') : 'HOLD';
  const topReason = actions.length
    ? actions.join(', ')
    : blockers.length
      ? blockers.join(' | ')
      : scan.length
        ? `najlepszy kandydat ${scan[0].sym}: ${scan[0].reason}`
        : 'brak kandydatow';

  state.updatedAt = nowISO();
  state.lastRun = {
    ts: nowISO(),
    action,
    reason: topReason,
    equityUsd: finalEquity,
    unrealizedUsd: unrealized,
    scanned: Object.keys(mkt).length,
    slotsFree: Math.max(0, CFG.MAX_POSITIONS - Object.keys(state.positions).length),
    maxPositions: CFG.MAX_POSITIONS,
    scan,
    prices,
    balances: { sol: bal.sol, usdc: bal.usdc },
  };
  state.peakEquity = Math.max(state.peakEquity ?? finalEquity, finalEquity);

  for (const t of newTrades) trades.push(t);
  while (trades.length > MAX_TRADES_KEPT) trades.shift();

  equity.push({
    ts: Date.now(),
    equityUsd: finalEquity,
    usdc: bal.usdc,
    pos: Object.keys(state.positions).length,
    realized: state.stats.realizedPnl,
  });
  while (equity.length > MAX_EQUITY_KEPT) equity.shift();

  writeJSON(F_STATE, state);
  writeJSON(F_TRADES, trades);
  writeJSON(F_EQUITY, equity);

  const roi = state.startEquity > 0 ? (finalEquity - state.startEquity) / state.startEquity : 0;
  log(`=== ${action} | kapital ${usd(finalEquity)} | zrealizowane ${usd(state.stats.realizedPnl)} | ROI ${pct(roi)} ===`);

  return { action, reason: topReason, finalEquity, roi, state, scan };
}

function writeSummary(result, error) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  const lines = ['# Hajsomat', ''];
  if (error) {
    lines.push(`**Blad:** \`${error.message}\``, '');
  } else if (result) {
    const s = result.state;
    const open = Object.entries(s.positions);
    lines.push(
      `**Akcja:** ${result.action}`,
      `**Powod:** ${result.reason}`,
      '',
      '| | |',
      '|---|---|',
      `| Tryb | ${CFG.DRY_RUN ? 'DRY-RUN' : 'LIVE'} |`,
      `| Kapital | ${usd(result.finalEquity)} |`,
      `| ROI | ${pct(result.roi)} |`,
      `| Zrealizowane | ${usd(s.stats.realizedPnl)} |`,
      `| Trejdy | ${s.stats.trades} (${s.stats.wins}W / ${s.stats.losses}L) |`,
      `| Pozycje | ${open.length ? open.map(([k, p]) => `${k} @ ${usd(p.entryPrice)}`).join(', ') : 'brak (cash)'} |`,
      `| Bezpiecznik | ${s.halted ? `AKTYWNY — ${s.haltReason}` : 'ok'} |`,
      '',
      '## Skaner',
      '',
      '| Aktyw | Cena | Score | RSI | Zmiennosc | Ocena |',
      '|---|---|---|---|---|---|',
      ...result.scan.map(
        (c) =>
          `| ${c.sym} | ${c.price ? usd(c.price) : '—'} | ${c.score} | ${c.rsi ? c.rsi.toFixed(1) : '—'} | ${c.volPct ? pct(c.volPct) : '—'} | ${c.reason} |`
      ),
      ''
    );
  }
  lines.push('<details><summary>Log</summary>', '', '```', ...LOG, '```', '</details>');
  try {
    fs.appendFileSync(f, lines.join('\n') + '\n');
  } catch {
    /* summary to kosmetyka */
  }
}

try {
  const result = await main();
  writeSummary(result, null);
} catch (e) {
  log(`!! BLAD: ${e.message}`);
  if (e.stack) console.error(e.stack);
  writeSummary(null, e);
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
