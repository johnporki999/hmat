/**
 * HAJSOMAT — wspolna logika strategii.
 *
 * Ten modul jest jedynym zrodlem prawdy dla wskaznikow, sygnalow wejscia
 * i wyjscia oraz konfiguracji. Importuja go dwa programy:
 *   - trade.mjs    — bot produkcyjny (GitHub Actions),
 *   - backtest.mjs — test strategii na danych historycznych.
 *
 * Dzieki temu backtest przechodzi przez identyczny kod decyzyjny co bot.
 * Jesli zmieniasz warunki wejscia/wyjscia, zmieniaj je TUTAJ — oba programy
 * podniosa zmiane automatycznie.
 */

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

export const UNIVERSE = {
  SOL: { mint: 'So11111111111111111111111111111111111111112', dec: 9, kraken: 'SOLUSD', costMul: 1.0 },
  JUP: { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', dec: 6, kraken: 'JUPUSD', costMul: 1.3 },
  JTO: { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', dec: 9, kraken: 'JTOUSD', costMul: 1.4 },
  PYTH: { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', dec: 6, kraken: 'PYTHUSD', costMul: 1.4 },
  RAY: { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', dec: 6, kraken: 'RAYUSD', costMul: 1.3 },
  ORCA: { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', dec: 6, kraken: 'ORCAUSD', costMul: 1.5 },
  RENDER: { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', dec: 8, kraken: 'RENDERUSD', costMul: 1.4 },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', dec: 5, kraken: 'BONKUSD', costMul: 1.6 },
  // Ponizsze sa wylaczone domyslnie — wlacz przez zmienna ASSETS, jesli chcesz.
  // BTC i ETH — jedyne rynki poza SOL, ktore ma naprawde Jupiter Perps.
  // Minty zweryfikowane w API Jupitera 27.07.2026 (cbBTC od Coinbase, ETH portal).
  BTC: { mint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', dec: 8, kraken: 'XBTUSD', costMul: 1.0 },
  ETH: { mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', dec: 8, kraken: 'ETHUSD', costMul: 1.0 },
  W: { mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', dec: 6, kraken: 'WUSD', costMul: 1.5 },
  TNSR: { mint: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6', dec: 9, kraken: 'TNSRUSD', costMul: 1.6 },
  DRIFT: { mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', dec: 6, kraken: 'DRIFTUSD', costMul: 1.6 },
  KMNO: { mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', dec: 6, kraken: 'KMNOUSD', costMul: 1.6 },
  PENGU: { mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', dec: 6, kraken: 'PENGUUSD', costMul: 1.7 },

  // ── uniwersum Ligi B (31.07.2026) ────────────────────────────────────────
  //
  // Dwadziescia cztery alty spoza ekosystemu Solany, dobrane regula zapisana
  // przed wyborem: wszystkie monety z naszego wszechswiata, ktore Kraken
  // notuje do USD (bo serwer stoi w USA, gdzie Binance oddaje 451), bez
  // aktywow ODWZOROWUJACYCH inne (WBTC to opakowany BTC, PAXG to zloto —
  // to nie sa niezalezne rynki), co druga alfabetycznie do 25 sztuk.
  //
  // mint: null — to sa aktywa spoza Solany i bot spotowy ich nie dotyka.
  // Sluza wylacznie Lidze B, ktora jest symulacja na swiecach.
  //
  // costMul 1,5 dla wszystkich: to alty srednie i male, wiec zakladamy koszt
  // wyzszy niz dla SOL, ale nizszy niz dla najbardziej niszowych. Zalozenie
  // celowo ostrozne — zawyzony koszt oznacza mniej trejdow, nie wiecej.
  '1INCH': { mint: null, dec: 18, kraken: '1INCHUSD', costMul: 1.5 },
  ALCX: { mint: null, dec: 18, kraken: 'ALCXUSD', costMul: 1.5 },
  ARB: { mint: null, dec: 18, kraken: 'ARBUSD', costMul: 1.5 },
  ASTR: { mint: null, dec: 18, kraken: 'ASTRUSD', costMul: 1.5 },
  AVA: { mint: null, dec: 18, kraken: 'AVAUSD', costMul: 1.5 },
  BCH: { mint: null, dec: 8, kraken: 'BCHUSD', costMul: 1.5 },
  CELO: { mint: null, dec: 18, kraken: 'CELOUSD', costMul: 1.5 },
  CTSI: { mint: null, dec: 18, kraken: 'CTSIUSD', costMul: 1.5 },
  EDU: { mint: null, dec: 18, kraken: 'EDUUSD', costMul: 1.5 },
  FIDA: { mint: null, dec: 6, kraken: 'FIDAUSD', costMul: 1.5 },
  GALA: { mint: null, dec: 8, kraken: 'GALAUSD', costMul: 1.5 },
  HFT: { mint: null, dec: 18, kraken: 'HFTUSD', costMul: 1.5 },
  JST: { mint: null, dec: 18, kraken: 'JSTUSD', costMul: 1.5 },
  LQTY: { mint: null, dec: 18, kraken: 'LQTYUSD', costMul: 1.5 },
  MASK: { mint: null, dec: 18, kraken: 'MASKUSD', costMul: 1.5 },
  NEO: { mint: null, dec: 8, kraken: 'NEOUSD', costMul: 1.5 },
  OGN: { mint: null, dec: 18, kraken: 'OGNUSD', costMul: 1.5 },
  QNT: { mint: null, dec: 18, kraken: 'QNTUSD', costMul: 1.5 },
  RLC: { mint: null, dec: 9, kraken: 'RLCUSD', costMul: 1.5 },
  SAND: { mint: null, dec: 18, kraken: 'SANDUSD', costMul: 1.5 },
  STORJ: { mint: null, dec: 8, kraken: 'STORJUSD', costMul: 1.5 },
  SUPER: { mint: null, dec: 18, kraken: 'SUPERUSD', costMul: 1.5 },
  VET: { mint: null, dec: 18, kraken: 'VETUSD', costMul: 1.5 },
  YFI: { mint: null, dec: 18, kraken: 'YFIUSD', costMul: 1.5 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguracja
// ─────────────────────────────────────────────────────────────────────────────

export const env = (k, d = '') => {
  const v = process.env[k];
  return v == null || String(v).trim() === '' ? d : String(v).trim();
};
export const envNum = (k, d) => {
  const v = Number.parseFloat(env(k));
  return Number.isFinite(v) ? v : d;
};
export const envBool = (k, d) => {
  const v = env(k).toLowerCase();
  if (!v) return d;
  return ['1', 'true', 'yes', 'y', 'on', 'tak'].includes(v);
};

/**
 * Buduje konfiguracje ze zmiennych srodowiskowych, z opcjonalnymi nadpisaniami.
 * Bot uzywa makeCFG() bez argumentow; backtest podaje nadpisania przy
 * przeszukiwaniu siatki parametrow.
 */
export function makeCFG(overrides = {}) {
  const cfg = {
    DRY_RUN: envBool('DRY_RUN', true),
    FORCE_SELL: envBool('FORCE_SELL', false),
    RESET_HALT: envBool('RESET_HALT', false),
    RESET_SIM: envBool('RESET_SIM', false),

    RPC_URL: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
    // lite-api.jup.ag jest wygaszane (limity stopniowo obcinane az do wycofania).
    // Nowa bramka api.jup.ag dziala takze BEZ klucza (0,5 zapytania/s); darmowy
    // klucz z portal.jup.ag podnosi do 1/s — wpisz go w JUP_API_KEY, jesli chcesz.
    JUP_BASE: 'https://api.jup.ag/swap/v1',
    JUP_API_KEY: env('JUP_API_KEY'),

    ASSETS: env('ASSETS', 'SOL,JUP,JTO,PYTH,RAY,ORCA,RENDER,BONK')
      .toUpperCase()
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    MAX_POSITIONS: envNum('MAX_POSITIONS', 2),

    CANDLE_MINUTES: envNum('CANDLE_MINUTES', 15),

    // Harmonogramy GitHuba bywaja zawodne. Gdy LOOP_MINUTES > 0, jeden przebieg
    // pracuje przez tyle minut, powtarzajac cykl co CYCLE_MINUTES. Dzieki temu
    // nawet jedno uruchomienie na godzine daje ciagly nadzor nad pozycjami.
    LOOP_MINUTES: envNum('LOOP_MINUTES', 0),
    CYCLE_MINUTES: envNum('CYCLE_MINUTES', 5),

    EMA_FAST: envNum('EMA_FAST', 21),
    EMA_SLOW: envNum('EMA_SLOW', 55),
    EMA_TREND: envNum('EMA_TREND', 200),
    RSI_LEN: envNum('RSI_LEN', 14),
    ATR_LEN: envNum('ATR_LEN', 14),

    // Filtry rezimu rynku (domyslnie wylaczone; przetestowane w backtest.mjs).
    // ER_MIN — minimalny wspolczynnik efektywnosci Kaufmana (0 = wylaczony):
    // ruch netto / suma ruchow swieca po swiecy w oknie ER_LEN. Niski ER to pila.
    // LEADER_FILTER — nie wchodz w nic, gdy SOL (lider rynku) nie ma trendu
    // wzrostowego; te aktywa i tak spadaja razem z SOL.
    ER_LEN: envNum('ER_LEN', 48),
    ER_MIN: envNum('ER_MIN', 0),
    LEADER_FILTER: envBool('LEADER_FILTER', false),

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
    MIN_TRADE_USD: envNum('MIN_TRADE_USD', 20),
    // Oplaty sieciowe sa stale w SOL — im mniejsza pozycja, tym wiekszy ich udzial.
    MAX_FIXED_COST_PCT: envNum('MAX_FIXED_COST_PCT', 0.015),
    FEE_RESERVE_SOL: envNum('FEE_RESERVE_SOL', 0.02),
    SLIPPAGE_BPS: envNum('SLIPPAGE_BPS', 50),
    PRIORITY_FEE_MAX_LAMPORTS: envNum('PRIORITY_FEE_MAX_LAMPORTS', 2_000_000),
    EST_COST_PCT: envNum('EST_COST_PCT', 0.004),
    MAX_PRICE_IMPACT: envNum('MAX_PRICE_IMPACT', 0.02),

    // Mnoznik filtra oplacalnosci: potencjalny ruch (TAKE_PROFIT_ATR w proc.)
    // musi byc co najmniej tyle razy wiekszy od szacowanego kosztu rundy.
    COST_EDGE_MULT: envNum('COST_EDGE_MULT', 2.5),

    MAX_TRADES_PER_DAY: envNum('MAX_TRADES_PER_DAY', 8),
    COOLDOWN_MIN: envNum('COOLDOWN_MIN', 45),
    DAILY_LOSS_LIMIT_PCT: envNum('DAILY_LOSS_LIMIT_PCT', 0.06),
    MAX_DRAWDOWN_PCT: envNum('MAX_DRAWDOWN_PCT', 0.25),
    MIN_SCORE: envNum('MIN_SCORE', 7),
  };
  return { ...cfg, ...overrides };
}

/** Konfiguracja domyslna (ze srodowiska) — uzywa jej bot produkcyjny. */
export const CFG = makeCFG();

// ─────────────────────────────────────────────────────────────────────────────
// Narzedzia formatowania (uzywane w komunikatach sygnalow)
// ─────────────────────────────────────────────────────────────────────────────

export const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
export const pct = (n) => `${(Number(n || 0) * 100).toFixed(2)}%`;

// ─────────────────────────────────────────────────────────────────────────────
// Wskazniki
// ─────────────────────────────────────────────────────────────────────────────

export function ema(values, len) {
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

export function rsi(closes, len) {
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

export function atr(candles, len) {
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

/**
 * Wspolczynnik efektywnosci Kaufmana w punkcie i: |ruch netto| / suma ruchow.
 * 1.0 = idealna linia prosta, ~0 = pila. Miara "czystosci" trendu.
 */
export function efficiencyRatio(closes, i, len) {
  if (i < len) return null;
  let sum = 0;
  for (let j = i - len + 1; j <= i; j++) sum += Math.abs(closes[j] - closes[j - 1]);
  return sum > 0 ? Math.abs(closes[i] - closes[i - len]) / sum : 0;
}

/** Metryki z ostatniej swiecy serii — dokladnie to, co widzi bot w cyklu. */
export function analyze(candles, cfg = CFG) {
  const closes = candles.map((c) => c.c);
  const eFast = ema(closes, cfg.EMA_FAST);
  const eSlow = ema(closes, cfg.EMA_SLOW);
  const eTrend = ema(closes, Math.min(cfg.EMA_TREND, Math.floor(closes.length * 0.8)));
  const r = rsi(closes, cfg.RSI_LEN);
  const a = atr(candles, cfg.ATR_LEN);
  const i = closes.length - 1;
  const trendNow = eTrend[i];
  const trendPrev = eTrend[i - 10] ?? eTrend[i];

  return {
    er: efficiencyRatio(closes, i, cfg.ER_LEN),
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

/**
 * Zdjecie warunkow rynku w chwili decyzji — LICZBY, nie zdanie po polsku.
 *
 * Zdanie "gotowy: trend, RSI 43.2, cofniecie do sredniej" mowi czlowiekowi, co bot
 * widzial. Ale za pol roku, przy kilkuset trejdach, nie da sie z takich zdan nic
 * policzyc. Z liczb da sie: mozna posortowac trejdy po RSI i sprawdzic, czy nizsze
 * RSI faktycznie dawalo lepszy wynik, czy tylko tak nam sie wydawalo.
 *
 * To jest roznica miedzy dziennikiem a danymi. Dziennik sie czyta, dane odpowiadaja
 * na pytania, ktorych nie zadalismy, gdy je zapisywalismy.
 *
 * Osiem liczb, okolo 120 bajtow na trejd. Zapisujemy je przy WEJSCIU i przenosimy
 * na wpis o ZAMKNIECIU — bo dopiero tam jest wynik, a warunek bez wyniku i wynik
 * bez warunku sa oba bezuzyteczne.
 */
export function warunki(m) {
  const z = (x, n) => (Number.isFinite(x) ? +x.toFixed(n) : null);
  return {
    rsi: z(m.rsi, 1),                                              // wykupienie / wyprzedanie
    rsiPrev: z(m.rsiPrev, 1),                                      // czy RSI rosl czy spadal
    ext: m.atr ? z((m.price - m.emaFast) / m.atr, 2) : null,       // ile ATR nad srednia szybka
    nadTrendem: m.emaTrend ? z(m.price / m.emaTrend - 1, 4) : null, // ile % nad srednia dluga
    fastNadSlow: m.emaSlow ? z(m.emaFast / m.emaSlow - 1, 4) : null, // uklad srednich
    volPct: z(m.volPct, 4),                                        // zmiennosc jako % ceny
    er: z(m.er, 3),                                                // ile ruchu bylo w jedna strone
    slope: z(m.trendSlope, 5),                                     // nachylenie trendu
  };
}

/**
 * Jak daleko cena zaszla W NASZA STRONE i PRZECIW nam, zanim pozycja sie zamknela.
 *
 * Bez tych dwoch liczb nie da sie odroznic zlego WEJSCIA od zlego WYJSCIA — a to
 * dwa zupelnie rozne bledy, wymagajace dwoch roznych poprawek:
 *
 *   duze mfe, strata  -> wejscie bylo dobre, wyszlismy za pozno albo za wczesnie
 *   male mfe, strata  -> wejscie bylo zle, cena nigdy nie poszla w nasza strone
 *   duze mae, zysk    -> mielismy racje, ale stop byl o wlos od wyrzucenia nas
 *
 * Mierzymy w ATR, zeby BONK i BTC dalo sie polozyc obok siebie na jednym wykresie.
 */
export function wychylenia(p, atr) {
  if (!atr || !p.entryPrice) return { mfe: null, mae: null };
  const long = p.side === 'LONG';
  const naj = p.bestPrice ?? p.entryPrice;
  const gorsza = p.worstPrice ?? p.entryPrice;
  const r2 = (x) => +x.toFixed(2);
  return {
    mfe: r2((long ? naj - p.entryPrice : p.entryPrice - naj) / atr),
    mae: r2((long ? p.entryPrice - gorsza : gorsza - p.entryPrice) / atr),
  };
}

/**
 * Ceny kilku duzych aktywow w chwili wejscia i wyjscia.
 *
 * Bez tego kazda strata wyglada jak blad naszego sygnalu. A jesli w tym czasie
 * spadlo WSZYSTKO, to nie byl blad sygnalu tylko ruch calego rynku — i poprawianie
 * sygnalu nic by nie dalo. Tego rozroznienia nie da sie zrobic pozniej, bo trzeba
 * znac ceny dokladnie z tych dwoch momentow.
 */
export function migawkaRynku(ceny = {}) {
  const z = (x) => (Number.isFinite(x) ? +x.toPrecision(8) : null);
  return { SOL: z(ceny.SOL), BTC: z(ceny.BTC), ETH: z(ceny.ETH) };
}

/** Ile procent zmienil sie rynek miedzy dwiema migawkami. */
export function zmianaRynku(wejscie, wyjscie) {
  if (!wejscie || !wyjscie) return null;
  const out = {};
  for (const k of Object.keys(wejscie)) {
    const a = wejscie[k], b = wyjscie[k];
    out[k] = Number.isFinite(a) && Number.isFinite(b) && a !== 0 ? +(b / a - 1).toFixed(5) : null;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sygnaly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ocena kandydata. Zwraca {score, enter, reason} — im wyzszy score, tym lepiej.
 * ctx.leader to metryki SOL (lidera rynku) — potrzebne tylko przy LEADER_FILTER.
 */
export function entrySignal(sym, m, cfg = CFG, ctx = {}) {
  // `?.` a nie `.` — laboratorium puszcza te funkcje na 127 monetach, a UNIVERSE
  // ma ich 39. Bez oslony leci TypeError i pada CALY przebieg, przez co KAT 3
  // (bias przetrwania) nigdy nie ruszyl dla rodziny Trendu — czyli takze dla
  // Smyczy, ktory wydaje prawdziwe pieniadze. 1.7 to nasz najwyzszy mnoznik
  // (PENGU), wiec dla monety spoza tabeli zakladamy najgorszy znany spread.
  const costPct = cfg.EST_COST_PCT * (UNIVERSE[sym]?.costMul ?? 1.7);
  const good = [];
  let score = 0;

  if (!(m.price > m.emaTrend && m.emaFast > m.emaSlow)) {
    return { score: 0, enter: false, reason: 'brak trendu wzrostowego' };
  }
  score += 3;
  good.push('trend');

  const L = ctx.leader;
  if (cfg.LEADER_FILTER && L && !(L.price > L.emaTrend && L.emaFast > L.emaSlow)) {
    return { score, enter: false, reason: 'rynek (SOL) bez trendu wzrostowego' };
  }
  if (cfg.ER_MIN > 0 && m.er != null && m.er < cfg.ER_MIN) {
    return { score, enter: false, reason: `rynek pilowaty (ER ${m.er.toFixed(2)} < ${cfg.ER_MIN})` };
  }

  if (m.trendSlope > 0.0005) {
    score += 1;
    good.push('trend rosnie');
  }

  if (m.volPct < cfg.MIN_VOL_PCT) {
    return { score, enter: false, reason: `zmiennosc ${pct(m.volPct)} za niska` };
  }
  if (m.volPct > cfg.MAX_VOL_PCT) {
    return { score, enter: false, reason: `zmiennosc ${pct(m.volPct)} za wysoka` };
  }
  score += 1;

  if (m.rsi < cfg.RSI_MIN) return { score, enter: false, reason: `RSI ${m.rsi.toFixed(1)} — spadajacy noz` };
  if (m.rsi > cfg.RSI_MAX) return { score, enter: false, reason: `RSI ${m.rsi.toFixed(1)} — przegrzane` };
  score += 1;
  good.push(`RSI ${m.rsi.toFixed(1)}`);

  const ext = (m.price - m.emaFast) / m.atr;
  if (ext > cfg.MAX_EXT_ATR) {
    return { score, enter: false, reason: `${ext.toFixed(2)} ATR nad srednia — za daleko` };
  }
  score += 2;
  good.push('cofniecie do sredniej');

  if (m.rsi > m.rsiPrev) {
    score += 1;
    good.push('RSI zawraca');
  }

  const expectedMove = (cfg.TAKE_PROFIT_ATR * m.atr) / m.price;
  if (expectedMove < costPct * cfg.COST_EDGE_MULT) {
    return { score, enter: false, reason: `potencjal ${pct(expectedMove)} maly wobec kosztow ${pct(costPct)}` };
  }
  score += 1;

  const enter = score >= cfg.MIN_SCORE;
  return {
    score,
    enter,
    // Przewidywanie bota w chwili decyzji: ile ruchu spodziewa sie zlapac i ile
    // ma kosztowac. Zapisujemy je, bo bez zapisanej PROGNOZY nie da sie pozniej
    // odroznic "zle ocenilismy" od "ocenilismy dobrze, wyszlo inaczej" — a po
    // fakcie zawsze wydaje sie, ze wiedzielismy.
    expectedMove,
    costPct,
    prog: cfg.MIN_SCORE,
    reason: enter ? `gotowy: ${good.join(', ')}` : `score ${score}/${cfg.MIN_SCORE}: ${good.join(', ')}`,
  };
}

/**
 * Sygnal na spadek — lustrzane odbicie sygnalu na wzrost.
 * Trend spadkowy, RSI w oknie (odbitym), odbicie w gore do sredniej zamiast
 * cofniecia w dol.
 *
 * ZNANA NIESPOJNOSC, celowo NIEZMIENIANA teraz:
 * ta sciezka dolicza do progu oplacalnosci oplate kontraktowa (OPEN_FEE * 2),
 * a sciezka LONG w strategy.mjs juz nie. Short ma wiec ciut wyzsza poprzeczke.
 * Zmierzone w bot/filtr.mjs: prog scina tylko 9% okazji, a sciete nie wypadaly
 * lepiej od przepuszczonych — wiec skutek jest zaden. Nie ruszamy tego, bo liga
 * chodzi na zywo i zmiana sygnalu rozjechalaby trejdy sprzed i po zmianie.
 * Do wyrownania przy najblizszym resecie ligi.
 */
export function shortSignal(sym, m, cfg = CFG, dodatkowyKoszt = 0) {
  // Jak wyzej: moneta spoza UNIVERSE dostaje najwyzszy znany mnoznik zamiast
  // wywalac proces. Zaniżenie kosztu byloby gorsze niz zawyzenie.
  const costPct = cfg.EST_COST_PCT * (UNIVERSE[sym]?.costMul ?? 1.7) + dodatkowyKoszt;
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
  if (m.volPct < cfg.MIN_VOL_PCT) return { score, enter: false, reason: `zmiennosc ${pct(m.volPct)} za niska` };
  if (m.volPct > cfg.MAX_VOL_PCT) return { score, enter: false, reason: `zmiennosc ${pct(m.volPct)} za wysoka` };
  score += 1;

  // Okno RSI odbite: to, co dla dlugiej pozycji bylo 38-68, tu jest 32-62.
  const lo = 100 - cfg.RSI_MAX;
  const hi = 100 - cfg.RSI_MIN;
  if (m.rsi > hi) return { score, enter: false, reason: `RSI ${m.rsi.toFixed(1)} — jeszcze nie spada` };
  if (m.rsi < lo) return { score, enter: false, reason: `RSI ${m.rsi.toFixed(1)} — wyprzedane, nie gonie dolu` };
  score += 1;
  good.push(`RSI ${m.rsi.toFixed(1)}`);

  // Odbicie w gore do sredniej — lustro "cofniecia" z sygnalu dlugiego.
  const ext = (m.emaFast - m.price) / m.atr;
  if (ext > cfg.MAX_EXT_ATR) {
    return { score, enter: false, reason: `${ext.toFixed(2)} ATR pod srednia — za nisko, czekam na odbicie` };
  }
  score += 2;
  good.push('odbicie do sredniej');

  if (m.rsi < m.rsiPrev) {
    score += 1;
    good.push('RSI zawraca w dol');
  }

  const expected = (cfg.TAKE_PROFIT_ATR * m.atr) / m.price;
  if (expected < costPct * cfg.COST_EDGE_MULT) {
    return { score, enter: false, reason: `potencjal ${pct(expected)} maly wobec kosztow ${pct(costPct)}` };
  }
  score += 1;

  const enter = score >= cfg.MIN_SCORE;
  return {
    score,
    enter,
    // Te dwa pola musza tu byc, bo skaner bierze najlepszy z sygnalow LONG i SHORT
    // i z niego zapisuje prognoze. Bez nich kazdy short trafialby do pliku bez
    // prognozy — czyli dokladnie polowa trejdow bylaby nierozliczalna.
    expectedMove: expected,
    costPct,
    reason: enter ? `SHORT: ${good.join(', ')}` : `score ${score}/${cfg.MIN_SCORE}`,
  };
}

export function exitSignal(pos, m, price, cfg = CFG, nowMs = Date.now()) {
  const a = pos.atrAtEntry || m.atr;
  const gainAtr = (price - pos.entryPrice) / a;
  const heldH = (nowMs - new Date(pos.entryTs).getTime()) / 3600000;

  if (price <= pos.stopPrice) return { exit: true, reason: `STOP LOSS przy ${usd(price)}` };
  if (price >= pos.takeProfit) return { exit: true, reason: `TAKE PROFIT (+${gainAtr.toFixed(2)} ATR)` };
  if (pos.trailArmed && price <= pos.maxPrice - cfg.TRAIL_ATR * a) {
    return { exit: true, reason: `TRAILING STOP — szczyt ${usd(pos.maxPrice)}` };
  }
  if (m.emaFast < m.emaSlow && price < m.emaTrend) {
    return { exit: true, reason: 'trend sie odwrocil' };
  }
  if (heldH > cfg.MAX_HOLD_HOURS && price < pos.entryPrice) {
    return { exit: true, reason: `stop czasowy — ${heldH.toFixed(1)}h pod woda` };
  }
  return { exit: false, reason: `${gainAtr >= 0 ? '+' : ''}${gainAtr.toFixed(2)} ATR, ${heldH.toFixed(1)}h` };
}
