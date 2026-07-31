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

// ── skladanie zlecen (tylko tryb zywy) ──────────────────────────────────────
//
// Hyperliquid nie ma zlecen "po cenie rynkowej". Zamiast tego sklada sie
// zlecenie z limitem przestrzelonym w strone wykonania i znacznikiem IOC
// (wykonaj natychmiast, reszte anuluj). Efekt jest taki sam jak rynkowego,
// ale MY ustawiamy, jak daleko wolno zjechac — i to jest nasz bezpiecznik
// przed wejsciem w pusta ksiege.
const POSLIZG_MAX = num('REALNY_POSLIZG_MAX', 0.01);   // 1% — dalej nie wchodzimy

/**
 * Zaokraglanie pod reguly Hyperliquid. Zle zaokraglona liczba nie powoduje
 * zlego trejdu — powoduje ODRZUCENIE zlecenia, wiec cichy brak pomiaru.
 * Ceny: najwyzej 5 cyfr znaczacych i najwyzej (6 - szDecimals) miejsc po przecinku.
 * Wielkosci: dokladnie szDecimals miejsc.
 */
function cenaHL(px, szDecimals) {
  const maxMiejsc = 6 - szDecimals;
  const zZnaczacych = Number(px.toPrecision(5));
  return Number(zZnaczacych.toFixed(Math.max(0, maxMiejsc)));
}
const wielkoscHL = (sz, szDecimals) => Number(sz.toFixed(szDecimals));

/**
 * Poslizg liczony jako KOSZT, ze znakiem zaleznym od kierunku.
 *
 * Sama roznica cen nic nie mowi, bo raz jest dla nas dobra, a raz zla:
 *   kupujemy — wyzsza cena wypelnienia niz widziana to STRATA
 *   sprzedajemy — wyzsza cena wypelnienia to ZYSK
 * Liczenie tego przez wartosc bezwzgledna (tak bylo w pierwszej wersji)
 * wpisywaloby korzystne poslizgi do kosztow i systematycznie je zawyzalo.
 * Dodatni wynik = zaplacilismy wiecej, niz widzielismy. Ujemny = zarobilismy.
 */
const poslizgKosztu = (widziana, fill, kupujemy) =>
  ((fill - widziana) / widziana) * (kupujemy ? 1 : -1);

let gielda = null;
if (!P.SUCHY) {
  const { ExchangeClient, InfoClient, HttpTransport } = await import('@nktkas/hyperliquid');
  const { privateKeyToAccount } = await import('viem/accounts');
  const klucz = P.AGENT_KEY.startsWith('0x') ? P.AGENT_KEY : `0x${P.AGENT_KEY}`;
  const transport = new HttpTransport();
  gielda = {
    ex: new ExchangeClient({ transport, wallet: privateKeyToAccount(klucz) }),
    info: new InfoClient({ transport }),
  };

}

/**
 * Sprawdzenie konta przed zlozeniem czegokolwiek. Wolane DOPIERO po wczytaniu
 * stanu, bo porownuje pozycje na gieldzie z tym, co bot o sobie wie.
 *
 * Pytamy o ADRES GLOWNY, nie o agenta: agent tylko podpisuje i sam nie ma salda.
 */
async function sprawdzKonto(stan) {
  try {
    // Hyperliquid ma dwa tryby konta i to zmienia, GDZIE leza pieniadze:
    //   - klasyczny: saldo perpow siedzi w clearinghouseState
    //   - zunifikowany: perpy i spot maja jedno wspolne saldo, a zrodlem prawdy
    //     staje sie spotClearinghouseState; stan perpow przestaje byc miarodajny
    // Pytanie tylko o perpy pokazywaloby przy koncie zunifikowanym $0.00 mimo
    // pelnego portfela — i bot odmawialby handlu bez powodu. Dlatego czytamy oba.
    const [perp, spot, oplaty] = await Promise.all([
      gielda.info.clearinghouseState({ user: P.KONTO }).catch(() => null),
      gielda.info.spotClearinghouseState({ user: P.KONTO }).catch(() => null),
      gielda.info.userFees({ user: P.KONTO }).catch(() => null),
    ]);

    // FAKTYCZNA stawka tego konta, a nie nasza stala. To nie jest kosmetyka:
    // Hyperliquid prowadzi promocje (m.in. przez MetaMaska), w ktorych taker
    // bywa wyzerowany. Gdybysmy liczyli po stalych 0,045%, zmierzylibysmy koszt
    // promocyjny i wyciagneli wniosek, ze handel jest tanszy, niz jest naprawde.
    // Pole `trial` mowi, czy taka promocja trwa i do kiedy.
    if (oplaty?.userCrossRate != null) {
      const realna = Number(oplaty.userCrossRate);
      if (realna !== P.TAKER) {
        log(`> stawka taker tego konta: ${(realna * 100).toFixed(4)}% (zakladalismy ${(P.TAKER * 100).toFixed(4)}%) — biore prawdziwa`);
        P.TAKER = realna;
      }
      if (oplaty.trial) {
        const doKiedy = oplaty.trial.endTime ?? oplaty.trial.expiry ?? oplaty.nextTrialAvailableTimestamp;
        log(`  UWAGA: na koncie trwa PROMOCJA na oplaty${doKiedy ? ` do ${new Date(Number(doKiedy)).toISOString().slice(0, 16)}` : ''}.`);
        log('  Zmierzony koszt bedzie zanizony wzgledem normalnych warunkow — trzeba to');
        log('  odnotowac przy wnioskach, zeby nie przenosic go na symulacje.');
      }
      if (Number(oplaty.activeReferralDiscount) > 0) {
        log(`  (aktywna znizka polecajaca ${(Number(oplaty.activeReferralDiscount) * 100).toFixed(1)}% — te sama uwaga)`);
      }
    }
    const perpWartosc = Number(perp?.marginSummary?.accountValue ?? 0);
    const perpWolne = Number(perp?.withdrawable ?? 0);
    const spotUsd = (spot?.balances ?? [])
      .filter((b) => /^(USDC|USDT|USD)$/i.test(b.coin))
      .reduce((s, b) => s + Number(b.total ?? 0), 0);

    const zunifikowane = spotUsd > 0 && perpWartosc === 0;
    const calosc = Math.max(perpWartosc, spotUsd);
    const wolne = zunifikowane ? spotUsd : perpWolne;

    log(`> konto ${P.KONTO.slice(0, 6)}...${P.KONTO.slice(-4)}: perpy ${usd(perpWartosc)}, spot ${usd(spotUsd)}`
      + `${zunifikowane ? '  (konto zunifikowane — licze ze spotu)' : ''}`);
    if (calosc <= 0) {
      console.error('! Na koncie nie ma srodkow — ani na perpach, ani na spocie.');
      console.error('  Wplac USDC przez most na app.hyperliquid.xyz i sprobuj ponownie.');
      process.exit(1);
    }
    if (calosc < P.START * 0.9) {
      log(`  UWAGA: na koncie mniej niz zakladany start (${usd(P.START)}). Licze pozycje od tego, co jest.`);
      P.START = calosc;
    }
    // Pozycje otwarte na gieldzie, o ktorych nasz stan nie wie, znaczylyby, ze
    // handluje tu cos jeszcze. Lepiej stanac, niz nakladac sie na cudze zlecenia.
    const naGieldzie = (perp?.assetPositions ?? []).filter((x) => Number(x?.position?.szi ?? 0) !== 0);
    if (naGieldzie.length && !Object.keys(stan.pozycje).length) {
      console.error(`! Na gieldzie wisi ${naGieldzie.length} pozycji, o ktorych bot nie wie: ${naGieldzie.map((x) => x.position.coin).join(', ')}`);
      console.error('  Zamknij je recznie albo usun state/realny-state.json, zeby bot zaczal od zera.');
      process.exit(1);
    }
  } catch (e) {
    console.error(`! Nie moge odczytac konta (${e.message}). Sprawdz REALNY_KONTO — ma byc adresem 0x... twojego MetaMaska.`);
    process.exit(1);
  }
}

/**
 * Zlecenie IOC. Zwraca cene, po ktorej NAPRAWDE weszlismy, albo null.
 * Roznica miedzy `widziana` a zwrocona wartoscia to caly sens tego bota.
 */
async function zlec({ idx, szDecimals, kupno, wielkosc, widziana, redukuje }) {
  const limit = cenaHL(widziana * (kupno ? 1 + POSLIZG_MAX : 1 - POSLIZG_MAX), szDecimals);
  const sz = wielkoscHL(wielkosc, szDecimals);
  if (sz <= 0) { log(`    zlecenie odrzucone lokalnie: wielkosc ${sz} po zaokragleniu`); return null; }
  try {
    const r = await gielda.ex.order({
      orders: [{ a: idx, b: kupno, p: String(limit), s: String(sz), r: !!redukuje, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    });
    const st = r?.response?.data?.statuses?.[0];
    if (st?.filled) return { fill: Number(st.filled.avgPx), ile: Number(st.filled.totalSz) };
    if (st?.resting) { log('    zlecenie nie weszlo od reki (resting) — anuluje pomiar tego trejdu'); return null; }
    log(`    gielda odmowila: ${JSON.stringify(st ?? r)}`);
    return null;
  } catch (e) {
    log(`    blad skladania zlecenia: ${e.message}`);
    return null;
  }
}

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

// ── przelaczenie trybu ──────────────────────────────────────────────────────
//
// Pozycje z trybu suchego sa ZMYSLONE — na gieldzie ich nie ma. Gdyby bot
// wszedl na zywo z takim stanem, probowalby je zamykac zleceniem reduceOnly,
// gielda odmawialaby (nie ma czego redukowac), a bot utknalby w petli i nigdy
// nie zrobil zadnego prawdziwego trejdu. Dlatego przy przejsciu na zywo
// zaczynamy z czysta kartka.
//
// W druga strone (zywy -> suchy) NIE czyscimy nic automatycznie: jesli na
// gieldzie wisza prawdziwe pozycje, wyzerowanie stanu sprawiloby, ze bot o nich
// zapomni, a one zostana otwarte bez nadzoru. Wtedy wolimy sie zatrzymac.
if (stan.suchy !== P.SUCHY) {
  if (P.SUCHY) {
    if (Object.keys(stan.pozycje).length) {
      console.error('! Przelaczasz z ZYWEGO na SUCHY, ale sa otwarte pozycje na gieldzie.');
      console.error('  Zamknij je recznie na app.hyperliquid.xyz albo wroc na REALNY_SUCHY=0.');
      console.error('  Nie ruszam stanu — nie chce, zeby bot zapomnial o prawdziwych pozycjach.');
      process.exit(1);
    }
    log('> przelaczam na tryb SUCHY, zaczynam pomiar od nowa');
  } else {
    log(`> PRZELACZAM NA TRYB ZYWY — zeruje stan (${Object.keys(stan.pozycje).length} zmyslonych pozycji z trybu suchego)`);
  }
  trejdy.push({ ts: nowISO(), typ: 'RESET', powod: `zmiana trybu: ${stan.suchy ? 'suchy' : 'zywy'} -> ${P.SUCHY ? 'suchy' : 'zywy'}` });
  stan.cash = P.START;
  stan.pozycje = {};
  stan.zamkniete = 0;
  stan.koniec = null;
  stan.utworzony = nowISO();
}
// Ustawienia zapisujemy przy KAZDYM przebiegu, a nie tylko przy tworzeniu stanu.
// Inaczej podniesienie limitu trejdow w .env nie byloby widoczne w pliku stanu
// i apka pokazywalaby stara wartosc.
stan.ustawienia = { lewar: P.LEWAR, miejsc: P.MIEJSC, alloc: P.ALLOC, maxTrejdow: P.MAX_TREJDOW };

if (!P.SUCHY) await sprawdzKonto(stan);

const gracze = stworzGraczy();
const def = gracze[P.GRACZ];
if (!def) { console.error(`Nie znam gracza "${P.GRACZ}". Dostepni: ${Object.keys(gracze).join(', ')}`); process.exit(1); }

log(`=== HAJSOMAT REALNY ${nowISO()} | ${P.SUCHY ? 'SUCHY (nic nie kosztuje)' : '*** ZA PRAWDZIWE PIENIADZE ***'} ===`);
log(`> gracz ${def.nazwa}, dzwignia ${P.LEWAR}x, ${P.MIEJSC} miejsca po ${(P.ALLOC * 100).toFixed(0)}%, limit ${P.MAX_TREJDOW} trejdow`);

if (stan.koniec) { log(`> eksperyment ZAKONCZONY (${stan.koniec}) — nic nie robie`); process.exit(0); }

// ── ceny i metryki ──────────────────────────────────────────────────────────
// Indeks rynku i liczba miejsc po przecinku — bez nich zlecenie zostanie
// odrzucone. Bierzemy je z gieldy przy kazdym przebiegu, a nie z tablicy w
// kodzie, bo lista rynkow Hyperliquid sie zmienia i zaszyta na sztywno
// wskazywalaby kiedys na zupelnie inne aktywo.
const meta = await poi({ type: 'meta' });
const rynek = new Map(meta.universe.map((u, i) => [u.name.toUpperCase(), { idx: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage }]));

const rynki = {};
for (const [sym, nazwa] of Object.entries(AKTYWA)) {
  try {
    const info = rynek.get(nazwa.toUpperCase());
    if (!info) { log(`  ${sym}: Hyperliquid nie ma juz rynku ${nazwa} — pomijam`); continue; }
    if (info.maxLeverage < P.LEWAR) { log(`  ${sym}: maks. dzwignia ${info.maxLeverage}x < nasze ${P.LEWAR}x — pomijam`); continue; }
    const c = await swiece(nazwa);
    if (c.length < 230) { log(`  ${sym}: tylko ${c.length} swiec, pomijam`); continue; }
    const D = przygotujAktywo(c);
    const i = D.n - 1;
    const m = D.metryka(i);
    if (m) rynki[sym] = { D, i, m, nazwa, cena: D.closes[i], ...info };
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

  // W trybie suchym udajemy wypelnienie po cenie widzianej. Na zywo idzie
  // prawdziwe zlecenie, a `fill` to cena, ktora naprawde dostalismy — roznica
  // miedzy `widziana` a `fill` jest calym sensem tego eksperymentu.
  const widziana = px;
  let fill = widziana;
  if (!P.SUCHY) {
    const w = await zlec({
      idx: r.idx, szDecimals: r.szDecimals,
      kupno: p.side !== 'LONG',        // zamkniecie longa to sprzedaz, i odwrotnie
      wielkosc: p.sz, widziana, redukuje: true,
    });
    // Nieudanego zamkniecia NIE udajemy: pozycja zostaje otwarta i sprobujemy
    // za piec minut. Zapisanie jej jako zamknietej rozjechaloby nam stan z gielda.
    if (!w) { log(`  ${sym}: nie udalo sie zamknac — probuje w nastepnym przebiegu`); continue; }
    fill = w.fill;
  }

  const brutto = (p.side === 'LONG' ? fill / p.entryPrice - 1 : 1 - fill / p.entryPrice) * p.notional;
  const oplata = p.notional * P.TAKER;
  const netto = brutto - oplata;
  stan.cash += p.margin + netto;
  stan.zamkniete += 1;

  trejdy.push({
    ts: nowISO(), sym, side: p.side, typ: 'CLOSE', powod,
    entryPrice: p.entryPrice, cenaWidziana: widziana, cenaWypelnienia: fill,
    // zamkniecie longa to sprzedaz, zamkniecie shorta to kupno
    poslizg: poslizgKosztu(widziana, fill, p.side !== 'LONG'),
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

    const long = syg.kier === 'LONG';
    const widziana = r.cena;
    const sz = notional / widziana;          // wielkosc w sztukach aktywa
    let fill = widziana, ileSztuk = sz;

    if (!P.SUCHY) {
      // Dzwignia jest ustawieniem KONTA na danym rynku, nie parametrem zlecenia.
      // Ustawiamy ja przed kazdym wejsciem — to idempotentne i tanie, a chroni
      // przed sytuacja, w ktorej Hyperliquid ma domyslnie inna niz nasze 3x
      // i cala pozycja wychodzi w zupelnie innej skali.
      try { await gielda.ex.updateLeverage({ asset: r.idx, isCross: true, leverage: P.LEWAR }); }
      catch (e) { log(`  ${sym}: nie ustawilem dzwigni (${e.message}) — pomijam wejscie`); continue; }

      const w = await zlec({ idx: r.idx, szDecimals: r.szDecimals, kupno: long, wielkosc: sz, widziana, redukuje: false });
      if (!w) continue;
      fill = w.fill; ileSztuk = w.ile;
    }

    const stopA = def.stopAtr ?? CFG.STOP_ATR;
    stan.cash -= margin + notional * P.TAKER;
    stan.pozycje[sym] = {
      sym, side: syg.kier, entryPrice: fill, entryTs: nowISO(),
      margin, notional, leverage: P.LEWAR,
      sz: ileSztuk,          // ile sztuk trzymamy — potrzebne, zeby zamknac dokladnie tyle
      stopPrice: long ? fill - stopA * r.m.atr : fill + stopA * r.m.atr,
      takeProfit: long ? fill + CFG.TAKE_PROFIT_ATR * r.m.atr : fill - CFG.TAKE_PROFIT_ATR * r.m.atr,
      atrAtEntry: r.m.atr, bestPrice: fill, trailArmed: false,
      trailAtr: def.trailAtr ?? CFG.TRAIL_ATR, bezSmyczy: !!def.bezSmyczy,
      minGodzin: def.minGodzin ?? 0, stopZawsze: !!def.stopZawsze,
    };
    trejdy.push({
      ts: nowISO(), sym, side: syg.kier, typ: 'OPEN', powod: syg.powod,
      cenaWidziana: widziana, cenaWypelnienia: fill, poslizg: poslizgKosztu(widziana, fill, long),
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
// Liczymy WYLACZNIE trejdy po ostatnim przelaczeniu na tryb zywy. Te sprzed
// niego pochodza z trybu suchego, gdzie poslizg jest zerowy z definicji —
// wciagniecie ich do mediany rozcienczyloby jedyna liczbe, po ktora tu jestesmy.
const odKtorego = trejdy.map((t) => t.typ).lastIndexOf('RESET') + 1;
const zPoslizgiem = trejdy.slice(odKtorego).filter((t) => t.poslizg != null && t.cenaWypelnienia != null);
if (!P.SUCHY && zPoslizgiem.length) {
  // BEZ wartosci bezwzglednej: poslizg bywa dla nas korzystny i wtedy ma
  // koszt obnizac, a nie podnosic. Mediana ze znakiem jest uczciwa miara.
  const p = zPoslizgiem.map((t) => t.poslizg).sort((a, b) => a - b);
  const med = p[p.length >> 1];
  const korzystnych = p.filter((x) => x < 0).length;
  const pelny = med * 2 + P.TAKER * 2;
  log(`> POSLIZG z ${zPoslizgiem.length} ${zPoslizgiem.length === 1 ? 'zlecenia' : 'zlecen'} na zywo: mediana ${(med * 100).toFixed(3)}% na strone`
    + ` (${korzystnych} z ${p.length} wyszlo na nasza korzysc)`);
  log(`  Pelny koszt rundy: ${(pelny * 100).toFixed(3)}% (poslizg ${(med * 2 * 100).toFixed(3)}% + oplaty ${(P.TAKER * 2 * 100).toFixed(3)}%)`);
  log(`  Liga zaklada 0,120%. ${zPoslizgiem.length < 6 ? 'Za malo zlecen na wnioski — to na razie ciekawostka.'
    : pelny > 0.0015 ? 'ZANIZAMY koszt w symulacjach.' : 'Zalozenie sie broni.'}`);
} else if (P.SUCHY) {
  log('> tryb suchy: poslizg zawsze zerowy, bo udajemy wypelnienie po cenie widzianej.');
  log('  Prawdziwy pomiar zacznie sie dopiero po REALNY_SUCHY=0 i podlaczeniu klucza.');
}
