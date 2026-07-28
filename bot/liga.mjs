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

/**
 * Sygnał bota kontraktowego. Zwraca {kier, powod} albo null.
 *
 * Każdy gracz musi umieć powiedzieć, CO go wywołało — inaczej za pół roku będziemy
 * mieli tabelę wyników bez żadnej informacji, dlaczego wyszła właśnie taka.
 */
const sygnalTrendu = (sym, m, c) => {
  const L = entrySignal(sym, m, CFG, {});
  if (L.enter) return { kier: 'LONG', powod: L.reason };
  // lustro: trend spadkowy i odbicie do średniej
  const spadek = m.price < m.emaTrend && m.emaFast < m.emaSlow;
  const okno = m.rsi >= 100 - CFG.RSI_MAX && m.rsi <= 100 - CFG.RSI_MIN;
  const ext = (m.emaFast - m.price) / m.atr;
  if (spadek && okno && ext <= CFG.MAX_EXT_ATR && m.volPct >= CFG.MIN_VOL_PCT) {
    return {
      kier: 'SHORT',
      powod: `trend spadkowy, RSI ${m.rsi.toFixed(1)}, odbicie ${ext.toFixed(2)} ATR do średniej`,
    };
  }
  return null;
};

/** Zwraca {kier:'LONG'|'SHORT', powod} albo null. */
const GRACZE = {
  trend: {
    nazwa: 'Trend',
    opis: 'kupuje cofnięcie we wzroście, sprzedaje odbicie w spadku',
    wejscie: sygnalTrendu,
  },

  // Ten sam sygnał, przeciwny kierunek. Wchodzi dokładnie wtedy, kiedy Trend —
  // więc obaj mają tyle samo okazji i te same koszty. Różni ich wyłącznie znak.
  //
  // Trzy możliwe wyniki i wszystkie są warte zobaczenia:
  //   Trend wygrywa    → sygnał działa tak, jak myśleliśmy
  //   Antytrend wygrywa → sygnał działa, tylko odwrotnie; to odkrycie, nie porażka
  //   obaj przy zerze  → sygnał jest pusty, a różnica w tabeli to szum
  antytrend: {
    nazwa: 'Antytrend',
    opis: 'te same sygnały co Trend, tylko postawione na głowie',
    wejscie: (sym, m, c) => {
      const k = sygnalTrendu(sym, m, c);
      if (!k) return null;
      return { kier: k.kier === 'LONG' ? 'SHORT' : 'LONG', powod: `odwrotnie do: ${k.powod}` };
    },
  },

  // Te same wejscia co Trend. Rozni ich JEDNA liczba: szerokosc stopa.
  //
  // Test na 5 latach (bot/wyjscia.mjs) pokazal, ze stop 1,6 ATR wyrzuca pozycje,
  // ktore by wygraly — przy 3,5 ATR wynik przechodzil z -0,017% na +0,073% na trejd,
  // i to na obu probkach. Ale to byl wynik z HISTORII, a historia zawsze wyglada
  // lepiej niz przyszlosc: na probce testowej przewaga stopniala z +0,109% do +0,021%.
  //
  // Dlatego nie zmieniamy bota. Wstawiamy to jako osobnego gracza i sprawdzamy na
  // trejdach, ktore sie jeszcze nie wydarzyly. Jesli Luzny pobije Trend takze tutaj,
  // dopiero wtedy warto ruszac prawdziwego bota.
  luzny: {
    nazwa: 'Luzny',
    opis: 'te same wejscia co Trend, ale stop 3,5 ATR zamiast 1,6',
    wejscie: sygnalTrendu,
    stopAtr: 3.5,
  },

  // Te same wejscia co Trend, ta sama dzwignia, ten sam stop. Rozni ich smycz:
  // trailing 0,5 ATR zamiast 2,0.
  //
  // Ten gracz wzial sie z rozliczenia PORAZEK na zywo. Okazalo sie, ze przecietna
  // stratna pozycja zaszla 1,43-1,94 ATR w nasza strone, zanim sie zawalila —
  // a trailing stoi 2,0 ATR ponizej szczytu, czyli przy takim szczycie wypada
  // PONIZEJ ceny wejscia. Mechanizm od pilnowania zysku nie mial jak zadzialac.
  //
  // Sprawdzenie na 5 latach swiec (bot/wyjscia.mjs): trailing 0,5 ATR dal +0,102%
  // na trejd wobec -0,017% obecnych zasad, dodatnio na obu probkach. To najlepszy
  // wynik ze wszystkich 16 przetestowanych wariantow wyjscia.
  //
  // Ale to nadal historia. Tutaj sprawdzamy to na trejdach, ktore sie nie wydarzyly.
  smycz: {
    nazwa: 'Smycz',
    opis: 'te same wejscia co Trend, ale trailing 0,5 ATR zamiast 2,0',
    wejscie: sygnalTrendu,
    trailAtr: 0.5,
  },

  kontra: {
    nazwa: 'Kontra',
    opis: 'kupuje panikę, sprzedaje euforię',
    wejscie: (sym, m) => {
      if (m.rsi < 30) return { kier: 'LONG', powod: `RSI ${m.rsi.toFixed(1)} — panika, kupuję` };
      if (m.rsi > 70) return { kier: 'SHORT', powod: `RSI ${m.rsi.toFixed(1)} — euforia, sprzedaję` };
      return null;
    },
  },

  // Ten sam sygnal co Kontra, ta sama dzwignia, te same wyjscia i te same oplaty.
  // Rozni ich jedno: ten nie pozwala przechylowi urosnac ponad JEDNA pozycje.
  //
  // Dlaczego nie "zero przechylu": przy jednej otwartej pozycji neutralnosc jest
  // niemozliwa z definicji — cos musi byc pierwsze. Reguła dopuszcza wiec jedna
  // pozycje bez pary, a kazda kolejna musi rownowazyc. Przy czterech miejscach
  // daje to przechyl rzedu cwiartki zamiast calosci, jak u Kontry.
  //
  // Ile z tego wyjdzie w praktyce, zmierzy bot/ligabeta.mjs — jego beta powinna
  // byc wyraznie blizsza zeru niz +3,29 Kontry. Jesli nie bedzie, regula jest za slaba
  // i trzeba ja zaostrzyc; to tez jest wynik.
  //
  // Trzy mozliwe zakonczenia i kazde cos mowi:
  //   bije Kontre      -> alfa byla prawdziwa, topila ja ekspozycja
  //   wypada tak samo  -> beta Kontry nie miala znaczenia, szukamy dalej
  //   wypada gorzej    -> to ekspozycja niosla wynik, nie sygnal
  kontraN: {
    nazwa: 'Kontra rowna',
    opis: 'te same sygnaly co Kontra, ale nie przechyla sie w jedna strone rynku',
    wejscie: (sym, m) => {
      if (m.rsi < 30) return { kier: 'LONG', powod: `RSI ${m.rsi.toFixed(1)} — panika, kupuję` };
      if (m.rsi > 70) return { kier: 'SHORT', powod: `RSI ${m.rsi.toFixed(1)} — euforia, sprzedaję` };
      return null;
    },
    bezRynku: true,
  },

  wybicie: {
    nazwa: 'Wybicie',
    opis: 'wchodzi na sile, gdy cena łamie zakres z 20 świec',
    wejscie: (sym, m, c) => {
      if (c.length < 25) return null;
      const okno = c.slice(-21, -1);
      const max = Math.max(...okno.map((x) => x.h));
      const min = Math.min(...okno.map((x) => x.l));
      const px = c[c.length - 1].c;
      if (px > max) return { kier: 'LONG', powod: `${px.toFixed(2)} nad szczytem 20 świec ${max.toFixed(2)}` };
      if (px < min) return { kier: 'SHORT', powod: `${px.toFixed(2)} pod dołkiem 20 świec ${min.toFixed(2)}` };
      return null;
    },
  },

  malpa: {
    nazwa: 'Małpa',
    opis: 'rzuca monetą — punkt odniesienia dla całej reszty',
    wejscie: () => {
      if (Math.random() >= P.MALPA_SZANSA) return null;
      return { kier: Math.random() < 0.5 ? 'LONG' : 'SHORT', powod: 'rzut monetą — żadnego powodu' };
    },
  },

  byk: {
    nazwa: 'Byk',
    opis: 'kupuje SOL i nigdy nie sprzedaje',
    wejscie: (sym) => (sym === 'SOL' ? { kier: 'LONG', powod: 'kupuję SOL i nie sprzedaję' } : null),
    nigdyNieZamykaj: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Mechanika — identyczna dla wszystkich
// ─────────────────────────────────────────────────────────────────────────────

const liqPrice = (side, entry, lev) =>
  side === 'LONG' ? entry * (1 - P.LIQ_AT / lev) : entry * (1 + P.LIQ_AT / lev);

const pnlAt = (p, px) => (p.side === 'LONG' ? p.qty * (px - p.entryPrice) : p.qty * (p.entryPrice - px));

function czyWyjsc(p, m, px) {
  const long = p.side === 'LONG';
  const a = p.atrAtEntry || m.atr;
  const heldH = (Date.now() - Date.parse(p.entryTs)) / 3600000;
  if (long ? px <= p.stopPrice : px >= p.stopPrice) return 'STOP LOSS';
  if (long ? px >= p.takeProfit : px <= p.takeProfit) return 'TAKE PROFIT';
  if (p.trailArmed) {
    // Dlugosc smyczy zapisujemy przy pozycji, a nie bierzemy z konfiguracji, bo
    // gracz Smycz ma wlasna. Starsze pozycje jej nie maja i dostaja wartosc z CFG.
    const dl = p.trailAtr ?? CFG.TRAIL_ATR;
    const tr = long ? p.bestPrice - dl * a : p.bestPrice + dl * a;
    if (long ? px <= tr : px >= tr) return 'TRAILING STOP';
  }
  if (heldH > CFG.MAX_HOLD_HOURS && (long ? px < p.entryPrice : px > p.entryPrice)) return 'stop czasowy';
  return null;
}

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
    const powod = zlikwidowany ? 'LIKWIDACJA' : def.nigdyNieZamykaj ? null : czyWyjsc(p, r.m, px);
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
    const sygnal = def.wejscie(sym, r.m, r.c);
    if (!sygnal) continue;
    const { kier, powod } = sygnal;

    const margin = Math.min(g.cash, kapital * P.ALLOC);
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
      liqPrice: liqPrice(kier, px, P.LEVERAGE),
      // Jedyne miejsce, w ktorym gracze moga sie roznic mechanika — i tylko dlatego,
      // ze Luzny istnieje wlasnie po to, zeby zmierzyc wplyw szerokosci stopa.
      stopPrice: (() => {
        const s = def.stopAtr ?? CFG.STOP_ATR;
        return long ? px - s * r.m.atr : px + s * r.m.atr;
      })(),
      takeProfit: long ? px + CFG.TAKE_PROFIT_ATR * r.m.atr : px - CFG.TAKE_PROFIT_ATR * r.m.atr,
      atrAtEntry: r.m.atr, bestPrice: px, worstPrice: px, trailArmed: false, borrowPaid: 0,
      trailAtr: def.trailAtr ?? CFG.TRAIL_ATR,
      rynekWejscie: migawka,
      // Powod i liczby zostaja PRZY POZYCJI, zeby przy zamknieciu trafily na ten sam
      // wiersz co wynik. Inaczej mielibysmy osobno "dlaczego" i osobno "co z tego wyszlo",
      // a zeby czegokolwiek sie nauczyc, trzeba miec jedno obok drugiego.
      powodWejscia: powod,
      warunkiWejscia: warunki(r.m),
    };
    nowe.push({
      id: `${teraz}-${id}-${sym}-o`, ts: nowISO(), gracz: id, sym, side: kier, type: 'OPEN',
      price: px, margin, notional, leverage: P.LEVERAGE, liqPrice: g.positions[sym].liqPrice, pnlUsd: null,
      reason: powod, warunki: g.positions[sym].warunkiWejscia,
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
const strategie = Object.keys(GRACZE).filter((id) => id !== 'malpa' && !GRACZE[id].nigdyNieZamykaj);
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
