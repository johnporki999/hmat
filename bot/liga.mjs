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
  UNIVERSE, CFG, env, envNum, envBool, usd, pct, analyze, entrySignal,
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

// H38: dwa papierowe ramiona tej samej Paniki. Tryb jest domyslnie wylaczony
// i nie zmienia skladu ani historii zadnej istniejacej ligi.
const TEST_CZAS = envBool('LIGA_TEST_CZAS', false);
const FUNDING_HL = envBool('LIGA_FUNDING_HL', false);

// SKLAD LIGI. Puste = wszyscy, jak dotad.
//
// Bez tego kazdy nowy wariant strategii wchodzil do WSZYSTKICH lig naraz
// i zaostrzal prog istotnosci wszystkim pozostalym — prog dzieli sie przez
// liczbe porownywanych graczy, wiec dolozenie szesnastego utrudnia werdykt
// pietnastu, ktorzy zbieraja dane od lipca. To jest realny koszt, placony
// przez eksperyment, ktory juz trwa, za hipoteze, ktora dopiero startuje.
//
// Osobna liga z wlasnym skladem ma wlasne liczenie i nie kosztuje nikogo nic.
const CHCE = env('LIGA_GRACZE', '').split(',').map((s) => s.trim()).filter(Boolean);
const WSZYSCY = stworzGraczy({ malpaSzansa: P.MALPA_SZANSA });
if (TEST_CZAS) {
  WSZYSCY.panika5m = {
    ...WSZYSCY.panika,
    nazwa: 'Panika 5m',
    opis: 'Panika oceniana co przebieg na budowanej świecy 15m',
    wariantCzasu: 'srodswiecowy-5m',
  };
  WSZYSCY.panika15m = {
    ...WSZYSCY.panika,
    nazwa: 'Panika 15m',
    opis: 'Panika oceniana raz, dopiero po zamknięciu świecy 15m',
    wariantCzasu: 'zamknieta-15m',
    tylkoZamknieta: true,
  };
}
if (CHCE.length) {
  const nieznani = CHCE.filter((c) => !WSZYSCY[c]);
  if (nieznani.length) { console.error(`! LIGA_GRACZE: nie znam ${nieznani.join(', ')}`); process.exit(1); }
  if (!CHCE.includes('malpa')) {
    console.error('! LIGA_GRACZE bez malpy — nie byloby punktu odniesienia. Dopisz `malpa`.');
    process.exit(1);
  }
}
const GRACZE = CHCE.length
  ? Object.fromEntries(CHCE.map((id) => [id, WSZYSCY[id]]))
  : WSZYSCY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const katalogStanu = env('LIGA_STATE_DIR', '');
const DIR = katalogStanu
  ? (path.isAbsolute(katalogStanu) ? katalogStanu : path.resolve(ROOT, katalogStanu))
  : path.join(ROOT, 'state');

// Ten sam kod obsluguje DWIE ligi. Rozni je wylacznie konfiguracja podana
// w zmiennych srodowiskowych: przedrostek plikow stanu i lista aktywow.
// Dzieki temu nie ma drugiej kopii czterystu linii mechaniki, ktora po
// miesiacu cichutko rozjechalaby sie z pierwsza — a wtedy porownanie
// obu lig nie mierzyloby niczego.
const PREFIKS = env('LIGA_PREFIX', 'liga');
const F_STAN = path.join(DIR, `${PREFIKS}-state.json`);
const F_TREJDY = path.join(DIR, `${PREFIKS}-trades.json`);
const F_EQUITY = path.join(DIR, `${PREFIKS}-equity.json`);

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

/**
 * ZRODLO SWIEC — H34.
 *
 * Ligi A, B i C pobieraja swiece z Krakena albo Binance (SPOT), a bot na zywo
 * decyduje na swiecach Hyperliquid (PERPY). Aneks 85 zmierzyl, ze to nie jest
 * ta sama seria: ATR na HL jest o 5-23% NIZSZY (BTC 1,008, SOL 0,955,
 * PYTH 0,872, BONK 0,771). Prog Paniki liczy sie wlasnie z ATR, wiec liga
 * pokazuje inna czestosc sygnalow niz ta, ktora bot moze osiagnac.
 *
 * `LIGA_ZRODLO=hl` przelacza na candleSnapshot z Hyperliquid. Domyslnie
 * WYLACZONE, zeby biegnace ligi zachowaly ciaglosc pomiaru — zmiana zrodla
 * w trakcie eksperymentu unieważniłaby ich historie.
 *
 * BONK figuruje na HL jako kBONK (w tysiacach), ale wszystkie wskazniki sa
 * wzgledne (ATR/cena, RSI), wiec skala nie ma znaczenia.
 */
const ZRODLO = env('LIGA_ZRODLO', 'spot');
const NAZWA_HL = { BONK: 'kBONK' };
const SNAPSHOT_IN = env('LIGA_SNAPSHOT_IN', '');
const SNAPSHOT_OUT = env('LIGA_SNAPSHOT_OUT', '');
const SNAPSHOT_MAX_AGE_MS = envNum('LIGA_SNAPSHOT_MAX_AGE_MS', 120000);
const KONTEKST_HL = envBool('LIGA_KONTEKST_HL', false) || !!SNAPSHOT_OUT || FUNDING_HL;
const KONTEKST_WYMAGANY = envBool('LIGA_KONTEKST_WYMAGANY', false);

const sciezkaOdRoot = (f) => (path.isAbsolute(f) ? f : path.resolve(ROOT, f));
let snapshotWejscie = null;
if (SNAPSHOT_IN) {
  const f = sciezkaOdRoot(SNAPSHOT_IN);
  snapshotWejscie = readJSON(f, null);
  const wiek = snapshotWejscie ? Date.now() - Number(snapshotWejscie.fetchedAt || 0) : Infinity;
  if (!snapshotWejscie || snapshotWejscie.source !== 'hl'
      || snapshotWejscie.intervalMin !== CFG.CANDLE_MINUTES
      || wiek < 0 || wiek > SNAPSHOT_MAX_AGE_MS) {
    console.error(`! LIGA_SNAPSHOT_IN: brak świeżej migawki HL w ${f} (maks. ${SNAPSHOT_MAX_AGE_MS} ms)`);
    process.exit(1);
  }
}

async function infoHL(body) {
  const r = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  return r.json().catch(() => null);
}

async function swieceHL(sym, minut) {
  if (snapshotWejscie) {
    const c = snapshotWejscie.candles?.[sym];
    return Array.isArray(c) && c.length >= 60 ? c : null;
  }
  const coin = NAZWA_HL[sym] || sym;
  const teraz = Date.now();
  const j = await infoHL({ type: 'candleSnapshot', req: { coin,
    interval: `${minut}m`, startTime: teraz - 500 * minut * 60000, endTime: teraz } });
  if (!Array.isArray(j) || j.length < 60) return null;
  return j.map((x) => ({ t: x.t, T: x.T, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v }));
}

const liczbaLubNull = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

async function kontekstyHL(aktywa) {
  if (snapshotWejscie) return snapshotWejscie.contexts || {};
  if (!KONTEKST_HL || ZRODLO !== 'hl') return {};
  const j = await infoHL({ type: 'metaAndAssetCtxs' });
  const uni = j?.[0]?.universe;
  const ctx = j?.[1];
  if (!Array.isArray(uni) || !Array.isArray(ctx)) return {};
  const indeks = new Map(uni.map((x, i) => [x.name, i]));
  const out = {};
  for (const sym of aktywa) {
    const i = indeks.get(NAZWA_HL[sym] || sym);
    const x = i == null ? null : ctx[i];
    if (!x) continue;
    const impactBid = liczbaLubNull(x.impactPxs?.[0]);
    const impactAsk = liczbaLubNull(x.impactPxs?.[1]);
    const midPx = liczbaLubNull(x.midPx);
    out[sym] = {
      funding: liczbaLubNull(x.funding),
      openInterest: liczbaLubNull(x.openInterest),
      markPx: liczbaLubNull(x.markPx),
      midPx,
      oraclePx: liczbaLubNull(x.oraclePx),
      premium: liczbaLubNull(x.premium),
      impactBid,
      impactAsk,
      impactSpreadPct: impactBid != null && impactAsk != null && midPx > 0
        ? (impactAsk - impactBid) / midPx : null,
      dayNtlVlm: liczbaLubNull(x.dayNtlVlm),
    };
  }
  return out;
}

function writeJSONAtomic(f, x) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(x) + '\n', 'utf8');
  fs.renameSync(tmp, f);
}

async function swiece(sym, minut) {
  if (ZRODLO === 'hl') {
    const h = await swieceHL(sym, minut);
    if (h) return h;
    // Bez awaryjnego zejscia na spot: liga HL ma mierzyc WYLACZNIE dane HL.
    // Ciche podmienienie zrodla zepsuloby caly sens tego eksperymentu.
    console.error(`  ! ${sym}: Hyperliquid nie oddal swiec — pomijam rynek w tym przebiegu`);
    return null;
  }
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
// Kazda liga dostaje wlasna liste przez LIGA_ASSETS (ustawia ja run.sh) — bez
// tego dzielilyby uniwersum i nie byloby czego porownywac.
const listaAktywow = env('LIGA_ASSETS', '');
const aktywa = (listaAktywow ? listaAktywow.split(',').map((s) => s.trim()) : CFG.ASSETS)
  .filter((s) => UNIVERSE[s]);

// ── ZAMEK NA BOISKO ─────────────────────────────────────────────────────────
//
// Uniwersum ligi to BOISKO, na ktorym gra osiemnastu graczy. Zmiana go w
// polowie eksperymentu uniewaznia wszystkie porownania miedzy nimi — czesc
// wynikow pochodzilaby z jednego zestawu monet, czesc z innego, a my nie
// mielibysmy jak tego rozdzielic po fakcie.
//
// Zamek jest tu, bo liga A brala liste z CFG.ASSETS, czyli ze zmiennej ASSETS
// wspoldzielonej z botem perp. Wystarczylo podkrecic bota perp w deploy/.env,
// zeby po cichu przestawic boisko lidze. Teraz run.sh podaje obu ligom liste
// wprost, a ten zamek pilnuje, ze nikt jej nie ruszy niepostrzezenie.
const odciskUniwersum = [...aktywa].sort().join(',');
if (!stan.uniwersum) {
  stan.uniwersum = odciskUniwersum;
} else if (stan.uniwersum !== odciskUniwersum && env('LIGA_ZMIEN_UNIWERSUM', '') !== '1') {
  console.error('! UNIWERSUM LIGI SIE ZMIENILO — zatrzymuje sie, zeby nie zepsuc eksperymentu.');
  console.error(`  bylo: ${stan.uniwersum}`);
  console.error(`  jest: ${odciskUniwersum}`);
  console.error('  Jesli ta zmiana jest ZAMIERZONA, uruchom raz z LIGA_ZMIEN_UNIWERSUM=1 —');
  console.error('  ale pamietaj, ze porownania miedzy graczami zaczna sie wtedy liczyc od nowa.');
  process.exit(1);
} else if (stan.uniwersum !== odciskUniwersum) {
  log(`> UNIWERSUM ZMIENIONE SWIADOMIE: ${stan.uniwersum} -> ${odciskUniwersum}`);
  stan.uniwersum = odciskUniwersum;
  stan.uniwersumZmienione = nowISO();
}
if (TEST_CZAS) {
  const konfiguracja = {
    hipoteza: 'H38',
    ramiona: ['panika5m', 'panika15m'],
    kontrola: 'malpa',
    zrodlo: ZRODLO,
    aktywa: [...aktywa],
    interwalMin: CFG.CANDLE_MINUTES,
    dzwignia: P.LEVERAGE,
    miejsca: P.MAX_POZ,
    alloc: P.ALLOC,
    oplataNaStrone: P.OPEN_FEE,
    fundingHL: FUNDING_HL,
    minimumTrejdowNaRamie: 40,
    minimumEpizodow: 15,
    przerwaEpizoduH: 72,
  };
  if (!stan.forwardTest) {
    stan.forwardTest = { startAt: nowISO(), konfiguracja, postep: null };
  } else if (JSON.stringify(stan.forwardTest.konfiguracja) !== JSON.stringify(konfiguracja)) {
    console.error('! KONFIGURACJA H38 SIE ZMIENILA — zatrzymuje test zamiast mieszać dwa eksperymenty.');
    console.error('  Nowe ustawienia wymagają nowego prefiksu albo LIGA_RESET=1.');
    process.exit(1);
  }
}
const rynek = {};
const czasMigawki = Number(snapshotWejscie?.fetchedAt) || Date.now();
for (const sym of aktywa) {
  const c = await swiece(sym, CFG.CANDLE_MINUTES);
  if (!c) continue;
  const m = analyze(c, CFG);
  const cZamkniete = c.filter((x) => {
    const koniec = Number.isFinite(Number(x.T)) ? Number(x.T) : Number(x.t) + CFG.CANDLE_MINUTES * 60000 - 1;
    return koniec <= czasMigawki;
  });
  const mZamknieta = cZamkniete.length >= 60 ? analyze(cZamkniete, CFG) : null;
  if (m.emaTrend && m.atr && m.rsi != null) {
    rynek[sym] = {
      m, c,
      zamkniety: mZamknieta?.emaTrend && mZamknieta?.atr && mZamknieta?.rsi != null
        ? { m: mZamknieta, c: cZamkniete } : null,
    };
  }
  if (!snapshotWejscie) await sleep(300);
}
if (!Object.keys(rynek).length) {
  log('!! brak danych rynkowych');
  process.exit(1);
}
const kontekstRynkuHL = await kontekstyHL(Object.keys(rynek));
if (KONTEKST_WYMAGANY) {
  const brak = Object.keys(rynek).filter((sym) => !kontekstRynkuHL[sym]);
  if (brak.length) {
    console.error(`! brak wymaganego kontekstu HL dla: ${brak.join(', ')}`);
    process.exit(1);
  }
}
if (SNAPSHOT_OUT) {
  if (ZRODLO !== 'hl' || snapshotWejscie) {
    console.error('! LIGA_SNAPSHOT_OUT wymaga bezpośredniego źródła LIGA_ZRODLO=hl');
    process.exit(1);
  }
  const f = sciezkaOdRoot(SNAPSHOT_OUT);
  writeJSONAtomic(f, {
    version: 1,
    source: 'hl',
    fetchedAt: czasMigawki,
    intervalMin: CFG.CANDLE_MINUTES,
    assets: Object.keys(rynek),
    candles: Object.fromEntries(Object.entries(rynek).map(([sym, r]) => [sym, r.c])),
    contexts: kontekstRynkuHL,
  });
  log(`> wspólna migawka HL: ${f}`);
}
log(`> zeskanowano ${Object.keys(rynek).length} aktywów`);

// ── sejsmograf: czy w ostatniej dobie rynkiem tąpnęło ────────────────────────
//
// UWAGA: ten komentarz obiecywal kiedys, ze BTC jest tu WYLACZNIE czujnikiem
// i nie wchodzi do uniwersum ligi. To bylo nieprawda i wprowadzalo w blad —
// liga A handluje BTC i ETH od pierwszego przebiegu, bo brala liste z CFG.ASSETS.
// Zostawiamy to tak, jak jest: usuniecie ich TERAZ byloby wlasnie ta zmiana
// boiska w polowie eksperymentu, przed ktora ostrzegal stary komentarz.
//
// Czujnik i uniwersum to wiec dwie role tego samego aktywa: ponizej BTC sluzy
// za miare paniki na rynku, a rownoczesnie gracze moga nim handlowac.
//
// Regula (bot/cache/MOTANIE-WNIOSKI.md): jesli w ciagu ostatnich 24h byla
// chwila, w ktorej dobowy ruch BTC przekroczyl prog, gracz-sejsmograf nie
// otwiera niczego. Wyjscia dzialaja normalnie — cisza dotyczy tylko wejsc.
const SEJSMO_PROG = envNum('SEJSMO_PROG', 0.05);
let rynekTrzasl = false;
let odczytSejsmo = null;
{
  // BTC jest juz w migawce Ligi HL. Ponowne pobranie kosztowalo jedno wywolanie
  // API i moglo dac inna ostatnia cene niz ta, na ktorej decydowali gracze.
  const c = rynek.BTC?.c || await swiece('BTC', CFG.CANDLE_MINUTES);
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

// W H38 OI, funding i spread sa tylko rejestrowane. Nie wolno im zmieniac
// sygnalu w trakcie forward testu. Historia 25 przebiegow daje ponad godzine
// odniesienia przy cronie co okolo 5 minut, z zapasem na opoznienia serwera.
if (TEST_CZAS) {
  stan.kontekstHL = stan.kontekstHL || {};
  for (const [sym, ctx] of Object.entries(kontekstRynkuHL)) {
    const h = stan.kontekstHL[sym] = stan.kontekstHL[sym] || [];
    if (h[h.length - 1]?.tsMs !== czasMigawki) {
      h.push({ ts: new Date(czasMigawki).toISOString(), tsMs: czasMigawki, ...ctx });
      if (h.length > 25) h.splice(0, h.length - 25);
    }
  }
}

const zmianaWzgledna = (a, b) => (a != null && b > 0 ? a / b - 1 : null);
function zwrotTla(sym, minuty) {
  const r = rynek[sym];
  if (!r) return null;
  const cel = teraz - minuty * 60000;
  let poprzednia = null;
  for (let i = r.c.length - 1; i >= 0; i--) {
    if (Number(r.c[i].t) <= cel) { poprzednia = r.c[i].c; break; }
  }
  return zmianaWzgledna(r.m.price, poprzednia);
}
function kontekstDecyzji(sym) {
  const h = stan.kontekstHL?.[sym] || [];
  const b = h[h.length - 1] || (kontekstRynkuHL[sym]
    ? { ts: nowISO(), tsMs: czasMigawki, ...kontekstRynkuHL[sym] } : null);
  if (!b) return null;
  const poprzednia = h.length > 1 ? h[h.length - 2] : null;
  const cel1h = Number(b.tsMs) - 3600000;
  let godzina = null;
  for (const x of h.slice(0, -1)) {
    if (!godzina || Math.abs(Number(x.tsMs) - cel1h) < Math.abs(Number(godzina.tsMs) - cel1h)) godzina = x;
  }
  if (godzina && Math.abs(Number(godzina.tsMs) - cel1h) > 20 * 60000) godzina = null;
  return {
    ...b,
    oiZmianaOdPoprzedniej: zmianaWzgledna(b.openInterest, poprzednia?.openInterest),
    sekundOdPoprzedniej: poprzednia ? (Number(b.tsMs) - Number(poprzednia.tsMs)) / 1000 : null,
    oiZmiana1h: zmianaWzgledna(b.openInterest, godzina?.openInterest),
    btcZmiana15m: zwrotTla('BTC', 15),
    ethZmiana15m: zwrotTla('ETH', 15),
    btcZmiana1h: zwrotTla('BTC', 60),
    ethZmiana1h: zwrotTla('ETH', 60),
  };
}
const kosztTrzymania = (p) => (p.borrowPaid || 0) + (p.fundingPaid || 0);

function skrotMetryk(m) {
  return m ? { price: m.price, atr: m.atr, volPct: m.volPct, rsi: m.rsi, barTs: m.barTs } : null;
}

// Surowy przyrzad H38, niezalezny od slotow i gotowki portfela. Dzieki temu
// brak wejscia z powodu zajetego miejsca nie udaje sygnalu, ktory zniknal.
function obserwujTrwaloscSygnalu() {
  if (!TEST_CZAS) return;
  const f = stan.forwardTest;
  f.sygnaly = f.sygnaly || { pierwszeWTrakcie: 0, przetrwaly: 0, zniknely: 0, tylkoNaZamknieciu: 0 };
  f.budowaneSwiece = f.budowaneSwiece || {};
  f.obserwacje = f.obserwacje || [];

  for (const [sym, r] of Object.entries(rynek)) {
    const oczekujaca = f.budowaneSwiece[sym];
    if (oczekujaca) {
      const i = r.c.findIndex((x) => Number(x.t) === Number(oczekujaca.barTs));
      if (i >= 0) {
        const x = r.c[i];
        const koniec = Number.isFinite(Number(x.T)) ? Number(x.T)
          : Number(x.t) + CFG.CANDLE_MINUTES * 60000 - 1;
        if (koniec <= czasMigawki) {
          const mClose = analyze(r.c.slice(0, i + 1), CFG);
          const close = !!WSZYSCY.panika.wejscie(sym, mClose, r.c.slice(0, i + 1));
          if (oczekujaca.mialSygnal) {
            f.sygnaly.pierwszeWTrakcie += 1;
            if (close) f.sygnaly.przetrwaly += 1;
            else f.sygnaly.zniknely += 1;
          } else if (close) {
            f.sygnaly.tylkoNaZamknieciu += 1;
          }
          if (oczekujaca.mialSygnal || close) {
            f.obserwacje.push({
              sym,
              barTs: oczekujaca.barTs,
              pierwszyOdczytMs: oczekujaca.pierwszyOdczytMs,
              pierwszySygnalMs: oczekujaca.pierwszySygnalMs || null,
              sygnalWTrakcie: !!oczekujaca.mialSygnal,
              sygnalNaZamknieciu: close,
              metrykiPierwszegoSygnalu: oczekujaca.metrykiPierwszegoSygnalu || null,
              metrykiZamkniecia: skrotMetryk(mClose),
            });
            if (f.obserwacje.length > 1000) f.obserwacje.splice(0, f.obserwacje.length - 1000);
          }
          delete f.budowaneSwiece[sym];
        }
      }
    }

    const ostatnia = r.c[r.c.length - 1];
    const koniec = Number.isFinite(Number(ostatnia?.T)) ? Number(ostatnia.T)
      : Number(ostatnia?.t) + CFG.CANDLE_MINUTES * 60000 - 1;
    if (!ostatnia || koniec <= czasMigawki) continue;
    let b = f.budowaneSwiece[sym];
    if (!b || Number(b.barTs) !== Number(ostatnia.t)) {
      b = f.budowaneSwiece[sym] = {
        barTs: Number(ostatnia.t),
        pierwszyOdczytMs: czasMigawki,
        mialSygnal: false,
      };
    }
    const sygnal = !!WSZYSCY.panika.wejscie(sym, r.m, r.c);
    if (sygnal && !b.mialSygnal) {
      b.mialSygnal = true;
      b.pierwszySygnalMs = czasMigawki;
      b.metrykiPierwszegoSygnalu = skrotMetryk(r.m);
    }
  }
}

obserwujTrwaloscSygnalu();

for (const [id, def] of Object.entries(GRACZE)) {
  const g = stan.gracze[id];

  // ── wyjścia i likwidacje ──
  for (const sym of Object.keys(g.positions)) {
    const r = rynek[sym];
    if (!r) continue;
    const p = g.positions[sym];
    const px = r.m.price;

    const godz = Math.max(0, (teraz - Date.parse(p.lastAccrual || p.entryTs)) / 3600000);
    if (FUNDING_HL) {
      const stopa = kontekstRynkuHL[sym]?.funding;
      if (Number.isFinite(stopa)) {
        // Na HL dodatni funding placi long, ujemny funding placi short.
        const koszt = p.notional * stopa * (p.side === 'LONG' ? 1 : -1) * godz;
        p.fundingPaid = (p.fundingPaid || 0) + koszt;
        g.stats.funding = (g.stats.funding || 0) + koszt;
      } else {
        p.brakiFundingu = (p.brakiFundingu || 0) + 1;
      }
    } else {
      p.borrowPaid = (p.borrowPaid || 0) + p.notional * (p.side === 'LONG' ? P.BORROW_L : P.BORROW_S) * godz;
    }
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
    const netto = brutto - oplata - kosztTrzymania(p);
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
    //
    // Doliczamy oplate WEJSCIOWA, ktorej nie ma w `netto`. Nie jest to blad
    // ksiegowy: przy otwarciu zeszla juz z gotowki (g.cash -= margin + oplata),
    // wiec kapital i ranking byly caly czas poprawne. Ale R sluzy do czegos
    // innego — do testu istotnosci — i tam liczy sie PELNY koszt rundy.
    //
    // Pomiar na 747 zywych trejdach (bot/cache/przyrzad.mjs, 31.07.2026): przy
    // dzwigni 3x brak tej oplaty zawyzal kazde R o rowne 0,180 pkt proc.
    // To duzo, bo typowe R graczy miesci sie w +-0,5%.
    //
    // Porownania Z MALPA byly odporne na ten blad, bo malpa dostawala to samo
    // zawyzenie. Zafalszowana byla wylacznie liczba bezwzgledna.
    const oplataWejscia = zlikwidowany ? 0 : p.notional * P.OPEN_FEE;
    const R = p.margin ? (zlikwidowany ? -1 : (netto - oplataWejscia) / p.margin) : 0;
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
      // pnlUsd i pnlPct opisuja SAMO ZAMKNIECIE, bez oplaty wejsciowej, ktora
      // zeszla z gotowki wczesniej. R to pelny zwrot z rundy, z obiema oplatami —
      // i to jego trzeba uzywac w analizach. Bez tego pola latwo policzyc
      // pnlUsd/margin i zawyzyc kazdy wynik o 0,18 pkt proc. (tak sie wlasnie stalo).
      R,
      entryTs: p.entryTs,
      fundingUsd: p.fundingPaid || 0,
      borrowUsd: p.borrowPaid || 0,
      brakiFundingu: p.brakiFundingu || 0,
      holdMs: teraz - Date.parse(p.entryTs),
      liquidated: zlikwidowany,
      reason: powod,
      // dlaczego weszlismy + jakie byly wtedy liczby, obok wyniku tego wejscia
      powodWejscia: p.powodWejscia || null,
      warunki: p.warunkiWejscia || null,
      prognoza: p.prognoza || null,
      wariantCzasu: p.wariantCzasu || null,
      barDecyzji: p.barDecyzji ?? null,
      kontekstWejscia: p.kontekstWejscia || null,
      kontekstWyjscia: kontekstDecyzji(sym),
      // jak daleko cena zaszla w obie strony i co robil w tym czasie caly rynek
      ...wychylenia(p, p.atrAtEntry || r.m.atr),
      rynek: zmianaRynku(p.rynekWejscie, migawka),
    });
    delete g.positions[sym];
  }

  // ── wejścia ──
  const otwarte = Object.keys(g.positions).length;
  const kapital = g.cash + Object.entries(g.positions).reduce(
    (a, [s, p]) => a + p.margin + (rynek[s] ? pnlAt(p, rynek[s].m.price) - kosztTrzymania(p) : 0), 0
  );
  let sloty = P.MAX_POZ - otwarte;
  if (TEST_CZAS && stan.forwardTest?.freezeNewEntries) sloty = 0;

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
    let decyzja = r;
    if (def.tylkoZamknieta) {
      if (!r.zamkniety) continue;
      decyzja = r.zamkniety;
      g.ostatniaDecyzja = g.ostatniaDecyzja || {};
      // Jedna zamknieta swieca moze byc widoczna w trzech kolejnych przebiegach
      // crona. Ramie 15m ma ja ocenic raz, a nie dostac trzy losy na wejscie.
      if (g.ostatniaDecyzja[sym] === decyzja.m.barTs) continue;
      g.ostatniaDecyzja[sym] = decyzja.m.barTs;
    }
    const sygnal = def.wejscie(sym, decyzja.m, decyzja.c);
    if (!sygnal) continue;
    const { kier, powod } = sygnal;

    // Krawiec szyje depozyt na miare ryzyka: tak, zeby uderzenie w stop zabralo
    // zawsze ryzykoPct kapitalu, niezaleznie od tego, jak dzikie jest aktywo.
    // Gorny limit ten sam co u wszystkich (ALLOC), zeby spokojny rynek nie
    // rozdmuchal pozycji w nieskonczonosc.
    let margin = Math.min(g.cash, kapital * P.ALLOC);
    if (def.ryzykoPct && decyzja.m.volPct > 0) {
      const stopA = def.stopAtr ?? CFG.STOP_ATR;
      const naMiare = (kapital * def.ryzykoPct) / (P.LEVERAGE * stopA * decyzja.m.volPct);
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
        return long ? px - s * decyzja.m.atr : px + s * decyzja.m.atr;
      })(),
      takeProfit: long ? px + CFG.TAKE_PROFIT_ATR * decyzja.m.atr : px - CFG.TAKE_PROFIT_ATR * decyzja.m.atr,
      atrAtEntry: decyzja.m.atr, bestPrice: px, worstPrice: px, trailArmed: false,
      borrowPaid: 0, fundingPaid: 0, brakiFundingu: 0,
      trailAtr: def.trailAtr ?? CFG.TRAIL_ATR,
      bezSmyczy: !!def.bezSmyczy,
      minGodzin: def.minGodzin ?? 0,
      stopZawsze: !!def.stopZawsze,
      karencjaStopH: def.karencjaStopH ?? 0,
      maxHoldH: def.maxHoldH ?? 0,
      rynekWejscie: migawka,
      wariantCzasu: def.wariantCzasu || null,
      barDecyzji: decyzja.m.barTs,
      kontekstWejscia: kontekstDecyzji(sym),
      // Powod i liczby zostaja PRZY POZYCJI, zeby przy zamknieciu trafily na ten sam
      // wiersz co wynik. Inaczej mielibysmy osobno "dlaczego" i osobno "co z tego wyszlo",
      // a zeby czegokolwiek sie nauczyc, trzeba miec jedno obok drugiego.
      powodWejscia: powod,
      // Ostatnia swieca to ta, na ktorej zapadla decyzja — dorzuca do dziennika
      // jej ksztalt, czyli JAK cena doszla do tego stanu, a nie tylko jaki on jest.
      warunkiWejscia: warunki(decyzja.m, decyzja.c[decyzja.c.length - 1], long, decyzja.c),
      // Obietnica zlozona przed wynikiem: ile ruchu gracz spodziewa sie zlapac
      // i ile ma za to zaplacic. Wraca na wpisie o zamknieciu, obok rezultatu.
      prognoza: prognozaWejscia(decyzja.m, 2 * P.OPEN_FEE, sygnal.score ?? null),
    };
    nowe.push({
      id: `${teraz}-${id}-${sym}-o`, ts: nowISO(), gracz: id, sym, side: kier, type: 'OPEN',
      price: px, margin, notional, leverage: P.LEVERAGE, liqPrice: g.positions[sym].liqPrice, pnlUsd: null,
      reason: powod, warunki: g.positions[sym].warunkiWejscia,
      prognoza: g.positions[sym].prognoza,
      wariantCzasu: g.positions[sym].wariantCzasu,
      barDecyzji: g.positions[sym].barDecyzji,
      kontekstWejscia: g.positions[sym].kontekstWejscia,
    });
  }
}

// ── ranking ──
const ranking = Object.entries(GRACZE).map(([id, def]) => {
  const g = stan.gracze[id];
  const otwarty = Object.entries(g.positions).reduce(
    (a, [s, p]) => a + (rynek[s] ? pnlAt(p, rynek[s].m.price) - kosztTrzymania(p) : 0), 0
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
if (TEST_CZAS) {
  const ramiona = ['panika5m', 'panika15m'];
  const zamkniete = Object.fromEntries(ramiona.map((id) => [id,
    stan.gracze[id]?.stats?.trejdy || 0]));
  const noweWejscia = nowe
    .filter((t) => ramiona.includes(t.gracz) && t.type === 'OPEN')
    .map((t) => Date.parse(t.ts))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let epizody = stan.forwardTest.postep?.epizody || 0;
  let poprzedni = stan.forwardTest.ostatnieWejscieMs ?? null;
  for (const ts of noweWejscia) {
    if (poprzedni == null || ts - poprzedni > 72 * 3600000) epizody += 1;
    poprzedni = ts;
  }
  stan.forwardTest.ostatnieWejscieMs = poprzedni;
  const gotowy = ramiona.every((id) => zamkniete[id] >= 40) && epizody >= 15;
  if (gotowy && !stan.forwardTest.freezeNewEntries) {
    stan.forwardTest.freezeNewEntries = true;
    stan.forwardTest.freezeAt = nowISO();
  }
  const otwarteRazem = Object.values(stan.gracze)
    .reduce((n, g) => n + Object.keys(g.positions || {}).length, 0);
  if (stan.forwardTest.freezeNewEntries && otwarteRazem === 0 && !stan.forwardTest.completeAt) {
    stan.forwardTest.completeAt = nowISO();
  }
  stan.forwardTest.postep = {
    ts: nowISO(),
    zamkniete,
    epizody,
    otwarteRazem,
    progDanychOsiagniety: gotowy,
    gotowyDoRozliczenia: !!stan.forwardTest.completeAt,
    uwaga: stan.forwardTest.completeAt
      ? 'próg danych osiągnięty i wszystkie pozycje zamknięte — wolno rozliczyć H38'
      : gotowy ? 'nowe wejścia zamrożone — czekam na zamknięcie pozycji' : 'nie wyciągać werdyktu',
  };
}
/**
 * PRZYCINANIE DZIENNIKA — Z GWARANCJA DLA GRACZY RZADKICH.
 *
 * Stara wersja robila `while (trejdy.length > 1500) trejdy.shift()`, czyli
 * scinala najstarsze trejdy CALEJ ligi naraz. Przy dziewietnastu graczach
 * i limicie 1500 oznaczalo to, ze gracz grajacy rzadko traci CALA swoja
 * historie, bo wypychaja ja trejdy graczy czestych.
 *
 * Objaw byl mylacy i zglosil go uzytkownik: w lidze B Panika pokazuje
 * "2 trejdy" (bo licznik `stats.trejdy` jest SKUMULOWANY), ale po wejsciu
 * w jej kartę nie ma zadnego — bo dziennik jest RUCHOMYM OKNEM i oba jej
 * trejdy dawno z niego wypadly. Dwie liczby o tej samej nazwie liczone
 * inaczej: dokladnie ta pulapka, ktora zapisalismy w rejestrze.
 *
 * Nowa zasada: kazdy gracz zachowuje swoje ostatnie MIN_NA_GRACZA trejdow
 * ZAWSZE, a dopiero reszta budzetu idzie na najswiezsze trejdy pozostalych.
 * Gracz rzadki jest wiec widoczny nawet po miesiacach, a plik zostaje
 * ograniczony.
 */
const MAX_LACZNIE = 1500, MIN_NA_GRACZA = TEST_CZAS ? 200 : 60;
if (trejdy.length > MAX_LACZNIE) {
  const wgGracza = new Map();
  for (const t of trejdy) {
    const k = t.gracz ?? '?';
    if (!wgGracza.has(k)) wgGracza.set(k, []);
    wgGracza.get(k).push(t);
  }
  const chronione = new Set();
  for (const lista of wgGracza.values()) for (const t of lista.slice(-MIN_NA_GRACZA)) chronione.add(t);
  // Budzet resztowy dostaja NAJSWIEZSZE trejdy spoza puli chronionej.
  const reszta = trejdy.filter((t) => !chronione.has(t));
  const miejsca = Math.max(0, MAX_LACZNIE - chronione.size);
  const dodatkowe = new Set(reszta.slice(-miejsca));
  trejdy = trejdy.filter((t) => chronione.has(t) || dodatkowe.has(t));
}

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
