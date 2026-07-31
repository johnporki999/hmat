/**
 * HAJSOMAT — bot na PRAWDZIWYCH pieniadzach (Hyperliquid). Etap 1: tryb suchy.
 *
 * PO CO ISTNIEJE — i to jest wazniejsze niz sam bot:
 *
 * Cala nasza liga stoi na zalozeniu, ze runda kosztuje 0,12% wartosci pozycji.
 * Tego zalozenia nigdy nie sprawdzilismy na prawdziwym rynku. Proba odzyskania
 * kosztu z zywych trejdow ligi dala stala 0,061% — czyli nasza wlasna liczbe.
 * Sonda na wycenach Jupitera (bot/sonda-kosztow.mjs) pokazala, ze na spocie
 * bywa od 0,00% (SOL) do 0,55% (JTO), czyli rozrzut stukrotny.
 *
 * Ten bot nie ma zarobic. Ma ZMIERZYC, ile naprawde kosztuje wejscie i wyjscie:
 * przy kazdym trejdzie zapisuje cene, ktora ZOBACZYL, obok ceny, ktora
 * FAKTYCZNIE dostal. Dwadziescia trejdow wystarczy na ten pomiar w zupelnosci,
 * a nie wystarczy na nic wiecej — do werdyktu o zyskownosci trzeba 714.
 *
 * DLACZEGO HYPERLIQUID: 11 z 15 aktywow ligi (80% trejdow), wlasny klucz
 * zamiast konta u posrednika, bez weryfikacji tozsamosci. Kraken Futures ma
 * lepsze pokrycie (91%), ale wymaga oddania dowodu i trzyma pieniadze u siebie.
 * Przy eksperymencie za 100 zl to zla wymiana.
 *
 * DLACZEGO 2 MIEJSCA PO 40%, A NIE 4 PO 20% JAK W LIDZE:
 * Hyperliquid odrzuca zlecenia ponizej 10 dolarow wartosci. Przy 25 dolarach
 * kapitalu i czterech miejscach pozycja ma 15 dolarow — ale gdy bot straci
 * jedna trzecia, zejdzie ponizej minimum i po prostu przestanie handlowac,
 * zostawiajac nam niepelny pomiar. Dwa miejsca po 40% daja 30 dolarow na
 * pozycje, czyli trzykrotny zapas. Laczne zaangazowanie zostaje 80%, tak jak
 * w lidze. Dla pomiaru KOSZTU liczba miejsc nie ma znaczenia.
 *
 * BEZPIECZNIKI (bot wydaje prawdziwe pieniadze, wiec kazdy jest tu celowo):
 *   - SUCHY=1 domyslnie — bez jawnego wylaczenia nie zlozy zadnego zlecenia
 *   - twardy limit MAX_TREJDOW, po nim zamyka co ma i nie otwiera nic wiecej
 *   - limit straty: ponizej STOP_KAPITAL bot konczy eksperyment
 *   - klucz czytany wylacznie ze zmiennej srodowiskowej, nigdy z pliku w repo
 *
 * URUCHOMIENIE (tryb suchy, nic nie kosztuje, nie potrzebuje klucza):
 *   node bot/realny.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CFG, ema, rsi, atr, efficiencyRatio } from './strategy.mjs';
import { stworzGraczy, czyWyjsc } from './gracze.mjs';

/**
 * Przygotowanie wskaznikow — ta sama procedura co w bot/cache/silnik.mjs,
 * ale przepisana tutaj CELOWO: bot/cache/ jest poza gitem, wiec na serwerze
 * tamtego pliku nie ma. Bot handlujacy prawdziwymi pieniedzmi nie moze zalezec
 * od czegos, czego nie ma we wdrozeniu.
 */
function przygotujAktywo(candles) {
  const closes = candles.map((x) => x.c);
  const highs = candles.map((x) => x.h);
  const lows = candles.map((x) => x.l);
  const e21 = ema(closes, CFG.EMA_FAST), e55 = ema(closes, CFG.EMA_SLOW), e200 = ema(closes, CFG.EMA_TREND);
  const r = rsi(closes, CFG.RSI_LEN);
  const a = atr(candles, CFG.ATR_LEN);
  return {
    c: candles, n: candles.length, closes, highs, lows, atr: a,
    metryka(i) {
      if (i < 210 || e200[i] == null || a[i] == null || r[i] == null) return null;
      const tp = e200[i - 10] ?? e200[i];
      return {
        er: efficiencyRatio(closes, i, CFG.ER_LEN), price: closes[i],
        emaFast: e21[i], emaSlow: e55[i], emaTrend: e200[i],
        rsi: r[i], rsiPrev: r[i - 1], atr: a[i],
        trendSlope: tp ? (e200[i] - tp) / tp : 0, volPct: a[i] / closes[i],
      };
    },
    kawalek(i) { return candles.slice(Math.max(0, i - 25), i + 1); },
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KAT = path.join(__dirname, '..', 'state');
const API = 'https://api.hyperliquid.xyz/info';

const env = (k, d) => process.env[k] ?? d;
const num = (k, d) => Number(env(k, d));

const P = {
  SUCHY: env('REALNY_SUCHY', '1') !== '0',
  GRACZ: env('REALNY_GRACZ', 'smycz'),
  START: num('REALNY_START_USD', 25),
  LEWAR: num('REALNY_LEWAR', 3),
  MIEJSC: num('REALNY_MIEJSC', 2),
  ALLOC: num('REALNY_ALLOC', 0.40),
  MAX_TREJDOW: num('REALNY_MAX_TREJDOW', 20),
  MIN_ZLECENIE: num('REALNY_MIN_ZLECENIE', 10),   // Hyperliquid odrzuca ponizej 10 USD
  STOP_KAPITAL: num('REALNY_STOP_KAPITAL', 0.35), // ponizej 35% startu koniec eksperymentu
  TAKER: num('REALNY_TAKER', 0.00045),
  // Adres konta glownego (jawny) i klucz agenta (tajny). Agent tylko PODPISUJE
  // zlecenia; zapytania o stan konta ida na adres glowny — tak dziala API
  // Hyperliquid. Agent z zalozenia nie moze niczego wyplacic, wiec jego wyciek
  // oznacza zle trejdy, a nie utrate srodkow.
  KONTO: env('REALNY_KONTO', ''),
  AGENT_KEY: env('REALNY_AGENT_KEY', ''),
};

// Zawor bezpieczenstwa: bez kompletu danych nie ma mowy o trybie zywym, nawet
// gdyby ktos przestawil sama flage. Lepiej wrocic do trybu suchego z glosnym
// ostrzezeniem niz probowac handlowac polowa konfiguracji.
if (!P.SUCHY && (!P.KONTO || !P.AGENT_KEY)) {
  console.error('! REALNY_SUCHY=0, ale brakuje REALNY_KONTO albo REALNY_AGENT_KEY — wracam do trybu suchego.');
  P.SUCHY = true;
}

// Aktywa ligi, ktore Hyperliquid ma. BONK figuruje tam jako kBONK (w tysiacach
// sztuk) — cena jest 1000x wyzsza, ale procentowe ruchy identyczne, wiec dla
// naszej strategii to ten sam rynek.
const AKTYWA = {
  SOL: 'SOL', JUP: 'JUP', JTO: 'JTO', PYTH: 'PYTH', RENDER: 'RENDER',
  BONK: 'kBONK', BTC: 'BTC', ETH: 'ETH', W: 'W', TNSR: 'TNSR', PENGU: 'PENGU',
};

const F_STAN = path.join(KAT, 'realny-state.json');
const F_TREJDY = path.join(KAT, 'realny-trades.json');
const nowISO = () => new Date().toISOString();
const usd = (x) => `$${Number(x).toFixed(2)}`;
const log = (...a) => console.log(...a);

async function poi(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
  return r.json();
}

/** Swiece 15-minutowe prosto z Hyperliquid — te same ceny, po ktorych handlujemy. */
async function swiece(nazwa, ile = 400) {
  const koniec = Date.now();
  const start = koniec - ile * 15 * 60000;
  const j = await poi({ type: 'candleSnapshot', req: { coin: nazwa, interval: '15m', startTime: start, endTime: koniec } });
  return (j || []).map((k) => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c })).sort((a, b) => a.t - b.t);
}

const czytaj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const pisz = (f, x) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(x, null, 2)); };

// ── stan ────────────────────────────────────────────────────────────────────
let stan = czytaj(F_STAN, null);
if (!stan) {
  stan = {
    wersja: 1, utworzony: nowISO(), gracz: P.GRACZ, suchy: P.SUCHY,
    cash: P.START, pozycje: {}, zamkniete: 0, koniec: null,
    ustawienia: { lewar: P.LEWAR, miejsc: P.MIEJSC, alloc: P.ALLOC, maxTrejdow: P.MAX_TREJDOW },
  };
}
let trejdy = czytaj(F_TREJDY, []);

const gracze = stworzGraczy();
const def = gracze[P.GRACZ];
if (!def) { console.error(`Nie znam gracza "${P.GRACZ}". Dostepni: ${Object.keys(gracze).join(', ')}`); process.exit(1); }

log(`=== HAJSOMAT REALNY ${nowISO()} | ${P.SUCHY ? 'SUCHY (nic nie kosztuje)' : '*** ZA PRAWDZIWE PIENIADZE ***'} ===`);
log(`> gracz ${def.nazwa}, dzwignia ${P.LEWAR}x, ${P.MIEJSC} miejsca po ${(P.ALLOC * 100).toFixed(0)}%, limit ${P.MAX_TREJDOW} trejdow`);

if (stan.koniec) { log(`> eksperyment ZAKONCZONY (${stan.koniec}) — nic nie robie`); process.exit(0); }

// ── ceny i metryki ──────────────────────────────────────────────────────────
const rynki = {};
for (const [sym, nazwa] of Object.entries(AKTYWA)) {
  try {
    const c = await swiece(nazwa);
    if (c.length < 230) { log(`  ${sym}: tylko ${c.length} swiec, pomijam`); continue; }
    const D = przygotujAktywo(c);
    const i = D.n - 1;
    const m = D.metryka(i);
    if (m) rynki[sym] = { D, i, m, nazwa, cena: D.closes[i] };
  } catch (e) { log(`  ${sym}: ${e.message}`); }
}
log(`> rynkow gotowych: ${Object.keys(rynki).length} z ${Object.keys(AKTYWA).length}`);

const kapital = () => stan.cash + Object.values(stan.pozycje).reduce((s, p) => s + p.margin, 0);

// ── wyjscia ─────────────────────────────────────────────────────────────────
for (const [sym, p] of Object.entries(stan.pozycje)) {
  const r = rynki[sym];
  if (!r) continue;
  const px = r.cena;
  p.bestPrice = p.side === 'LONG' ? Math.max(p.bestPrice, px) : Math.min(p.bestPrice, px);
  if (!p.trailArmed && (p.side === 'LONG' ? px - p.entryPrice : p.entryPrice - px) >= CFG.TRAIL_ARM_ATR * p.atrAtEntry) p.trailArmed = true;

  const powod = czyWyjsc(p, r.m.atr, px, Date.now());
  if (!powod) continue;

  // W trybie suchym udajemy wypelnienie po cenie widzianej. Na zywo tutaj
  // pojdzie prawdziwe zlecenie, a `fill` bedzie cena, ktora naprawde dostaniemy —
  // i roznica miedzy `widziana` a `fill` jest calym sensem tego eksperymentu.
  const widziana = px;
  const fill = P.SUCHY ? px : null;   // TODO etap 2: zlecenie rynkowe, odczyt wypelnienia
  if (fill == null) { log(`  ${sym}: tryb zywy niezaimplementowany — pomijam wyjscie`); continue; }

  const brutto = (p.side === 'LONG' ? fill / p.entryPrice - 1 : 1 - fill / p.entryPrice) * p.notional;
  const oplata = p.notional * P.TAKER;
  const netto = brutto - oplata;
  stan.cash += p.margin + netto;
  stan.zamkniete += 1;

  trejdy.push({
    ts: nowISO(), sym, side: p.side, typ: 'CLOSE', powod,
    entryPrice: p.entryPrice, cenaWidziana: widziana, cenaWypelnienia: fill,
    poslizg: (fill - widziana) / widziana,
    margin: p.margin, notional: p.notional, oplata,
    pnlUsd: netto, R: netto / p.margin,
    trzymane_h: (Date.now() - Date.parse(p.entryTs)) / 3600000,
  });
  log(`  ZAMYKAM ${sym} ${p.side} @ ${fill} — ${powod}, wynik ${usd(netto)} (${(netto / p.margin * 100).toFixed(2)}%)`);
  delete stan.pozycje[sym];
}

// ── koniec eksperymentu? ────────────────────────────────────────────────────
if (stan.zamkniete >= P.MAX_TREJDOW) {
  stan.koniec = nowISO();
  log(`> OSIAGNIETO LIMIT ${P.MAX_TREJDOW} TREJDOW — koniec eksperymentu, nie otwieram nic wiecej`);
} else if (kapital() < P.START * P.STOP_KAPITAL) {
  stan.koniec = nowISO();
  log(`> kapital spadl ponizej ${(P.STOP_KAPITAL * 100).toFixed(0)}% startu — koniec eksperymentu`);
}

// ── wejscia ─────────────────────────────────────────────────────────────────
if (!stan.koniec) {
  const wolne = P.MIEJSC - Object.keys(stan.pozycje).length;
  let otwarte = 0;
  for (const [sym, r] of Object.entries(rynki)) {
    if (otwarte >= wolne) break;
    if (stan.pozycje[sym]) continue;
    if (stan.zamkniete + Object.keys(stan.pozycje).length >= P.MAX_TREJDOW) break;

    const syg = def.wejscie(sym, r.m, r.D.kawalek(r.i));
    if (!syg) continue;

    const kap = kapital();
    const margin = Math.min(stan.cash, kap * P.ALLOC);
    const notional = margin * P.LEWAR;
    if (notional < P.MIN_ZLECENIE) { log(`  ${sym}: pozycja ${usd(notional)} ponizej minimum ${usd(P.MIN_ZLECENIE)} — pomijam`); continue; }

    const widziana = r.cena;
    const fill = P.SUCHY ? widziana : null;
    if (fill == null) { log(`  ${sym}: tryb zywy niezaimplementowany — pomijam wejscie`); continue; }

    const long = syg.kier === 'LONG';
    const stopA = def.stopAtr ?? CFG.STOP_ATR;
    stan.cash -= margin + notional * P.TAKER;
    stan.pozycje[sym] = {
      sym, side: syg.kier, entryPrice: fill, entryTs: nowISO(),
      margin, notional, leverage: P.LEWAR,
      stopPrice: long ? fill - stopA * r.m.atr : fill + stopA * r.m.atr,
      takeProfit: long ? fill + CFG.TAKE_PROFIT_ATR * r.m.atr : fill - CFG.TAKE_PROFIT_ATR * r.m.atr,
      atrAtEntry: r.m.atr, bestPrice: fill, trailArmed: false,
      trailAtr: def.trailAtr ?? CFG.TRAIL_ATR, bezSmyczy: !!def.bezSmyczy,
      minGodzin: def.minGodzin ?? 0, stopZawsze: !!def.stopZawsze,
    };
    trejdy.push({
      ts: nowISO(), sym, side: syg.kier, typ: 'OPEN', powod: syg.powod,
      cenaWidziana: widziana, cenaWypelnienia: fill, poslizg: (fill - widziana) / widziana,
      margin, notional, oplata: notional * P.TAKER, warunki: { rsi: r.m.rsi, volPct: r.m.volPct, er: r.m.er },
    });
    log(`  OTWIERAM ${sym} ${syg.kier} @ ${fill} — ${syg.powod}`);
    otwarte++;
  }
}

// ── zapis ───────────────────────────────────────────────────────────────────
stan.lastRun = nowISO();
stan.kapital = kapital();
stan.suchy = P.SUCHY;
pisz(F_STAN, stan);
pisz(F_TREJDY, trejdy.slice(-500));

log(`> kapital ${usd(stan.kapital)} (start ${usd(P.START)}), pozycji ${Object.keys(stan.pozycje).length}, trejdow ${stan.zamkniete}/${P.MAX_TREJDOW}`);

// ── podsumowanie poslizgu — to, po co ten bot istnieje ──────────────────────
const zPoslizgiem = trejdy.filter((t) => t.poslizg != null && t.cenaWypelnienia != null);
if (zPoslizgiem.length >= 3 && !P.SUCHY) {
  const p = zPoslizgiem.map((t) => Math.abs(t.poslizg)).sort((a, b) => a - b);
  const med = p[p.length >> 1];
  log(`> POSLIZG: mediana ${(med * 100).toFixed(3)}% na strone, czyli ${(med * 2 * 100).toFixed(3)}% na runde`);
  log(`  Z oplatami: ${((med * 2 + P.TAKER * 2) * 100).toFixed(3)}% — a liga zaklada 0,120%.`);
} else if (P.SUCHY) {
  log('> tryb suchy: poslizg zawsze zerowy, bo udajemy wypelnienie po cenie widzianej.');
  log('  Prawdziwy pomiar zacznie sie dopiero po REALNY_SUCHY=0 i podlaczeniu klucza.');
}
