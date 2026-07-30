/**
 * HAJSOMAT — liga botów.
 *
 * Sześciu graczy handluje równolegle na osobnych wirtualnych portfelach.
 * Każdy ma inny pomysł na WEJŚCIE, ale wszyscy mają identyczne zasady WYJŚCIA,
 * tę samą dźwignię i te same koszty — żeby porównanie mierzyło pomysł, a nie
 * przypadkowe różnice w mechanice.
 *
 * W stawce są trzej zawodnicy, którzy nie próbują być mądrzy:
 *
 *   MAŁPA        wchodzi w losowych momentach, w losowym kierunku.
 *                Jeśli którykolwiek "mądry" bot jej nie bije, to znaczy,
 *                że jego pomysł nie wnosi nic ponad rzut monetą.
 *
 *   BYK          kupuje SOL na starcie i nigdy nie sprzedaje.
 *                Punkt odniesienia: czy handlowanie w ogóle bije siedzenie.
 *
 *   ANTYTREND    te same sygnały co Trend, tylko odwrócone.
 *                Jeśli WYGRYWA, to nie jest zła wiadomość, tylko odkrycie:
 *                sygnał niesie informację, a my czytamy ją do góry nogami.
 *                Jeśli obaj kręcą się wokół zera, sygnał jest po prostu pusty.
 *
 * To nie jest ozdoba. Większość ludzi budujących boty nie ma jak zauważyć,
 * że ich strategia jest przypadkiem — bo nie ma z czym porównać.
 *
 * Do tego liczymy, ILE TREJDÓW jeszcze trzeba, żeby różnica w tabeli przestała
 * być przypadkiem. Bez tej liczby tabela kusi, żeby uwierzyć w lidera po dziesięciu
 * trejdach — a po dziesięciu trejdach prowadzi zwykle ten, kto miał szczęście.
 *
 * SYMULACJA. Nie wysyła transakcji nigdzie.
 * Stan: state/liga-*.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNIVERSE, CFG, envNum, envBool, usd, pct, analyze, entrySignal,
  warunki, wychylenia, migawkaRynku, zmianaRynku,
} from './strategy.mjs';
import { istotnosc, ALFA, MOC, D_MIN, SLOWA } from './istotnosc.mjs';
// Gracze i mechanika wyjsc siedza w osobnym pliku, bo korzysta z nich takze
// ligahist.mjs — test tych samych graczy na pieciu latach swiec.
import { stworzGraczy, liqPrice, pnlAt, czyWyjsc, prognozaWejscia } from './gracze.mjs';

const P = {
  START: envNum('LIGA_START_USD', 500),
  LEVERAGE: envNum('LIGA_LEVERAGE', 3),
  // Liga nigdy nie miala limitu dobowego ani pauzy po stracie — jedynym hamulcem
  // bylo to, ze gracz mogl trzymac tylko dwie pozycje naraz. Przy osmiu aktywach
  // znaczylo to, ze widzial okazje i musial ja odpuscic.
  //
  // Cztery miejsca zamiast dwoch, ale depozyt na kazde o polowe mniejszy — laczne
  // zaangazowanie kapitalu zostaje takie samo (4 x 0,2 = 2 x 0,4 = 80%), wiec
  // porownanie graczy dalej mierzy pomysl na wejscie, a nie odwage w stawianiu.
  // Wynik liczymy jako zwrot z wlozonego depozytu, wiec zmiana wielkosci pozycji
  // nie psuje statystyki — a dwa razy wiecej trejdow to dwa razy szybsza odpowiedz.
  MAX_POZ: envNum('LIGA_MAX_POZYCJI', 4),
  ALLOC: envNum('LIGA_ALLOC_PCT', 0.2),
  OPEN_FEE: envNum('PERP_OPEN_FEE', 0.0006),
  BORROW_L: envNum('PERP_BORROW_LONG_H', 0.000014),
  BORROW_S: envNum('PERP_BORROW_SHORT_H', 0.000006),
  LIQ_AT: envNum('PERP_LIQ_AT', 0.9),
  MIN_MARGIN: envNum('LIGA_MIN_MARGIN_USD', 20),
  RESET: envBool('LIGA_RESET', false),
  MALPA_SZANSA: envNum('LIGA_MALPA_SZANSA', 0.06), // na aktywo na przebieg
};

const GRACZE = stworzGraczy({ malpaSzansa: P.MALPA_SZANSA });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'state');
const F_STAN = path.join(DIR, 'liga-state.json');
const F_TREJDY = path.join(DIR, 'liga-trades.json');
const F_EQUITY = path.join(DIR, 'liga-equity.json');

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

const readJSON = (f, d) => {
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d;
  } catch {
    return d;
  }
};
const writeJSON = (f, x) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(x, null, 2) + '\n', 'utf8');
};

// ─────────────────────────────────────────────────────────────────────────────
// Świece
// ─────────────────────────────────────────────────────────────────────────────

async function pobierz(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'hajsomat-liga/1.0' } });
      clearTimeout(t);
      if (r.ok) return await r.json();
    } catch {
      /* nastepna proba */
    }
    await sleep(800);
  }
  return null;
}

async function swiece(sym, minut) {
  const j = await pobierz(`https://api.kraken.com/0/public/OHLC?pair=${UNIVERSE[sym].kraken}&interval=${minut}`);
  if (j && !j.error?.length) {
    const k = Object.keys(j.result).find((x) => x !== 'last');
    const c = j.result[k].map((x) => ({ t: x[0] * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6] }));
    if (c.length >= 60) return c;
  }
  const a = await pobierz(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${minut}m&limit=500`);
  return a ? a.map((x) => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gracze — różnią się WYŁĄCZNIE pomysłem na wejście
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// Mechanika — identyczna dla wszystkich
// ─────────────────────────────────────────────────────────────────────────────


// sumaR i sumaR2 to sumy zwrotow i ich kwadratow. Trzymamy je tutaj, a nie liczymy
// z pliku trejdow, bo plik trejdow ma limit dlugosci i po kilku miesiacach najstarsze
// wpisy z niego wypadna. Statystyka musi widziec KAZDY trejd od poczatku ligi.
const swiezyGracz = () => ({
  cash: P.START,
  positions: {},
  stats: { trejdy: 0, wygrane: 0, przegrane: 0, likwidacje: 0, pnl: 0, oplaty: 0, sumaR: 0, sumaR2: 0 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

log(`=== LIGA BOTÓW ${nowISO()} ===`);
log(`> dźwignia ${P.LEVERAGE}x, max ${P.MAX_POZ} pozycji, start ${usd(P.START)}`);

const bazowy = { version: 1, createdAt: nowISO(), gracze: {}, lastRun: null };
const zapisany = P.RESET ? {} : readJSON(F_STAN, {});
const stan = { ...bazowy, ...zapisany, gracze: zapisany.gracze || {} };
for (const k of Object.keys(GRACZE)) if (!stan.gracze[k]) stan.gracze[k] = swiezyGracz();
let trejdy = P.RESET ? [] : readJSON(F_TREJDY, []);
let equity = P.RESET ? [] : readJSON(F_EQUITY, []);
if (P.RESET) log('> reset ligi');

// dane rynkowe raz dla wszystkich graczy
const aktywa = CFG.ASSETS.filter((s) => UNIVERSE[s]);
const rynek = {};
for (const sym of aktywa) {
  const c = await swiece(sym, CFG.CANDLE_MINUTES);
  if (!c) continue;
  const m = analyze(c, CFG);
  if (m.emaTrend && m.atr && m.rsi != null) rynek[sym] = { m, c };
  await sleep(300);
}
if (!Object.keys(rynek).length) {
  log('!! brak danych rynkowych');
  process.exit(1);
}
log(`> zeskanowano ${Object.keys(rynek).length} aktywów`);

// ── sejsmograf: czy w ostatniej dobie rynkiem tąpnęło ────────────────────────
//
// BTC sluzy tu WYLACZNIE jako czujnik i NIE wchodzi do uniwersum ligi — dodanie
// go jako aktywa do handlu zmieniloby boisko wszystkim graczom w polowie
// eksperymentu i uniewaznilo porownania, ktore zbieramy od lipca.
//
// Regula (bot/cache/MOTANIE-WNIOSKI.md): jesli w ciagu ostatnich 24h byla
// chwila, w ktorej dobowy ruch BTC przekroczyl prog, gracz-sejsmograf nie
// otwiera niczego. Wyjscia dzialaja normalnie — cisza dotyczy tylko wejsc.
const SEJSMO_PROG = envNum('SEJSMO_PROG', 0.05);
let rynekTrzasl = false;
let odczytSejsmo = null;
{
  const c = await swiece('BTC', CFG.CANDLE_MINUTES);
  if (c && c.length > 192) {
    for (let i = c.length - 96; i < c.length; i++) {
      if (Math.abs(c[i].c / c[i - 96].c - 1) > SEJSMO_PROG) { rynekTrzasl = true; break; }
    }
    const doba = Math.abs(c[c.length - 1].c / c[c.length - 97].c - 1);
    odczytSejsmo = { ts: nowISO(), doba: +doba.toFixed(5), cisza: rynekTrzasl, prog: SEJSMO_PROG };
    log(`> sejsmograf: BTC ${(doba * 100).toFixed(2)}% w dobę — ${rynekTrzasl ? 'CISZA (tąpnęło w ostatniej dobie)' : 'spokój'}`);
  } else {
    // Brak odczytu = brak podstaw do ciszy. Lepiej, zeby Sejsmograf zagral
    // jak Cierpliwy, niz zeby awaria pobierania udawala trzesienie ziemi.
    //
    // Odczyt ladujemy w stanie (a nie tylko w logu), bo raz juz nas kosztowala
    // awaria widoczna WYLACZNIE w logach: Binance oddawal 451 przez dwa dni,
    // a my mielismy zera i zadnego alarmu. bot/zdrowie.mjs to sprawdza.
    odczytSejsmo = { ts: nowISO(), doba: null, cisza: false, prog: SEJSMO_PROG, blad: 'brak świec BTC' };
    log('> sejsmograf: brak świec BTC — traktuję jako spokój');
  }
}
stan.sejsmo = odczytSejsmo;

const teraz = Date.now();
const nowe = [];
// Ceny wszystkich aktywow w tej chwili — ta sama migawka dla kazdego gracza,
// zeby ich trejdy dalo sie potem porownywac z tym samym tlem rynkowym.
const cenyTeraz = Object.fromEntries(Object.entries(rynek).map(([s, r]) => [s, r.m.price]));
const migawka = migawkaRynku(cenyTeraz);

for (const [id, def] of Object.entries(GRACZE)) {
  const g = stan.gracze[id];

  // ── wyjścia i likwidacje ──
  for (const sym of Object.keys(g.positions)) {
    const r = rynek[sym];
    if (!r) continue;
    const p = g.positions[sym];
    const px = r.m.price;

    const godz = Math.max(0, (teraz - Date.parse(p.lastAccrual || p.entryTs)) / 3600000);
    p.borrowPaid = (p.borrowPaid || 0) + p.notional * (p.side === 'LONG' ? P.BORROW_L : P.BORROW_S) * godz;
    p.lastAccrual = nowISO();
    p.bestPrice = p.side === 'LONG' ? Math.max(p.bestPrice ?? p.entryPrice, px) : Math.min(p.bestPrice ?? p.entryPrice, px);
    p.worstPrice = p.side === 'LONG' ? Math.min(p.worstPrice ?? p.entryPrice, px) : Math.max(p.worstPrice ?? p.entryPrice, px);
    if (!p.trailArmed && (p.side === 'LONG' ? px - p.entryPrice : p.entryPrice - px) >= CFG.TRAIL_ARM_ATR * (p.atrAtEntry || r.m.atr)) {
      p.trailArmed = true;
    }

    const zlikwidowany = p.side === 'LONG' ? px <= p.liqPrice : px >= p.liqPrice;
    const powod = zlikwidowany ? 'LIKWIDACJA' : def.nigdyNieZamykaj ? null : czyWyjsc(p, r.m.atr, px, teraz);
    if (!powod) continue;

    const brutto = zlikwidowany ? -p.margin : pnlAt(p, px);
    const oplata = zlikwidowany ? 0 : p.notional * P.OPEN_FEE;
    const netto = brutto - oplata - p.borrowPaid;
    g.cash += zlikwidowany ? 0 : p.margin + netto;
    g.stats.oplaty += oplata;
    g.stats.trejdy += 1;
    g.stats.pnl += zlikwidowany ? -p.margin : netto;
    if (zlikwidowany) g.stats.likwidacje += 1;
    if (!zlikwidowany && netto >= 0) g.stats.wygrane += 1;
    else g.stats.przegrane += 1;

    // Sjesta: zapamietujemy czas wygranej na aktywie — jej regula blokuje wejscia
    // na tym aktywie przez pauzaPoWygranejH godzin (sprawdzane przy wejsciach nizej).
    if (def.pauzaPoWygranejH && !zlikwidowany && netto > 0) {
      (g.ostatniaWygrana = g.ostatniaWygrana || {})[sym] = teraz;
    }

    // Zwrot z wlozonego depozytu. Wszyscy gracze wkladaja ten sam procent kapitalu,
    // wiec te liczby sa porownywalne miedzy graczami niezaleznie od tego, ile ktory ma.
    const R = p.margin ? (zlikwidowany ? -1 : netto / p.margin) : 0;
    g.stats.sumaR = (g.stats.sumaR || 0) + R;
    g.stats.sumaR2 = (g.stats.sumaR2 || 0) + R * R;

    nowe.push({
      id: `${teraz}-${id}-${sym}`,
      ts: nowISO(),
      gracz: id,
      sym,
      side: p.side,
      type: 'CLOSE',
      price: px,
      entryPrice: p.entryPrice,
      margin: p.margin,
      notional: p.notional,
      leverage: p.leverage,
      pnlUsd: zlikwidowany ? -p.margin : netto,
      pnlPct: p.margin ? (zlikwidowany ? -1 : netto / p.margin) : 0,
      holdMs: teraz - Date.parse(p.entryTs),
      liquidated: zlikwidowany,
      reason: powod,
      // dlaczego weszlismy + jakie byly wtedy liczby, obok wyniku tego wejscia
      powodWejscia: p.powodWejscia || null,
      warunki: p.warunkiWejscia || null,
      prognoza: p.prognoza || null,
      // jak daleko cena zaszla w obie strony i co robil w tym czasie caly rynek
      ...wychylenia(p, p.atrAtEntry || r.m.atr),
      rynek: zmianaRynku(p.rynekWejscie, migawka),
    });
    delete g.positions[sym];
  }

  // ── wejścia ──
  const otwarte = Object.keys(g.positions).length;
  const kapital = g.cash + Object.entries(g.positions).reduce(
    (a, [s, p]) => a + p.margin + (rynek[s] ? pnlAt(p, rynek[s].m.price) - (p.borrowPaid || 0) : 0), 0
  );
  let sloty = P.MAX_POZ - otwarte;

  for (const sym of aktywa) {
    if (sloty <= 0) break;
    const r = rynek[sym];
    if (!r || g.positions[sym]) continue;
    // Sjesta: po wygranym trejdzie doba wolnego NA TYM AKTYWIE — dokladnie tak
    // byla testowana (kazde aktywo symulowane osobno), wiec tak tez gra na zywo.
    if (def.pauzaPoWygranejH && g.ostatniaWygrana?.[sym]
      && teraz - g.ostatniaWygrana[sym] < def.pauzaPoWygranejH * 3600000) continue;
    // Sejsmograf: cisza po trzesieniu calego rynku (czujnik liczony wyzej).
    if (def.sejsmograf && rynekTrzasl) continue;
    const sygnal = def.wejscie(sym, r.m, r.c);
    if (!sygnal) continue;
    const { kier, powod } = sygnal;

    // Krawiec szyje depozyt na miare ryzyka: tak, zeby uderzenie w stop zabralo
    // zawsze ryzykoPct kapitalu, niezaleznie od tego, jak dzikie jest aktywo.
    // Gorny limit ten sam co u wszystkich (ALLOC), zeby spokojny rynek nie
    // rozdmuchal pozycji w nieskonczonosc.
    let margin = Math.min(g.cash, kapital * P.ALLOC);
    if (def.ryzykoPct && r.m.volPct > 0) {
      const stopA = def.stopAtr ?? CFG.STOP_ATR;
      const naMiare = (kapital * def.ryzykoPct) / (P.LEVERAGE * stopA * r.m.volPct);
      margin = Math.min(g.cash, kapital * P.ALLOC, naMiare);
    }
    if (margin < P.MIN_MARGIN) break;
    const px = r.m.price;
    const notional = margin * P.LEVERAGE;
    const oplata = notional * P.OPEN_FEE;
    const long = kier === 'LONG';

    // Gracz "rowny" bierze DOKLADNIE te same sygnaly, ale odpuszcza te, ktore
    // dolozylyby mu ekspozycji w strone, w ktora juz stoi.
    //
    // Po co: pomiar ligabeta.mjs pokazal, ze Kontra ma najpewniejszy sygnal w calej
    // stawce (+3,07% ponad malpe), a mimo to jest ostatnia w tabeli — bo jej beta
    // wynosi +3,29, czyli zachowuje sie jak zwykle trzymanie krypto. Kupowanie paniki
    // oznacza wchodzenie na long wtedy, gdy rynek spada, i to ja topi.
    //
    // Ten gracz sprawdza, czy po odjeciu tego przypadkowego zakladu kierunkowego
    // sygnal faktycznie dowozi. Nie zmieniamy sygnalu ani grosza — tylko ekspozycje.
    if (def.bezRynku) {
      const netto = Object.values(g.positions).reduce(
        (a, p) => a + (p.side === 'LONG' ? p.notional : -p.notional), 0
      );
      const nettoPo = netto + (long ? notional : -notional);
      // Wolno wejsc, gdy pozycja zmniejsza przechyl albo zostawia go w granicach
      // jednej pozycji. Inaczej gracz pilby sie w jedna strone tak samo jak Kontra.
      if (Math.abs(nettoPo) > Math.abs(netto) && Math.abs(nettoPo) > notional) continue;
    }

    g.cash -= margin + oplata;
    g.stats.oplaty += oplata;
    sloty -= 1;
    g.positions[sym] = {
      sym, side: kier, entryPrice: px, entryTs: nowISO(), lastAccrual: nowISO(),
      qty: notional / px, notional, margin, leverage: P.LEVERAGE,
      liqPrice: liqPrice(kier, px, P.LEVERAGE, P.LIQ_AT),
      // Jedyne miejsce, w ktorym gracze moga sie roznic mechanika — i tylko dlatego,
      // ze Luzny istnieje wlasnie po to, zeby zmierzyc wplyw szerokosci stopa.
      stopPrice: (() => {
        const s = def.stopAtr ?? CFG.STOP_ATR;
        return long ? px - s * r.m.atr : px + s * r.m.atr;
      })(),
      takeProfit: long ? px + CFG.TAKE_PROFIT_ATR * r.m.atr : px - CFG.TAKE_PROFIT_ATR * r.m.atr,
      atrAtEntry: r.m.atr, bestPrice: px, worstPrice: px, trailArmed: false, borrowPaid: 0,
      trailAtr: def.trailAtr ?? CFG.TRAIL_ATR,
      minGodzin: def.minGodzin ?? 0,
      stopZawsze: !!def.stopZawsze,
      rynekWejscie: migawka,
      // Powod i liczby zostaja PRZY POZYCJI, zeby przy zamknieciu trafily na ten sam
      // wiersz co wynik. Inaczej mielibysmy osobno "dlaczego" i osobno "co z tego wyszlo",
      // a zeby czegokolwiek sie nauczyc, trzeba miec jedno obok drugiego.
      powodWejscia: powod,
      warunkiWejscia: warunki(r.m),
      // Obietnica zlozona przed wynikiem: ile ruchu gracz spodziewa sie zlapac
      // i ile ma za to zaplacic. Wraca na wpisie o zamknieciu, obok rezultatu.
      prognoza: prognozaWejscia(r.m, 2 * P.OPEN_FEE, sygnal.score ?? null),
    };
    nowe.push({
      id: `${teraz}-${id}-${sym}-o`, ts: nowISO(), gracz: id, sym, side: kier, type: 'OPEN',
      price: px, margin, notional, leverage: P.LEVERAGE, liqPrice: g.positions[sym].liqPrice, pnlUsd: null,
      reason: powod, warunki: g.positions[sym].warunkiWejscia,
      prognoza: g.positions[sym].prognoza,
    });
  }
}

// ── ranking ──
const ranking = Object.entries(GRACZE).map(([id, def]) => {
  const g = stan.gracze[id];
  const otwarty = Object.entries(g.positions).reduce(
    (a, [s, p]) => a + (rynek[s] ? pnlAt(p, rynek[s].m.price) - (p.borrowPaid || 0) : 0), 0
  );
  const zamrozony = Object.values(g.positions).reduce((a, p) => a + p.margin, 0);
  const kapital = g.cash + zamrozony + otwarty;
  return {
    id, nazwa: def.nazwa, opis: def.opis,
    kapital, roi: kapital / P.START - 1,
    cash: g.cash, otwarty, pozycji: Object.keys(g.positions).length,
    trejdy: g.stats.trejdy, wygrane: g.stats.wygrane,
    likwidacje: g.stats.likwidacje, oplaty: g.stats.oplaty,
  };
}).sort((a, b) => b.kapital - a.kapital);

// ── ile jeszcze trejdow, zeby to przestalo byc przypadkiem ──
const strategie = Object.keys(GRACZE).filter((id) => id !== 'malpa' && !GRACZE[id].nigdyNieZamykaj && !GRACZE[id].pozaTestem);
const testy = istotnosc(stan.gracze, GRACZE, 'malpa', strategie.length);

stan.updatedAt = nowISO();
stan.lastRun = {
  ts: nowISO(),
  prices: Object.fromEntries(Object.entries(rynek).map(([s, r]) => [s, r.m.price])),
  ranking,
  leverage: P.LEVERAGE,
  maxPozycji: P.MAX_POZ,
  start: P.START,
  istotnosc: { alfa: ALFA, porownan: strategie.length, moc: MOC, dMin: D_MIN, testy },
};

for (const t of nowe) trejdy.push(t);
while (trejdy.length > 1500) trejdy.shift();

equity.push({ ts: teraz, ...Object.fromEntries(ranking.map((r) => [r.id, +r.kapital.toFixed(2)])) });
// Gdy punktow zrobi sie za duzo, przerzedzamy STARSZA polowe co drugi. Dzieki temu
// ostatnie dni widac dokladnie, a poczatek ligi nie znika z wykresu — inaczej po
// dziesieciu dniach wykres pokazywalby tylko ostatni tydzien, a liga ma trwac miesiace.
if (equity.length > 4000) {
  const pol = Math.floor(equity.length / 2);
  equity = [...equity.slice(0, pol).filter((_, i) => i % 2 === 0), ...equity.slice(pol)];
}

writeJSON(F_STAN, stan);
writeJSON(F_TREJDY, trejdy);
writeJSON(F_EQUITY, equity);

log('');
log('── TABELA ──');
ranking.forEach((r, i) => {
  log(
    `  ${i + 1}. ${r.nazwa.padEnd(9)} ${usd(r.kapital).padStart(9)}  ${pct(r.roi).padStart(8)}   ` +
      `${r.trejdy} trejdów (${r.wygrane}W)${r.likwidacje ? `, ${r.likwidacje} likwidacji` : ''}` +
      `${r.pozycji ? `, ${r.pozycji} otwarte` : ''}`
  );
});
const malpa = ranking.find((r) => r.id === 'malpa');
const lepsi = ranking.filter((r) => r.id !== 'malpa' && r.id !== 'byk' && r.kapital > malpa.kapital).length;
log('');
log(`> ${lepsi} z ${strategie.length} strategii bije małpę kapitałem`);

log('');
log('── CZY TO JUŻ NIE PRZYPADEK ──');
for (const t of testy) {
  const proc = Math.round(t.postep * 100);
  const pasek = '█'.repeat(Math.round(proc / 5)).padEnd(20, '·');
  log(
    `  ${t.nazwa.padEnd(10)} ${pasek} ${String(t.n).padStart(4)}/${String(t.nPotrzebne).padEnd(5)} ` +
      `${SLOWA[t.werdykt]}${t.p != null ? `  (p=${t.p.toFixed(3)})` : ''}`
  );
}
log('');
log(`> próg istotności ${(ALFA / strategie.length).toFixed(4)} — podzielony przez ${strategie.length} porównania,`);
log(`  bo przy ${strategie.length} strategiach naraz jedna wygrywa "istotnie" samym trafem znacznie częściej.`);
