/**
 * HAJSOMAT — bot kontraktów wieczystych (SYMULACJA).
 *
 * Osobny bot obok spotowego. Dwie rzeczy, których tamten nie potrafi:
 *   1. gra na spadki (short) — a wiekszosc badanej historii to bessa,
 *   2. dzwignia — ruchy widac od razu, wiec do obserwacji jest ciekawszy.
 *
 * WAZNE: ten plik wylacznie SYMULUJE. Nie wysyla zadnych transakcji do zadnej
 * gieldy. Zeby handlowac naprawde, trzeba dopisac integracje z API Jupiter Perps
 * (endpointy positions/increase, positions/decrease, tpsl) — swiadomie tego nie
 * zrobilem, bo backtesty pokazuja, ze sygnal nie ma przewagi, a dzwignia bez
 * przewagi to tylko szybsza droga do zera.
 *
 * Model kosztow odwzorowuje Jupiter Perps (stawki zmierzone z ich API 26.07.2026):
 *   - otwarcie i zamkniecie: po 0,06% wartosci pozycji,
 *   - odsetki godzinowe: long 0,0014%, short 0,0006% wartosci pozycji,
 *   - brak doplat miedzy stronami — na Jupiterze obie strony placa do puli.
 *
 * Stan trafia do state/perp-*.json, wiec nie miesza sie z botem spotowym.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNIVERSE, CFG, envNum, envBool, usd, pct, analyze, entrySignal,
  warunki, wychylenia, migawkaRynku, zmianaRynku,
} from './strategy.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguracja
// ─────────────────────────────────────────────────────────────────────────────

const P = {
  START_USD: envNum('PERP_START_USD', 500),
  LEVERAGE: envNum('PERP_LEVERAGE', 3),
  MAX_POSITIONS: envNum('PERP_MAX_POSITIONS', 2),
  ALLOC_PCT: envNum('PERP_ALLOC_PCT', 0.4), // ile kapitalu na depozyt jednej pozycji
  ALLOW_SHORT: envBool('PERP_ALLOW_SHORT', true),
  ALLOW_LONG: envBool('PERP_ALLOW_LONG', true),

  OPEN_FEE: envNum('PERP_OPEN_FEE', 0.0006), // 0,06% wartosci pozycji
  BORROW_LONG_H: envNum('PERP_BORROW_LONG_H', 0.000014), // 0,0014% na godzine
  BORROW_SHORT_H: envNum('PERP_BORROW_SHORT_H', 0.000006),

  // Przy jakiej stracie depozytu gielda zamyka pozycje. 0,9 = tracimy 90%
  // depozytu i wtedy wylatujemy — reszta idzie na oplate likwidacyjna.
  LIQ_AT: envNum('PERP_LIQ_AT', 0.9),

  MIN_MARGIN_USD: envNum('PERP_MIN_MARGIN_USD', 20),

  // ── Hamulce czasowe: domyslnie WYLACZONE ────────────────────────────────────
  //
  // Wczesniej bot stal bezczynnie po kilkanascie godzin na dobe, choc widzial
  // okazje. Limit dobowy i pauza po stracie nie chronily przed niczym, czego nie
  // pilnuje juz stop loss — ograniczaly tylko liczbe okazji.
  //
  // Wylaczenie ich ma tez druga zalete, wazniejsza niz sam handel: liga potrzebuje
  // okolo 560 trejdow na gracza, zeby cokolwiek rozstrzygnac. Przy pieciu trejdach
  // dziennie to byly lata. Wiecej wejsc to szybsza odpowiedz na pytanie, czy
  // ktorakolwiek strategia w ogole bije rzut moneta.
  //
  // 0 = bez limitu. Wlaczysz z powrotem, ustawiajac liczbe.
  MAX_TRADES_PER_DAY: envNum('PERP_MAX_TRADES_PER_DAY', 0),
  COOLDOWN_MIN: envNum('PERP_COOLDOWN_MIN', 0),

  // Ile pozycji naraz. Kazda zjada ALLOC_PCT kapitalu, wiec to nie jest hamulec
  // czasowy tylko podzial pieniedzy — przy 0,4 wiecej niz dwie i tak sie nie zmiesci.
  MAX_POSITIONS: envNum('PERP_MAX_POSITIONS', 2),

  // ── Bezpiecznik, ktorego NIE wylaczam sam ───────────────────────────────────
  //
  // Ten jeden zostaje. Nie powoduje bezczynnosci — przy obsunieciu 3,6% jest
  // daleko od progu 40% i nigdy sie nie odezwal. Odezwie sie dopiero, gdy cos
  // pojdzie naprawde zle, i wtedy jego zadaniem jest zatrzymac bota, zanim
  // zamieni symulacje w wykres spadajacy do zera bez zadnej informacji dla nas.
  //
  // Chcesz calkiem bez hamulcow: PERP_MAX_DRAWDOWN_PCT=1 w deploy/.env
  MAX_DRAWDOWN_PCT: envNum('PERP_MAX_DRAWDOWN_PCT', 0.4),
  RESET: envBool('PERP_RESET', false),
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'state');
const F_STATE = path.join(DIR, 'perp-state.json');
const F_TRADES = path.join(DIR, 'perp-trades.json');
const F_EQUITY = path.join(DIR, 'perp-equity.json');

const LOG = [];
const log = (...a) => {
  const s = a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
  LOG.push(s);
  console.log(s);
};
const nowISO = () => new Date().toISOString();
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qty = (n) => (Math.abs(n) >= 1000 ? Number(n).toFixed(0) : Number(n).toPrecision(6));

function readJSON(f, d) {
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d;
  } catch {
    return d;
  }
}
function writeJSON(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Swiece
// ─────────────────────────────────────────────────────────────────────────────

async function fetchJSON(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'hajsomat-perp/1.0' } });
      clearTimeout(t);
      const txt = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(txt);
    } catch (e) {
      err = e;
      if (i < tries - 1) await sleep(1000 * (i + 1));
    }
  }
  throw err;
}

async function getCandles(sym, minutes) {
  const pair = UNIVERSE[sym].kraken;
  try {
    const j = await fetchJSON(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${minutes}`);
    if (j.error?.length) throw new Error(j.error.join(','));
    const k = Object.keys(j.result).find((x) => x !== 'last');
    const c = j.result[k].map((r) => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] }));
    if (c.length >= 60) return c;
  } catch {
    /* nastepne zrodlo */
  }
  const arr = await fetchJSON(
    `https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${minutes}m&limit=500`
  );
  return arr.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sygnaly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sygnal na spadek — lustrzane odbicie sygnalu na wzrost.
 * Trend spadkowy, RSI w oknie (odbitym), odbicie w gore do sredniej zamiast
 * cofniecia w dol, ta sama bramka oplacalnosci.
 */
function shortSignal(sym, m) {
  const costPct = CFG.EST_COST_PCT * (UNIVERSE[sym].costMul || 1) + P.OPEN_FEE * 2;
  const good = [];
  let score = 0;

  if (!(m.price < m.emaTrend && m.emaFast < m.emaSlow)) {
    return { score: 0, enter: false, reason: 'brak trendu spadkowego' };
  }
  score += 3;
  good.push('trend spadkowy');

  if (m.trendSlope < -0.0005) {
    score += 1;
    good.push('trend przyspiesza');
  }
  if (m.volPct < CFG.MIN_VOL_PCT) return { score, enter: false, reason: `zmiennosc ${pct(m.volPct)} za niska` };
  if (m.volPct > CFG.MAX_VOL_PCT) return { score, enter: false, reason: `zmiennosc ${pct(m.volPct)} za wysoka` };
  score += 1;

  // Okno RSI odbite: to, co dla dlugiej pozycji bylo 38-68, tu jest 32-62.
  const lo = 100 - CFG.RSI_MAX;
  const hi = 100 - CFG.RSI_MIN;
  if (m.rsi > hi) return { score, enter: false, reason: `RSI ${m.rsi.toFixed(1)} — jeszcze nie spada` };
  if (m.rsi < lo) return { score, enter: false, reason: `RSI ${m.rsi.toFixed(1)} — wyprzedane, nie gonie dolu` };
  score += 1;
  good.push(`RSI ${m.rsi.toFixed(1)}`);

  // Odbicie w gore do sredniej — lustro "cofniecia" z sygnalu dlugiego.
  const ext = (m.emaFast - m.price) / m.atr;
  if (ext > CFG.MAX_EXT_ATR) {
    return { score, enter: false, reason: `${ext.toFixed(2)} ATR pod srednia — za nisko, czekam na odbicie` };
  }
  score += 2;
  good.push('odbicie do sredniej');

  if (m.rsi < m.rsiPrev) {
    score += 1;
    good.push('RSI zawraca w dol');
  }

  const expected = (CFG.TAKE_PROFIT_ATR * m.atr) / m.price;
  if (expected < costPct * CFG.COST_EDGE_MULT) {
    return { score, enter: false, reason: `potencjal ${pct(expected)} maly wobec kosztow ${pct(costPct)}` };
  }
  score += 1;

  const enter = score >= CFG.MIN_SCORE;
  return { score, enter, reason: enter ? `SHORT: ${good.join(', ')}` : `score ${score}/${CFG.MIN_SCORE}` };
}

/** Cena, przy ktorej gielda zamyka pozycje i depozyt przepada. */
const liqPrice = (side, entry, lev) =>
  side === 'LONG' ? entry * (1 - (P.LIQ_AT / lev)) : entry * (1 + (P.LIQ_AT / lev));

/** Wynik pozycji w dolarach przy danej cenie (bez odsetek). */
const pnlAt = (pos, price) =>
  pos.side === 'LONG' ? pos.qty * (price - pos.entryPrice) : pos.qty * (pos.entryPrice - price);

function perpExit(pos, m, price) {
  const long = pos.side === 'LONG';
  const a = pos.atrAtEntry || m.atr;
  const gain = long ? (price - pos.entryPrice) / a : (pos.entryPrice - price) / a;
  const heldH = (Date.now() - Date.parse(pos.entryTs)) / 3600000;

  if (long ? price <= pos.stopPrice : price >= pos.stopPrice) {
    return { exit: true, reason: `STOP LOSS przy ${usd(price)}` };
  }
  if (long ? price >= pos.takeProfit : price <= pos.takeProfit) {
    return { exit: true, reason: `TAKE PROFIT (+${gain.toFixed(2)} ATR)` };
  }
  if (pos.trailArmed) {
    const trail = long ? pos.bestPrice - CFG.TRAIL_ATR * a : pos.bestPrice + CFG.TRAIL_ATR * a;
    if (long ? price <= trail : price >= trail) return { exit: true, reason: 'TRAILING STOP' };
  }
  const flip = long ? m.emaFast < m.emaSlow && price < m.emaTrend : m.emaFast > m.emaSlow && price > m.emaTrend;
  if (flip) return { exit: true, reason: 'trend sie odwrocil' };
  if (heldH > CFG.MAX_HOLD_HOURS && gain < 0) {
    return { exit: true, reason: `stop czasowy — ${heldH.toFixed(1)}h pod woda` };
  }
  return { exit: false, reason: `${gain >= 0 ? '+' : ''}${gain.toFixed(2)} ATR, ${heldH.toFixed(1)}h` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stan
// ─────────────────────────────────────────────────────────────────────────────

const fresh = () => ({
  version: 1,
  kind: 'perp-sim',
  createdAt: nowISO(),
  updatedAt: nowISO(),
  cash: P.START_USD,
  startEquity: P.START_USD,
  peakEquity: P.START_USD,
  positions: {},
  cooldowns: {},
  halted: false,
  haltReason: null,
  day: { date: utcDay(), trades: 0 },
  stats: { trades: 0, wins: 0, losses: 0, liquidations: 0, realizedPnl: 0, feesUsd: 0, borrowUsd: 0 },
  perAsset: {},
  lastRun: null,
});

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log(`=== HAJSOMAT PERP (symulacja) ${nowISO()} ===`);
  log(`> dzwignia ${P.LEVERAGE}x, max ${P.MAX_POSITIONS} pozycji, ${P.ALLOW_SHORT ? 'long i short' : 'tylko long'}`);

  const base = fresh();
  const saved = P.RESET ? {} : readJSON(F_STATE, {});
  const st = {
    ...base,
    ...saved,
    stats: { ...base.stats, ...(saved.stats || {}) },
    day: { ...base.day, ...(saved.day || {}) },
    positions: saved.positions || {},
    cooldowns: saved.cooldowns || {},
    perAsset: saved.perAsset || {},
  };
  if (P.RESET) log('> reset symulacji');
  delete st.lastError;

  let trades = readJSON(F_TRADES, []);
  let equity = readJSON(F_EQUITY, []);
  if (P.RESET) {
    trades = [];
    equity = [];
  }
  if (st.day.date !== utcDay()) st.day = { date: utcDay(), trades: 0 };

  const assets = CFG.ASSETS.filter((s) => UNIVERSE[s]);
  const mkt = {};
  for (const sym of [...new Set([...assets, ...Object.keys(st.positions)])]) {
    if (!UNIVERSE[sym]) continue;
    try {
      const m = analyze(await getCandles(sym, CFG.CANDLE_MINUTES), CFG);
      if (m.emaTrend && m.atr && m.rsi != null) mkt[sym] = m;
    } catch (e) {
      log(`! ${sym}: ${String(e.message).slice(0, 80)}`);
    }
    await sleep(350);
  }
  if (!Object.keys(mkt).length) throw new Error('brak danych rynkowych');
  log(`> zeskanowano ${Object.keys(mkt).length} aktywow`);

  const actions = [];
  const newTrades = [];

  // ── odsetki, likwidacje i wyjscia ─────────────────────────────────────────
  for (const sym of Object.keys(st.positions)) {
    const pos = st.positions[sym];
    const m = mkt[sym];
    if (!m) continue;
    const price = m.price;

    // odsetki naliczane od ostatniego sprawdzenia
    const hours = Math.max(0, (Date.now() - Date.parse(pos.lastAccrual || pos.entryTs)) / 3600000);
    const rate = pos.side === 'LONG' ? P.BORROW_LONG_H : P.BORROW_SHORT_H;
    const borrow = pos.notional * rate * hours;
    pos.borrowPaid = (pos.borrowPaid || 0) + borrow;
    pos.lastAccrual = nowISO();
    st.stats.borrowUsd += borrow;

    pos.bestPrice =
      pos.side === 'LONG' ? Math.max(pos.bestPrice ?? pos.entryPrice, price) : Math.min(pos.bestPrice ?? pos.entryPrice, price);
    // Najgorsza cena nie jest potrzebna do handlu — jest potrzebna, zeby pozniej
    // odpowiedziec, czy stop byl o wlos od wyrzucenia nas z dobrej pozycji.
    pos.worstPrice =
      pos.side === 'LONG' ? Math.min(pos.worstPrice ?? pos.entryPrice, price) : Math.max(pos.worstPrice ?? pos.entryPrice, price);
    const armAt = CFG.TRAIL_ARM_ATR * (pos.atrAtEntry || m.atr);
    if (!pos.trailArmed && (pos.side === 'LONG' ? price - pos.entryPrice : pos.entryPrice - price) >= armAt) {
      pos.trailArmed = true;
      log(`> ${sym}: trailing uzbrojony`);
    }

    // likwidacja ma pierwszenstwo przed wszystkim
    const liquidated = pos.side === 'LONG' ? price <= pos.liqPrice : price >= pos.liqPrice;
    const ex = liquidated ? { exit: true, reason: 'LIKWIDACJA — depozyt przepadl' } : perpExit(pos, m, price);
    if (!ex.exit) {
      log(`> ${sym} ${pos.side}: trzymam (${ex.reason})`);
      continue;
    }

    const gross = liquidated ? -pos.margin : pnlAt(pos, price);
    const closeFee = liquidated ? 0 : pos.notional * P.OPEN_FEE;
    const net = gross - closeFee - pos.borrowPaid;
    st.cash += liquidated ? 0 : pos.margin + net;
    st.stats.feesUsd += closeFee;
    st.stats.trades += 1;
    st.stats.realizedPnl += liquidated ? -pos.margin : net;
    if (liquidated) st.stats.liquidations += 1;
    if (!liquidated && net >= 0) st.stats.wins += 1;
    else st.stats.losses += 1;
    // Licznik dobowy NIE rosnie przy zamknieciu. Limit ma ograniczac to, ile razy
    // bot decyduje sie wejsc na rynek — zamkniecie nie jest decyzja, tylko skutkiem
    // stopa albo take profitu, i tak czy siak zostanie wykonane, bo limit blokuje
    // wylacznie otwieranie. Liczenie go tutaj zjadalo polowe budzetu za nic:
    // przy limicie 10 bot mial faktycznie 5 pelnych trejdow na dobe, nie 10.
    if (net < 0 && P.COOLDOWN_MIN > 0) st.cooldowns[sym] = Date.now() + P.COOLDOWN_MIN * 60000;

    const pa = st.perAsset[sym] || { trades: 0, wins: 0, pnl: 0 };
    pa.trades += 1;
    if (!liquidated && net >= 0) pa.wins += 1;
    pa.pnl += liquidated ? -pos.margin : net;
    st.perAsset[sym] = pa;

    newTrades.push({
      id: `${Date.now()}-${sym}`,
      ts: nowISO(),
      sym,
      side: pos.side,
      type: 'CLOSE',
      price,
      entryPrice: pos.entryPrice,
      qty: pos.qty,
      notional: pos.notional,
      margin: pos.margin,
      leverage: pos.leverage,
      pnlUsd: liquidated ? -pos.margin : net,
      pnlPct: pos.margin > 0 ? (liquidated ? -1 : net / pos.margin) : 0,
      borrowUsd: pos.borrowPaid,
      holdMs: Date.now() - Date.parse(pos.entryTs),
      liquidated,
      reason: ex.reason,
      // dlaczego weszlismy + jakie byly wtedy liczby, obok wyniku tego wejscia
      powodWejscia: pos.powodWejscia || null,
      warunki: pos.warunkiWejscia || null,
      prognoza: pos.prognoza || null,
      odrzucone: pos.odrzucone || null,
      // jak daleko cena zaszla w obie strony, zanim zamknelismy
      ...wychylenia(pos, pos.atrAtEntry || m.atr),
      // co robil w tym czasie caly rynek — zeby odroznic zly sygnal od zwyklego zjazdu
      rynek: zmianaRynku(
        pos.rynekWejscie,
        migawkaRynku(Object.fromEntries(Object.entries(mkt).map(([s, x]) => [s, x.price])))
      ),
      dry: true,
    });
    delete st.positions[sym];
    actions.push(`${liquidated ? 'LIKWIDACJA' : 'ZAMKNIECIE'} ${pos.side} ${sym}`);
    log(`> ${sym}: ${ex.reason} | wynik ${usd(liquidated ? -pos.margin : net)}`);
  }

  // ── kapital i bezpieczniki ────────────────────────────────────────────────
  const openPnl = Object.entries(st.positions).reduce(
    (a, [s, p]) => a + (mkt[s] ? pnlAt(p, mkt[s].price) - (p.borrowPaid || 0) : 0),
    0
  );
  const marginLocked = Object.values(st.positions).reduce((a, p) => a + p.margin, 0);
  let equityUsd = st.cash + marginLocked + openPnl;
  st.peakEquity = Math.max(st.peakEquity || equityUsd, equityUsd);
  const dd = st.peakEquity > 0 ? (st.peakEquity - equityUsd) / st.peakEquity : 0;
  if (!st.halted && dd > P.MAX_DRAWDOWN_PCT) {
    st.halted = true;
    st.haltReason = `obsuniecie ${pct(dd)}`;
    log(`!! STOP: ${st.haltReason}`);
  }
  log(`> kapital ${usd(equityUsd)} (wolne ${usd(st.cash)}, w pozycjach ${usd(marginLocked)})`);

  // ── skan i wejscia ────────────────────────────────────────────────────────
  const scan = [];
  for (const sym of assets) {
    const m = mkt[sym];
    if (!m) continue;
    const held = st.positions[sym];
    // Przy wylaczonej pauzie ignorujemy tez te zapisane wczesniej — inaczej stara
    // pauza z pliku stanu blokowalaby wejscie jeszcze po zmianie ustawienia.
    const cd = P.COOLDOWN_MIN > 0 ? st.cooldowns[sym] || 0 : 0;
    const L = P.ALLOW_LONG ? entrySignal(sym, m, CFG, {}) : { enter: false, score: 0, reason: 'long wylaczony' };
    const S = P.ALLOW_SHORT ? shortSignal(sym, m) : { enter: false, score: 0, reason: 'short wylaczony' };
    const best = S.score > L.score ? { ...S, side: 'SHORT' } : { ...L, side: 'LONG' };
    scan.push({
      sym,
      price: m.price,
      side: best.side,
      score: best.score,
      rsi: m.rsi,
      volPct: m.volPct,
      enter: best.enter && !held && Date.now() >= cd,
      held: held ? held.side : null,
      reason: held ? `trzymam ${held.side}` : Date.now() < cd ? 'pauza po stracie' : best.reason,
      // prognoza bota: ile ruchu spodziewa sie zlapac wobec tego, ile ma zaplacic
      expectedMove: best.expectedMove ?? null,
      costPct: best.costPct ?? null,
    });
  }
  scan.sort((a, b) => b.score - a.score);
  log('> skaner:');
  for (const c of scan) log(`   ${c.sym.padEnd(7)} ${c.side.padEnd(5)} score ${String(c.score).padStart(2)}  ${c.reason}`);

  const blockers = [];
  if (st.halted) blockers.push(`bezpiecznik: ${st.haltReason}`);
  // 0 znaczy "bez limitu" — bez tego warunku zero blokowaloby kazde wejscie
  if (P.MAX_TRADES_PER_DAY > 0 && st.day.trades >= P.MAX_TRADES_PER_DAY) {
    blockers.push('limit transakcji na dobe');
  }
  let slots = P.MAX_POSITIONS - Object.keys(st.positions).length;
  if (slots <= 0) blockers.push('wszystkie sloty zajete');

  if (!blockers.length) {
    for (const c of scan.filter((x) => x.enter)) {
      if (slots <= 0) break;
      const m = mkt[c.sym];
      const margin = Math.min(st.cash, equityUsd * P.ALLOC_PCT);
      if (margin < P.MIN_MARGIN_USD) {
        log(`> ${c.sym}: depozyt ${usd(margin)} ponizej minimum`);
        break;
      }
      const price = m.price;
      const notional = margin * P.LEVERAGE;
      const fee = notional * P.OPEN_FEE;
      const q = notional / price;
      const long = c.side === 'LONG';

      st.cash -= margin + fee;
      st.stats.feesUsd += fee;
      st.day.trades += 1;
      slots -= 1;

      st.positions[c.sym] = {
        sym: c.sym,
        side: c.side,
        entryPrice: price,
        entryTs: nowISO(),
        lastAccrual: nowISO(),
        qty: q,
        notional,
        margin,
        leverage: P.LEVERAGE,
        liqPrice: liqPrice(c.side, price, P.LEVERAGE),
        stopPrice: long ? price - CFG.STOP_ATR * m.atr : price + CFG.STOP_ATR * m.atr,
        takeProfit: long ? price + CFG.TAKE_PROFIT_ATR * m.atr : price - CFG.TAKE_PROFIT_ATR * m.atr,
        atrAtEntry: m.atr,
        bestPrice: price,
        worstPrice: price,
        trailArmed: false,
        borrowPaid: 0,
        rynekWejscie: migawkaRynku(Object.fromEntries(Object.entries(mkt).map(([s, x]) => [s, x.price]))),
        // Powod i liczby zostaja PRZY POZYCJI, zeby przy zamknieciu trafily na ten
        // sam wiersz co wynik. Osobno "dlaczego" i osobno "co z tego wyszlo" nie
        // uczy niczego — dopiero jedno obok drugiego da sie policzyc.
        powodWejscia: c.reason,
        warunkiWejscia: warunki(m),
        // Co bot PRZEWIDYWAL w chwili decyzji. Bez tego kazda strata da sie po fakcie
        // opowiedziec jako "przeciez bylo widac" — a z tym da sie sprawdzic, czy
        // przewidywanie bylo blednie ocenione, czy tylko nie wyszlo.
        prognoza: {
          spodziewanyRuch: c.expectedMove != null ? +c.expectedMove.toFixed(5) : null,
          koszt: c.costPct != null ? +c.costPct.toFixed(5) : null,
          score: c.score ?? null,
        },
        // Co jeszcze bylo na stole i dlaczego tego NIE wzielismy. Skaner i tak ocenia
        // wszystkie aktywa co przebieg — bez zapisania tej listy przy trejdzie nie da
        // sie pozniej odpowiedziec, jakie alternatywy w ogole rozwazano.
        odrzucone: scan
          .filter((x) => x.sym !== c.sym)
          .slice(0, 4)
          .map((x) => ({ sym: x.sym, side: x.side, score: x.score, powod: x.reason })),
      };

      newTrades.push({
        id: `${Date.now()}-${c.sym}`,
        ts: nowISO(),
        sym: c.sym,
        side: c.side,
        type: 'OPEN',
        price,
        qty: q,
        notional,
        margin,
        leverage: P.LEVERAGE,
        liqPrice: st.positions[c.sym].liqPrice,
        stopPrice: st.positions[c.sym].stopPrice,
        takeProfit: st.positions[c.sym].takeProfit,
        pnlUsd: null,
        reason: c.reason,
        warunki: st.positions[c.sym].warunkiWejscia,
        dry: true,
      });
      actions.push(`${c.side} ${c.sym}`);
      log(`> ${c.sym}: OTWIERAM ${c.side} ${P.LEVERAGE}x — depozyt ${usd(margin)}, pozycja ${usd(notional)}, likwidacja przy ${usd(st.positions[c.sym].liqPrice)}`);
    }
  } else {
    log(`> nie otwieram: ${blockers.join(' | ')}`);
  }

  // ── zapis ─────────────────────────────────────────────────────────────────
  const finalOpenPnl = Object.entries(st.positions).reduce(
    (a, [s, p]) => a + (mkt[s] ? pnlAt(p, mkt[s].price) - (p.borrowPaid || 0) : 0),
    0
  );
  const finalMargin = Object.values(st.positions).reduce((a, p) => a + p.margin, 0);
  equityUsd = st.cash + finalMargin + finalOpenPnl;

  st.updatedAt = nowISO();
  st.lastRun = {
    ts: nowISO(),
    action: actions.length ? actions.join(', ') : 'HOLD',
    reason: actions.length ? actions.join(', ') : blockers.length ? blockers.join(' | ') : scan[0] ? `${scan[0].sym}: ${scan[0].reason}` : '—',
    equityUsd,
    unrealizedUsd: finalOpenPnl,
    leverage: P.LEVERAGE,
    maxPositions: P.MAX_POSITIONS,
    slotsFree: Math.max(0, P.MAX_POSITIONS - Object.keys(st.positions).length),
    // Zeby w apce dalo sie zobaczyc, DLACZEGO bot stoi, zamiast sie domyslac.
    // Pauzy po stracie licza sie tylko te jeszcze wazne — wygasle nie sa blokada.
    limity: {
      dnia: st.day.trades,
      dniaMax: P.MAX_TRADES_PER_DAY,
      resetZaMs: Date.parse(`${utcDay()}T24:00:00Z`) - Date.now(),
      pauzy:
        P.COOLDOWN_MIN > 0
          ? Object.entries(st.cooldowns || {})
              .filter(([, v]) => v > Date.now())
              .map(([sym, v]) => ({ sym, doMs: v - Date.now() }))
          : [],
      pauzaMin: P.COOLDOWN_MIN,
      obsuniecie: st.peakEquity ? Math.max(0, 1 - equityUsd / st.peakEquity) : 0,
      obsuniecieMax: P.MAX_DRAWDOWN_PCT,
      wstrzymany: !!st.halted,
    },
    scan,
    prices: Object.fromEntries(Object.entries(mkt).map(([s, m]) => [s, m.price])),
  };
  st.peakEquity = Math.max(st.peakEquity || equityUsd, equityUsd);

  for (const t of newTrades) trades.push(t);
  while (trades.length > 500) trades.shift();
  equity.push({ ts: Date.now(), equityUsd, cash: st.cash, pos: Object.keys(st.positions).length, realized: st.stats.realizedPnl });
  while (equity.length > 3000) equity.shift();

  writeJSON(F_STATE, st);
  writeJSON(F_TRADES, trades);
  writeJSON(F_EQUITY, equity);

  const roi = st.startEquity > 0 ? equityUsd / st.startEquity - 1 : 0;
  log(`=== ${st.lastRun.action} | kapital ${usd(equityUsd)} | ROI ${pct(roi)} | likwidacji ${st.stats.liquidations} ===`);
  return { st, equityUsd, roi };
}

try {
  await main();
} catch (e) {
  log(`!! BLAD: ${e.message}`);
  if (e.stack) console.error(e.stack);
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
