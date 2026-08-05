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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CFG, ema, rsi, atr, efficiencyRatio, warunki } from './strategy.mjs';
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
  // 0 = bez limitu. Limit mial sens przy pomiarze kosztu, gdzie chodzilo
  // o dwadziescia rund i koniec. Przy stadzie botow, ktore maja po prostu
  // grac, limit tylko by je uciszal w przypadkowym momencie.
  MAX_TREJDOW: num('REALNY_MAX_TREJDOW', 0),
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

// Prefiks pozwala uruchomic ten sam plik dla KILKU botow naraz, kazdy na
// wlasnym koncie Hyperliquid i z wlasnym stanem — tak samo jak liga.mjs
// obsluguje Lige A i B. Bez tego trzeba by kopiowac cala logike handlu, a
// dwie kopie po miesiacu zawsze sie rozjezdzaja.
//
// Osobne konta, a nie subkonta, bo subkonta na Hyperliquid wymagaja 100 tys.
// dolarow obrotu. Trzy zwykle portfele daja to samo rozdzielenie pozycji.
const PREFIKS = env('REALNY_PREFIKS', 'realny');
const F_STAN = path.join(KAT, `${PREFIKS}-state.json`);
const F_TREJDY = path.join(KAT, `${PREFIKS}-trades.json`);
const F_EQUITY = path.join(KAT, `${PREFIKS}-equity.json`);
// Archiwum starych trejdow. Do werdyktu o zyskownosci trzeba okolo 714 rund;
// przy tempie Smyczy (13 rund na dobe) to blisko dwa miesiace, czyli ~1400
// wpisow. Ucinanie dziennika do 500 zabieraloby probke DOKLADNIE wtedy, gdy
// zaczyna cos znaczyc — i robiloby to po cichu. Ogon idzie wiec do pliku
// dopisywanego jednym `append`: git dokleja przyrost zamiast przepisywac calosc,
// a apka pobiera tylko goracy plik.
const F_ARCHIWUM = path.join(KAT, `${PREFIKS}-archiwum.jsonl`);
/**
 * DZIENNIK ROZBIEZNOSCI ZYWE <-> SYMULATOR.
 *
 * Kryterium zywego testu ("R dodatnie i wyzsze niz Sito 5 na >= 40 trejdach")
 * rozstrzyga tylko "dziala / nie dziala". Nie odroznia dwoch zupelnie roznych
 * porazek: SYGNAL byl zly, czy EGZEKUCJA go zjadla. Przy polokresie przewagi
 * 25 minut i koszcie rundy 10,2 bps to jest caly wniosek, a nie szczegol.
 *
 * Jeden wiersz na wejscie, z trzema rzeczami, ktorych dotad nigdzie nie bylo:
 *
 *   OPOZNIENIA — swieca decyzji -> decyzja -> zlecenie -> wypelnienie.
 *     Krzywa rozpadu przewagi (Aneks 15) mowi: po 15 minutach zostaje 79%,
 *     po 30 juz 44%. Prog alarmu bierze sie stad, a nie z gustu.
 *
 *   POSLIZG W ATR — dolary nie sa porownywalne miedzy BTC a BONK, a ATR tak.
 *     To ta sama jednostka, w ktorej laboratorium liczy stop i cel, wiec
 *     dopiero tutaj widac, jaka CZESC przewagi zjada wejscie.
 *
 *   SWIECA ZAMKNIETA CZY NIE — i to jest rozbieznosc STRUKTURALNA, ktorej
 *     nikt dotad nie zapisal. Symulator decyduje na swiecy ZAMKNIETEJ i wchodzi
 *     po jej zamknieciu. Bot zywy pobiera swiece z `endTime: Date.now()`, wiec
 *     ostatnia jest jeszcze W TRAKCIE — decyduje na cenie, ktora moze sie
 *     jeszcze cofnac przed zamknieciem. To nie jest to samo wejscie.
 */
const F_ROZBIEZNOSCI = path.join(KAT, `${PREFIKS}-rozbieznosci.json`);
const SWIECA_MS = 15 * 60000;
// Prog alarmu: polowa swiecy. Po 15 minutach od sygnalu zostaje 79% przewagi,
// a bot chodzi co 5 minut — wiec wszystko powyzej 450 s znaczy, ze cos poza
// harmonogramem zabiera czas, i chcemy o tym wiedziec przy pierwszym razie.
const PROG_OPOZNIENIA_S = 450;
const nowISO = () => new Date().toISOString();
const usd = (x) => `$${Number(x).toFixed(2)}`;
const log = (...a) => console.log(...a);

// PRAWDA O POZYCJACH JEST NA GIELDZIE, a nie w naszym pliku stanu. Wypelnia to
// sprawdzKonto przy kazdym ZYWYM przebiegu; w trybie suchym zostaje `null`, bo
// tam pozycje sa zmyslone i gielda z zalozenia o nich nie wie.
//
// `null` znaczy "nie wiemy" i nie wolno go mylic z "gielda nic nie trzyma" —
// dlatego kazde uzycie zaczyna sie od sprawdzenia, czy w ogole mamy odczyt.
let pozycjeGieldy = null;

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
  return (j || []).map((k) => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v })).sort((a, b) => a.t - b.t);
}

const czytaj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
// Zapis przez plik tymczasowy i podmiane nazwy. Bez tego przerwanie procesu
// w trakcie writeFileSync zostawia PLIK STANU URWANY W POLOWIE — a stad juz
// tylko krok do bota, ktory przy nastepnym przebiegu nie wie o swoich
// prawdziwych pozycjach. `renameSync` w obrebie jednego katalogu jest
// niepodzielne: albo jest stary plik, albo caly nowy, nigdy polowa.
const pisz = (f, x) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(x, null, 2));
  fs.renameSync(tmp, f);
};

/**
 * Zaokraglenie do szesciu cyfr znaczacych.
 *
 * `rsi: 53.431936661493566` to trzydziesci jeden bajtow na liczbe, ktora ma sens
 * do piatej cyfry — a kazdy taki bajt rosnie w historii gita na zawsze. Szesc
 * cyfr znaczacych, a nie miejsc po przecinku, bo ten sam zapis obsluguje cene
 * SOL (73,2870) i cene BONKa (0,00000291400).
 *
 * NIE UZYWAC DO KSIEGOWOSCI. Tu sluzy wylacznie do ZAPISU do dziennika; kapital,
 * gotowka i marze licza sie dalej z pelna precyzja.
 */
const sig = (x, n = 6) => (Number.isFinite(x) ? +Number(x).toPrecision(n) : (x ?? null));

/**
 * Zapis listy po JEDNYM WPISIE NA LINIE.
 *
 * `JSON.stringify(x, null, 2)` rozbija kazdy wpis na kilkanascie linii, przez co
 * git widzi zmiane jednej liczby jako zmiane calego bloku. Jeden wpis w jednej
 * linii sprawia, ze przyrost w commicie to dopisane wiersze, a nie przepisany
 * plik — przy commicie co piec minut to jest roznica rzedu wielkosci.
 * Wynik jest nadal poprawnym JSON-em, wiec apka nic nie zauwazy.
 */
const piszWiersze = (f, lista) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, `[\n${lista.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`);
  fs.renameSync(tmp, f);
};

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

/**
 * Wszystko, co pozycja wie o SWOIM WEJSCIU, przeniesione na wiersz zamkniecia.
 *
 * Dzis te dane gina razem z pozycja przy `delete stan.pozycje[sym]`. Skutek jest
 * taki, ze warunki wejscia leza na wpisie OPEN, wynik na wpisie CLOSE — i nie ma
 * niczego, co by je laczylo. Czyli nie da sie zadac ANI JEDNEGO pytania, po ktore
 * ten dziennik powstaje: czy przegrane trejdy wchodzily przy innym RSI niz
 * wygrane, czy stop byl ustawiany za blisko, czy smycz w ogole zdazyla sie uzbroic.
 *
 * Nazwy pol sa CELOWO takie same jak w lidze (`warunki`, `powodWejscia`).
 * App.js juz tlumaczy wpisy tego bota na ksztalt ligi i czeka dokladnie na te
 * nazwy — dzieki temu karta "Co dzialalo" zapala sie dla botow na prawdziwych
 * pieniadzach bez zmiany jednej linijki w apce.
 */
const dziennikWejscia = (p) => ({
  kod: p.kod ?? null,
  powodWejscia: p.powodWejscia ?? null,
  warunki: p.warunkiWejscia ?? null,
  kontrakt: {
    // ATR z chwili wejscia — jedyna liczba z metryki, ktorej NIE da sie potem
    // odtworzyc ze swiec. Liczy sie z gorki i dolka swiecy, ktora w chwili
    // decyzji byla dopiero w polowie formowania. A ATR jest mianownikiem stopa,
    // celu i kazdego porownania BONKa z BTC — blad tutaj przesuwa je wszystkie naraz.
    atr: sig(p.atrAtEntry),
    // Mnozniki, nie ceny. Ceny wyliczy arytmetyka (fill +- stopAtr * atr), a te
    // liczby dodatkowo pokazuja, ze ktos przestroil ustawienia w polowie eksperymentu.
    stopAtr: p.stopAtr ?? null,
    celAtr: p.celAtr ?? null,
    smyczAtr: p.bezSmyczy ? null : (p.trailAtr ?? null),
    score: p.score ?? null,
  },
  przebieg: {
    // Najlepsza cena, jaka bot ZOBACZYL — liczona i tak na potrzeby smyczy,
    // nigdy niezapisywana. Prawdziwy szczyt policzymy pozniej z knotow swiec
    // i bedzie dokladniejszy; ta liczba jest tu po to, zeby te dwie dalo sie od
    // siebie odjac. Roznica miedzy nimi to ślepa plama bota miedzy przebiegami.
    szczyt: sig(p.bestPrice),
    // Czy smycz zdazyla sie uzbroic. Tego nie odtworzy nic, bo zalezy od tego,
    // w ktorych momentach bot akurat patrzyl. U Smyczy, ktorego caly sens to
    // trailing, bez tego nie da sie policzyc, ile zamkniec w ogole go uzylo.
    smycz: !!p.trailArmed,
  },
  ...(p.czesciowe ? { czesciowe: sig(p.czesciowe, 3) } : {}),
});

let gielda = null;
if (!P.SUCHY) {
  const { ExchangeClient, InfoClient, HttpTransport } = await import('@nktkas/hyperliquid');
  const { privateKeyToAccount } = await import('viem/accounts');
  const klucz = P.AGENT_KEY.startsWith('0x') ? P.AGENT_KEY : `0x${P.AGENT_KEY}`;
  const transport = new HttpTransport();

  // Wczytanie klucza MUSI byc w bezpieczniku, i to nie dla porzadku.
  //
  // Gdy klucz jest zly (literowka, spacja, ucięty znak), viem rzuca wyjatkiem,
  // a jego komunikaty walidacji potrafia zawierac wartosc, ktora nie przeszla.
  // Bez tego opakowania taki wyjatek poleci prosto do logs/hajsomat.log —
  // czyli KLUCZ PRYWATNY wyladowalby w pliku tekstowym na dysku serwera.
  //
  // Dlatego lapiemy wszystko i wypisujemy WYLACZNIE dlugosc i pierwsze znaki.
  let portfel;
  try {
    portfel = privateKeyToAccount(klucz);
  } catch {
    console.error('! Nie moge wczytac klucza agenta. Sprawdz REALNY_AGENT_KEY w deploy/.env.');
    console.error(`  Powinien miec 66 znakow z prefiksem 0x; ten ma ${klucz.length} i zaczyna sie od "${klucz.slice(0, 4)}".`);
    console.error('  Tresci bledu nie wypisuje celowo — moglaby zawierac sam klucz.');
    process.exit(1);
  }

  gielda = {
    ex: new ExchangeClient({ transport, wallet: portfel }),
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
    // Na PIERWSZYM przebiegu bierzemy start wprost z konta, zamiast wierzyc
    // liczbie wpisanej recznie w .env. Kazdy portfel ma troche inna kwote (35,
    // 36, 37...), a rozjazd miedzy zapisanym startem a rzeczywistym saldem
    // psulby wszystkie procenty i wykres kapitalu — przy czym cicho, bo nic
    // by nie protestowalo.
    // "Pierwszy" to albo swiezy stan, albo taki, ktory przejal dziennik po
    // starym bocie i czeka na ustawienie kapitalu z prawdziwego konta.
    const pierwszy = stan.doSynchronizacji
      || (!stan.zamkniete && !Object.keys(stan.pozycje || {}).length);
    if (pierwszy && calosc > 0 && Math.abs(calosc - P.START) > 0.01) {
      log(`  start ustawiam z konta: ${usd(calosc)} (w .env bylo ${usd(P.START)})`);
      P.START = calosc;
      stan.start = calosc;            // to jest jedyny moment, w ktorym start wolno zmienic
      stan.startZrodlo = 'konto';     // potwierdzone saldem — zaden pozniejszy mechanizm tego nie rusza
      stan.cash = calosc;
      stan.szczyt = calosc;
      delete stan.doSynchronizacji;   // jednorazowo — potem kapitalem rzadzi juz handel
    } else {
      // SAMONAPRAWA rozjazdu z rzeczywistoscia.
      //
      // Wewnetrzna ksiegowosc bota moze odplynac od prawdy na kilka sposobow:
      // dolozysz srodkow, wyplacisz, zagrasz czyms recznie, albo — jak tutaj —
      // bot przejmie saldo po innym koncie. Kazdy z nich sprawia, ze pozycje sa
      // liczone od kwoty, ktorej nie ma, i to CICHO.
      //
      // Poprawiamy tylko, gdy bot jest PLASKI (zero otwartych pozycji). Przy
      // otwartych porownanie nie ma sensu: wartosc konta zawiera wtedy
      // niezrealizowany wynik i zablokowana marze, wiec roznica nie musi
      // oznaczac zadnego bledu.
      const trzyma = Object.keys(stan.pozycje || {}).length;
      const moje = stan.cash + Object.values(stan.pozycje || {}).reduce((s, p) => s + p.margin, 0);
      const rozjazd = moje > 0 ? Math.abs(calosc - moje) / moje : 0;
      if (!trzyma && rozjazd > 0.1) {
        log(`  ROZJAZD: bot liczy ${usd(moje)}, a na koncie jest ${usd(calosc)} (${(rozjazd * 100).toFixed(0)}%) — ustawiam wedlug konta`);
        stan.cash = calosc;
        stan.szczyt = Math.max(stan.szczyt ?? 0, calosc);
        // Start tez, inaczej procenty liczylyby sie od kwoty, ktorej bot nigdy
        // nie mial — a to jest dokladnie ten blad, ktory naprawiamy.
        P.START = calosc;
        stan.start = calosc;
        stan.startZrodlo = 'konto';   // jak wyzej — saldo bije kazde inne zrodlo
      } else if (rozjazd > 0.1) {
        log(`  uwaga: bot liczy ${usd(moje)}, konto ma ${usd(calosc)} — wyrownam, gdy zamknie ${trzyma} ${trzyma === 1 ? 'pozycje' : 'pozycji'}`);
      }
    }
    // Pozycje otwarte na gieldzie, o ktorych nasz stan nie wie, znaczylyby, ze
    // handluje tu cos jeszcze. Lepiej stanac, niz nakladac sie na cudze zlecenia.
    const naGieldzie = (perp?.assetPositions ?? []).filter((x) => Number(x?.position?.szi ?? 0) !== 0);

    // Zapamietujemy, co gielda NAPRAWDE trzyma — petla wyjsc porowna to ze swoim
    // stanem. Nie kosztuje ani jednego dodatkowego zapytania: odczyt konta i tak
    // juz mamy. Klucze to nazwy Hyperliquid (kBONK, a nie BONK) — tlumaczy je AKTYWA.
    pozycjeGieldy = Object.fromEntries(
      naGieldzie.map((x) => [String(x.position.coin).toUpperCase(), Math.abs(Number(x.position.szi))]),
    );

    if (naGieldzie.length && !Object.keys(stan.pozycje).length) {
      console.error(`! Na gieldzie wisi ${naGieldzie.length} pozycji, o ktorych bot nie wie: ${naGieldzie.map((x) => x.position.coin).join(', ')}`);
      // Komunikat MUSI nazywac plik TEGO bota, a nie 'realny-state.json'.
      // Sito 5 stalo 26 godzin z ta wiadomoscia, ktora wskazywala plik nalezacy
      // do zupelnie innego, dawno zakonczonego eksperymentu — czyli podpowiadala
      // operacje bez zadnego skutku dla bota, ktory sie zatrzymal.
      console.error(`  Zamknij je recznie albo usun ${path.relative(process.cwd(), F_STAN)}, zeby bot zaczal od zera.`);
      console.error('  UWAGA: pozycja na gieldzie NIE MA OCHRONY, dopoki bot nie chodzi —');
      console.error('  stop i take profit sa u nas wirtualne i pilnuje ich petla wyjsc tego bota.');
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

// ── przejecie historii sprzed podzialu na stado ──────────────────────────────
//
// Do 01.08.2026 chodzil JEDEN bot realny (Smycz) i pisal do `realny-*.json`.
// Gdy rozdzielamy sie na kilka botow, kazdy dostaje wlasny prefiks — ale te
// 20 prawdziwych trejdow to najcenniejsze dane, jakie mamy, i szkoda ich
// zaczynac od zera. Jesli nowy plik jeszcze nie istnieje, a stary jest i nalezy
// do TEGO SAMEGO gracza, przejmujemy go razem z krzywa kapitalu i dziennikiem.
//
// Warunek "ten sam gracz" jest istotny: bez niego Sito 5 odziedziczyloby
// historie Smyczy i mielibysmy w statystykach cudze trejdy.
if (PREFIKS !== 'realny' && !fs.existsSync(F_STAN)) {
  const stary = czytaj(path.join(KAT, 'realny-state.json'), null);
  if (stary && stary.gracz === P.GRACZ) {
    // Przejmujemy DZIENNIK TREJDOW, ale NIE kapital.
    //
    // Stary eksperyment chodzil na innym portfelu i skonczyl z 25,59 USD
    // (zaczynal od 25,00 — te dwie liczby latwo pomylic, a to nie to samo).
    // Nowy bot stada ma wlasne konto z inna kwota. Przeniesienie salda
    // sprawiloby, ze bot liczylby pozycje od liczby, ktorej na koncie nie ma,
    // a krzywa kapitalu miala by skok w srodku — i nikt by nie wiedzial, skad.
    //
    // Trejdy zostaja, bo to najcenniejsze dane, jakie mamy. Kapital i krzywa
    // zaczynaja od nowa, od tego, co naprawde jest na koncie.
    log(`> przejmuje dziennik sprzed podzialu (${stary.zamkniete} trejdow gracza ${stary.gracz}), kapital liczę od nowa`);
    pisz(F_STAN, {
      ...stary,
      cash: P.START, kapital: P.START, szczyt: P.START, start: P.START,
      pozycje: {},                 // stare pozycje wisialy na innym koncie
      koniec: null,
      przejeteZ: 'realny', przejeteKiedy: nowISO(),
      // Znacznik dla sprawdzKonto: przy pierwszym zywym przebiegu ustaw start
      // z prawdziwego salda, mimo ze `zamkniete` jest juz niezerowe.
      doSynchronizacji: true,
    });
    const d = czytaj(path.join(KAT, 'realny-trades.json'), null);
    if (d) piszWiersze(F_TREJDY, d);
    // Krzywej kapitalu NIE przenosimy — opisuje inne konto i inne pieniadze.
  }
}

// ── stan ────────────────────────────────────────────────────────────────────
let stan = czytaj(F_STAN, null);
if (!stan) {
  stan = {
    wersja: 1, utworzony: nowISO(), gracz: P.GRACZ, suchy: P.SUCHY,
    cash: P.START, pozycje: {}, zamkniete: 0, koniec: null,
    // Skad wzielismy kwote startowa. 'ustawienia' znaczy "z .env, jeszcze nie
    // potwierdzone kontem" — i tylko taka wolno pozniej poprawiac.
    startZrodlo: 'ustawienia',
    ustawienia: { lewar: P.LEWAR, miejsc: P.MIEJSC, alloc: P.ALLOC, maxTrejdow: P.MAX_TREJDOW },
  };
}
let trejdy = czytaj(F_TREJDY, []);

// ── CZY `start` MOWI PRAWDE? ────────────────────────────────────────────────
//
// `start` znaczy "od ilu ten bot NAPRAWDE zaczal" i od tej jednej liczby liczy
// sie kazdy procent w apce. Da sie ja zepsuc na jeden sposob: wpisac do
// deploy/.env kwote inna niz ta, ktora naprawde lezala na koncie. Tak wlasnie
// bylo — Smycz mial w pliku 37 USD przy prawdziwych 25,00, wiec apka pokazywala
// -31,85% zamiast +0,86%. Bot nie stracil ani centa; klamala podstawa.
//
// ODTWARZAMY START Z KSIAG, a nie z krzywej kapitalu.
//
// Kusi, zeby wziac pierwszy punkt wlasnej krzywej — ale to pulapka. Krzywa
// zaczyna sie wtedy, gdy DOPISALISMY JEJ ZAPISYWANIE, a nie wtedy, gdy bot
// ruszyl. U Smyczy te dwie chwile dzieli czternascie godzin handlu, wiec
// pierwszy punkt jest juz po trzech wejsciach i jednym zamknieciu.
//
// Ksiegi takiej dziury nie maja. Kapital zmienia sie DOKLADNIE na dwa sposoby:
//
//   otwarcie  →  kapital maleje o oplate wejsciowa
//   zamkniecie → kapital rosnie o wynik trejdu (pnlUsd)
//
// Czyli:  start = kapital_teraz − Σ(pnlUsd zamkniec) + Σ(oplat otwarc)
//
// Sprawdzone na obu botach co do szostego miejsca po przecinku: Smycz wychodzi
// 25,0000 rowno, Trend 35,6000 rowno. Zadnych zaokraglen, zadnego szacowania.
//
// Poprawiamy TYLKO wtedy, gdy `start` nie zostal potwierdzony saldem konta.
// Gdy ustawila go synchronizacja (startZrodlo === 'konto'), zostawiamy go
// w spokoju: wplata albo wyplata w trakcie eksperymentu to swiadoma zmiana
// podstawy, a nie blad do naprawienia.
if (stan.start != null && stan.startZrodlo !== 'konto' && Number.isFinite(stan.kapital)) {
  const dziennik = Array.isArray(trejdy) ? trejdy : [];
  // Liczymy od ostatniego RESET-u — tam bot zaczal nowe zycie (np. przejscie
  // z trybu suchego na zywy) i wczesniejsze wpisy opisuja zmyslone pieniadze.
  const odResetu = dziennik.map((t) => t.typ).lastIndexOf('RESET') + 1;
  const po = dziennik.slice(odResetu);
  // Dziennik jest przycinany do 500 wpisow. Gdyby dosiegnal limitu, poczatek
  // historii bylby juz obciety i odtworzenie daloby liczbe z sufitu — wtedy
  // lepiej nie ruszac nic i powiedziec o tym glosno.
  // Pytanie brzmi "czy poczatek historii nie zostal ucięty". Od kiedy nadmiar
  // idzie do archiwum zamiast do kosza, odpowiedz jest prosta: dopoki archiwum
  // nie powstalo, dziennik jest kompletny.
  const kompletny = !fs.existsSync(F_ARCHIWUM);
  const maDane = po.some((t) => t.typ === 'CLOSE') || po.some((t) => t.typ === 'OPEN');
  if (kompletny && maDane) {
    const zysk = po.filter((t) => t.typ === 'CLOSE').reduce((sm, t) => sm + (t.pnlUsd || 0), 0);
    const oplaty = po.filter((t) => t.typ === 'OPEN').reduce((sm, t) => sm + (t.oplata || 0), 0);
    const zKsiag = stan.kapital - zysk + oplaty;
    if (zKsiag > 0 && Math.abs(stan.start - zKsiag) / zKsiag > 0.02) {
      log(`> START BYL ZLY: w pliku ${usd(stan.start)}, a ksiegi mowia ${usd(zKsiag)} — poprawiam`);
      log(`  (kapital ${usd(stan.kapital)} − zysk ${usd(zysk)} + oplaty wejsciowe ${usd(oplaty)})`);
      log('  Od tej kwoty licza sie wszystkie procenty w apce, wiec dotad pokazywala zly wynik.');
      stan.start = +zKsiag.toFixed(4);
      stan.startZrodlo = 'ksiegi';
      stan.startPoprawiony = nowISO();
      P.START = stan.start;
      // Szczyt byl zawyzony ta sama kwota, a od niego liczy sie obsuniecie.
      // Bierzemy najwyzszy punkt, jaki bot NAPRAWDE mial.
      const krzywa = czytaj(F_EQUITY, []);
      const punkty = (Array.isArray(krzywa) ? krzywa : []).map((x) => x.equityUsd).filter(Number.isFinite);
      stan.szczyt = Math.max(stan.start, stan.kapital, ...punkty);
    }
  } else if (!kompletny) {
    log('  uwaga: dziennik siegnal limitu 500 wpisow — nie moge sprawdzic, czy `start` jest prawdziwy');
  }
}

// REALNY_START_USD z .env jest tylko ROZRUCHEM dla bota, ktory nie ma jeszcze
// historii. Gdy stan juz wie, od ilu bot zaczal, to on rzadzi — inaczej kwota
// z ustawien wracalaby tylnymi drzwiami przy kazdym przebiegu.
//
// Nie jest to kosmetyka: od P.START licza sie prog przerwania eksperymentu
// (STOP_KAPITAL), porownanie z saldem konta w sprawdzKonto i kwota, od ktorej
// bot zaczyna po zmianie trybu. Wszystkie trzy braly dotad liczbe z pliku
// ustawien, nawet gdy stan mial lepsza.
if (stan.start != null) P.START = stan.start;

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

// ── ODCISK WERSJI ───────────────────────────────────────────────────────────
//
// Dziennik jest CELOWO niekompletny — srednie, nachylenie trendu i RSI swiecy
// wczesniej policzymy pozniej jeszcze raz ze swiec. Ale zeby policzyc je TAK
// SAMO, trzeba wiedziec, jaki kod i jakie progi obowiazywaly w tamtej chwili.
// A progi przychodza z deploy/.env, ktorego w repozytorium NIE MA.
//
// Numer commita sie do tego nie nadaje: bot commituje stan co piec minut, wiec
// zmienia sie MIEDZY DWOMA TREJDAMI tego samego przebiegu. Identyfikuje moment
// zapisu, a nie wersje strategii. Liczymy wiec skrot z ustawien ORAZ z dwoch
// plikow, ktore naprawde decyduja o wejsciu — wtedy zmiana progu i zmiana kodu
// sa jednakowo widoczne.
//
// Bez tego pola probka z miesiaca jest mieszanka wersji, a wnioski z niej
// opisuja historie naszych poprawek, a nie zachowanie rynku.
const ODCISK = [
  `gracz=${P.GRACZ}`, 'swieca=15m',
  `ema=${CFG.EMA_FAST}/${CFG.EMA_SLOW}/${CFG.EMA_TREND}`,
  `rsi=${CFG.RSI_LEN}`, `atr=${CFG.ATR_LEN}`, `er=${CFG.ER_LEN}`,
  `stop=${def.stopAtr ?? CFG.STOP_ATR}`, `tp=${CFG.TAKE_PROFIT_ATR}`,
  `trail=${def.trailAtr ?? CFG.TRAIL_ATR}`, `arm=${CFG.TRAIL_ARM_ATR}`,
  `minScore=${CFG.MIN_SCORE}`, `erMin=${CFG.ER_MIN}`, `kosztX=${CFG.COST_EDGE_MULT}`,
  `maxHold=${CFG.MAX_HOLD_HOURS}`,
  `lewar=${P.LEWAR}`, `alloc=${P.ALLOC}`, `miejsc=${P.MIEJSC}`, `taker=${P.TAKER}`,
  `rynki=${Object.keys(AKTYWA).join('+')}`,
].join(' ');
const KOD = (() => {
  const h = crypto.createHash('sha1').update(ODCISK);
  for (const f of ['strategy.mjs', 'gracze.mjs']) {
    try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch { /* trudno, to tylko etykieta */ }
  }
  return h.digest('hex').slice(0, 6);
})();
// Do pliku leci WYLACZNIE gdy odcisk sie zmienil — kilkaset bajtow na zmiane
// ustawien, a nie na kazdy trejd.
if ([...trejdy].reverse().find((t) => t.typ === 'WERSJA')?.kod !== KOD) {
  trejdy.push({ ts: nowISO(), typ: 'WERSJA', kod: KOD, odcisk: ODCISK });
  log(`> wersja bota: ${KOD}`);
}

log(`=== HAJSOMAT REALNY ${nowISO()} | ${P.SUCHY ? 'SUCHY (nic nie kosztuje)' : '*** ZA PRAWDZIWE PIENIADZE ***'} ===`);
log(`> gracz ${def.nazwa}, dzwignia ${P.LEWAR}x, ${P.MIEJSC} miejsca po ${(P.ALLOC * 100).toFixed(0)}%, ${P.MAX_TREJDOW > 0 ? `limit ${P.MAX_TREJDOW} trejdow` : "bez limitu trejdow"}`);

// Koniec eksperymentu NIE jest wyrokiem dozywotnim. Powody, dla ktorych bot
// staje, sa dwa i oba da sie cofnac: limit trejdow (podnosisz go w .env) oraz
// prog kapitalu (wraca, gdy dolozysz srodkow). Trzymanie `koniec` na stale
// znaczyloby, ze po podniesieniu limitu trzeba recznie grzebac w pliku stanu —
// a to jest dokladnie ten rodzaj pulapki, w ktorej czlowiek szuka bledu w
// kodzie zamiast w konfiguracji.
if (stan.koniec) {
  const kapNaStarcie = stan.cash + Object.values(stan.pozycje || {}).reduce((s, p) => s + p.margin, 0);
  // MAX_TREJDOW = 0 znaczy "bez limitu". Bez tego warunku `zamkniete >= 0`
  // bylby zawsze prawdziwy i bot zamilkalby natychmiast po starcie.
  const jestLimit = P.MAX_TREJDOW > 0 && stan.zamkniete >= P.MAX_TREJDOW;
  const jestPodloga = kapNaStarcie < P.START * P.STOP_KAPITAL;
  if (jestLimit || jestPodloga) {
    log(`> eksperyment ZAKONCZONY (${stan.koniec}) — ${jestLimit ? `zrobil ${stan.zamkniete} z ${P.MAX_TREJDOW} trejdow` : 'kapital ponizej progu'}`);
    log(`  Zeby wznowic: podnies REALNY_MAX_TREJDOW w deploy/.env${jestPodloga ? ' albo doloz srodkow' : ''}.`);
    process.exit(0);
  }
  log(`> WZNAWIAM: ${P.MAX_TREJDOW > 0 ? `limit podniesiony do ${P.MAX_TREJDOW}` : 'limit zdjety'}, zrobione ${stan.zamkniete}`);
  stan.koniec = null;
}

// ── ceny i metryki ──────────────────────────────────────────────────────────
// Indeks rynku i liczba miejsc po przecinku — bez nich zlecenie zostanie
// odrzucone. Bierzemy je z gieldy przy kazdym przebiegu, a nie z tablicy w
// kodzie, bo lista rynkow Hyperliquid sie zmienia i zaszyta na sztywno
// wskazywalaby kiedys na zupelnie inne aktywo.
const meta = await poi({ type: 'meta' });
const rynek = new Map(meta.universe.map((u, i) => [u.name.toUpperCase(), { idx: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage }]));

const rynki = {};
// Aktywo, w ktorym MAMY otwarta pozycje, ma inne wymagania niz aktywo, w ktore
// dopiero chcemy wejsc. Stop i trailing sa u nas WIRTUALNE — na gieldzie nie
// wisi zadne zlecenie zabezpieczajace, wiec pilnuje ich wylacznie petla wyjsc.
// Jesli rynek wypadnie z tej listy, petla pomija go cicho i lewarowana pozycja
// zostaje bez zadnej ochrony az do likwidacji.
const trzymane = new Set(Object.keys(stan.pozycje || {}));
for (const [sym, nazwa] of Object.entries(AKTYWA)) {
  try {
    const info = rynek.get(nazwa.toUpperCase());
    if (!info) { log(`  ${sym}: Hyperliquid nie ma juz rynku ${nazwa} — pomijam`); continue; }
    // Dzwignia decyduje o tym, czy wolno WEJSC — nie o tym, czy wolno pilnowac
    // tego, co juz mamy. Hyperliquid rutynowo obniza limity na altach, a TNSR
    // stoi dzis dokladnie na naszych 3x, wiec to nie jest przypadek teoretyczny.
    const zaMalaDzwignia = info.maxLeverage < P.LEWAR;
    if (zaMalaDzwignia && !trzymane.has(sym)) {
      log(`  ${sym}: maks. dzwignia ${info.maxLeverage}x < nasze ${P.LEWAR}x — pomijam`); continue;
    }
    if (zaMalaDzwignia) log(`  ${sym}: dzwignia spadla do ${info.maxLeverage}x — nie wchodze, ale pilnuje otwartej pozycji`);
    const c = await swiece(nazwa);
    if (c.length < 230) { log(`  ${sym}: tylko ${c.length} swiec, pomijam`); continue; }
    const D = przygotujAktywo(c);
    const i = D.n - 1;
    const m = D.metryka(i);
    if (m) rynki[sym] = { D, i, m, nazwa, cena: D.closes[i], ...info, tylkoWyjscie: zaMalaDzwignia };
  } catch (e) { log(`  ${sym}: ${e.message}`); }
}
log(`> rynkow gotowych: ${Object.keys(rynki).length} z ${Object.keys(AKTYWA).length}`);

// Otwarta pozycja BEZ danych rynkowych to pozycja bez nadzoru: w tym przebiegu
// nikt nie sprawdzi jej stopa. Petla wyjsc i tak ja pominie, wiec niech to
// przynajmniej nie bedzie ciche — jedno nieudane zapytanie o swiece nie moze
// wygladac tak samo jak zdrowy przebieg.
for (const sym of trzymane) {
  if (!rynki[sym]) console.error(`! ${sym}: mam otwarta pozycje, ale brak danych rynkowych — w tym przebiegu NIE sprawdze jej stopa ani trailingu`);
}

const kapital = () => stan.cash + Object.values(stan.pozycje).reduce((s, p) => s + p.margin, 0);

// ── wyjscia ─────────────────────────────────────────────────────────────────
for (const [sym, p] of Object.entries(stan.pozycje)) {
  const r = rynki[sym];

  // ── POZYCJA MOGLA ZNIKNAC BEZ NASZEGO UDZIALU ──────────────────────────────
  //
  // Likwidacja, ADL, reczne zamkniecie w app.hyperliquid.xyz albo zlecenie,
  // ktore weszlo, ale odpowiedz przepadla po drodze. Bez tego sprawdzenia bot
  // probowalby zamykac zleceniem reduceOnly cos, czego nie ma: gielda odmawia,
  // nizej leci `continue` — i tak co piec minut, bez konca. Miejsce byloby
  // zajete NA ZAWSZE (przy dwoch miejscach to od razu polowa mocy bota),
  // a kapital() liczylby marze, ktorej na koncie juz nie ma, wiec kazda kolejna
  // pozycja bralaby rozmiar od zawyzonej kwoty.
  //
  // Samonaprawa z sprawdzKonto tego NIE zlapie: ma warunek "gdy bot jest
  // plaski", a plaski nigdy nie bedzie, skoro trzyma ducha.
  //
  // Margines 3 minut na wypadek, gdyby swiezo otwarta pozycja nie zdazyla sie
  // jeszcze pojawic w odczycie konta.
  const nazwaHL = (AKTYWA[sym] ?? sym).toUpperCase();
  const swieza = Date.now() - Date.parse(p.entryTs) < 3 * 60000;
  if (pozycjeGieldy && !swieza && !pozycjeGieldy[nazwaHL]) {
    // Cena wyjscia jest tu ZGADYWANA i mowimy o tym wprost. Jesli rynek zaszedl
    // za prog likwidacji, zakladamy likwidacje (cala marza przepada); jesli nie
    // — ktos zamknal pozycje mniej wiecej po biezacej cenie.
    const px = r?.cena ?? p.entryPrice;
    const zlikwidowany = p.liqPrice != null
      && (p.side === 'LONG' ? px <= p.liqPrice : px >= p.liqPrice);
    const brutto = (p.side === 'LONG' ? px / p.entryPrice - 1 : 1 - px / p.entryPrice) * p.notional;
    const netto = zlikwidowany ? -p.margin : brutto - p.notional * P.TAKER;
    stan.cash += zlikwidowany ? 0 : p.margin + netto;
    stan.zamkniete += 1;
    // To sa NAJCIEKAWSZE trejdy w calym zbiorze — likwidacja albo zniknieciе pozycji
    // pozycji z gieldy — a dotad wychodzily z dziennika najubozsze ze wszystkich.
    trejdy.push({
      ts: nowISO(), sym, side: p.side, typ: 'CLOSE',
      powod: zlikwidowany ? 'LIKWIDACJA' : 'ZNIKNELA_Z_GIELDY',
      entryTs: p.entryTs,
      entryPrice: sig(p.entryPrice), cenaWidziana: sig(px), cenaWypelnienia: sig(px),
      poslizg: null,        // tego wyjscia nie mierzylismy — nie ma czego porownac
      poslizgWe: sig(p.poslizgWejscia),
      szacowane: true,      // NIE liczyc tego trejdu do pomiaru kosztow rundy
      margin: sig(p.margin), notional: sig(p.notional),
      oplata: sig(zlikwidowany ? 0 : p.notional * P.TAKER),
      oplataRundy: sig(p.notional * P.TAKER * (zlikwidowany ? 1 : 2)),
      pnlUsd: sig(netto),
      R: zlikwidowany ? -1 : sig((netto - p.notional * P.TAKER) / p.margin),
      trzymane_h: sig((Date.now() - Date.parse(p.entryTs)) / 3600000),
      ...dziennikWejscia(p),
    });
    log(`  ! ${sym} ${p.side}: gielda juz jej nie ma — ${zlikwidowany ? 'likwidacja' : 'zamknieta poza botem'}, ksieguje szacunkowo ${usd(netto)}`);
    log('    (cena wyjscia to szacunek; gotowke wyrowna samonaprawa, gdy bot bedzie plaski)');
    delete stan.pozycje[sym];
    continue;
  }

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

    // CZESCIOWE WYPELNIENIE. IOC bierze tylko to, co stoi po naszej cenie —
    // reszta zlecenia przepada, ale POZYCJA NA GIELDZIE ZOSTAJE. Skasowanie jej
    // ze stanu w calosci zostawiloby resztke otwarta bez nadzoru, a kontrola
    // z sprawdzKonto tego nie zlapie (wymaga, zeby bot byl plaski).
    //
    // Ksiegujemy wiec tylko to, co naprawde poszlo, i wracamy po reszte za piec
    // minut. Skutek uboczny: zapis trejdu obejmie dopiero domkniecie, wiec przy
    // czesciowym wyjsciu zmierzony poslizg dotyczy resztki. Wolimy to od
    // porzucenia pozycji, o ktorej bot zapomnial.
    if (w.ile > 0 && w.ile < p.sz * 0.999) {
      const czesc = w.ile / p.sz;
      const bruttoC = (p.side === 'LONG' ? w.fill / p.entryPrice - 1 : 1 - w.fill / p.entryPrice) * p.notional * czesc;
      log(`  ${sym}: zamknieta tylko czesc (${(czesc * 100).toFixed(0)}%) — reszta zostaje, domykam w nastepnym przebiegu`);
      stan.cash += p.margin * czesc + bruttoC - p.notional * czesc * P.TAKER;
      p.sz -= w.ile;
      p.notional *= 1 - czesc;
      p.margin *= 1 - czesc;
      // Znacznik dla dziennika: bez niego `poslizg` na koncowym wpisie dotyczy
      // resztki, a nikt sie nie domysli, dlaczego akurat ten pomiar odstaje.
      p.czesciowe = (p.czesciowe ?? 1) * czesc;
      continue;
    }
    fill = w.fill;
  }

  const brutto = (p.side === 'LONG' ? fill / p.entryPrice - 1 : 1 - fill / p.entryPrice) * p.notional;
  const oplata = p.notional * P.TAKER;
  const netto = brutto - oplata;          // to, co wraca do gotowki przy zamknieciu
  stan.cash += p.margin + netto;
  stan.zamkniete += 1;

  // R musi zawierac OBIE oplaty rundy, nie tylko wyjsciowa. Ta wejsciowa zeszla
  // z gotowki przy otwarciu, wiec kapital jest poprawny — ale R sluzy do
  // porownan z liga i backtestami, a tam liczy sie pelny koszt rundy.
  //
  // To dokladnie ten sam blad, ktory dzis rano znalazlem w liga.mjs, gdzie
  // zawyzal kazde R o 0,180 pkt proc. Nie chce go tu powtorzyc.
  const pelnyNetto = netto - p.notional * P.TAKER;

  trejdy.push({
    ts: nowISO(), sym, side: p.side, typ: 'CLOSE', powod,
    entryTs: p.entryTs,        // klucz do wiersza OPEN i kotwica okna swiec
    entryPrice: sig(p.entryPrice), cenaWidziana: sig(widziana), cenaWypelnienia: sig(fill),
    // zamkniecie longa to sprzedaz, zamkniecie shorta to kupno
    poslizg: sig(poslizgKosztu(widziana, fill, p.side !== 'LONG')),
    // Poslizg wejscia przeniesiony tutaj. Wiersz OPEN wypada z ogona pierwszy,
    // a jednostka kosztu jest CALA RUNDA — nie polowa.
    poslizgWe: sig(p.poslizgWejscia),
    margin: sig(p.margin), notional: sig(p.notional),
    oplata: sig(oplata), oplataRundy: sig(2 * p.notional * P.TAKER),
    pnlUsd: sig(netto),                      // sam moment zamkniecia, jak w lidze
    R: sig(pelnyNetto / p.margin),           // pelna runda z obiema oplatami — to porownuj z liga
    trzymane_h: sig((Date.now() - Date.parse(p.entryTs)) / 3600000),
    ...dziennikWejscia(p),
  });
  log(`  ZAMYKAM ${sym} ${p.side} @ ${fill} — ${powod}, wynik ${usd(netto)} (${(netto / p.margin * 100).toFixed(2)}%)`);

  // Domkniecie wiersza dziennika: dopiero teraz znamy poslizg WYJSCIA i pelna
  // runde. Wiersz szukamy po `entryTs`, bo to jedyny klucz laczacy otwarcie
  // z zamknieciem — ten sam, ktorego uzywa `dziennikWejscia`.
  try {
    const dziennik = czytaj(F_ROZBIEZNOSCI, []);
    const w = dziennik.find((x) => x.ts === p.entryTs && x.sym === sym);
    if (w) {
      w.wyjscie = {
        ts: nowISO(),
        powod,
        cenaSymulatora: sig(widziana),
        cenaWypelnienia: sig(fill),
        poslizgAtr: p.atrAtEntry > 0
          ? sig((p.side === 'LONG' ? widziana - fill : fill - widziana) / p.atrAtEntry, 4)
          : null,
        oplataWyjscia: sig(oplata),
        trzymane_h: sig((Date.now() - Date.parse(p.entryTs)) / 3600000),
        R: sig(pelnyNetto / p.margin),
      };
      // Poslizg CALEJ rundy w ATR — ta liczba odpowiada wprost na pytanie
      // "ile przewagi zjadla egzekucja", bo laboratorium liczy cel na 3,2 ATR.
      w.poslizgRundyAtr = w.poslizgAtr != null && w.wyjscie.poslizgAtr != null
        ? sig(w.poslizgAtr + w.wyjscie.poslizgAtr, 4) : null;
      pisz(F_ROZBIEZNOSCI, dziennik);
    }
  } catch (e) {
    log(`    (dziennik rozbieznosci nie domknal wiersza: ${e.message})`);
  }
  delete stan.pozycje[sym];
  // Tak samo jak przy wejsciu: utrwalamy od razu. Gdyby proces zginal tutaj,
  // sprawdzenie "pozycja zniknela z gieldy" wyzej i tak by to posprzatalo, ale
  // po cenie SZACOWANEJ — a tu mamy prawdziwa cene wypelnienia, czyli dokladnie
  // ten pomiar, dla ktorego ten bot powstal. Szkoda go tracic.
  if (!P.SUCHY) { stan.kapital = kapital(); pisz(F_STAN, stan); piszWiersze(F_TREJDY, trejdy); }
}

// ── koniec eksperymentu? ────────────────────────────────────────────────────
if (P.MAX_TREJDOW > 0 && stan.zamkniete >= P.MAX_TREJDOW) {
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
    if (P.MAX_TREJDOW > 0 && stan.zamkniete + Object.keys(stan.pozycje).length >= P.MAX_TREJDOW) break;
    // Rynek trzymany tylko po to, zeby pilnowac otwartej pozycji — dzwignia
    // gieldy spadla ponizej naszej, wiec wejscie wyszloby w innej skali.
    if (r.tylkoWyjscie) continue;

    // To samo `try` co przy skanie nizej: gracz moze nie umiec danego ksztaltu
    // danych. Bez niego wyjatek zabijalby proces w srodku petli wejsc — juz PO
    // tym, jak wczesniejsze zlecenie sie wypelnilo, ale PRZED zapisem stanu.
    // Prawdziwa pozycja zostawalaby wtedy poza ksiegami bota.
    let syg = null;
    try { syg = def.wejscie(sym, r.m, r.D.kawalek(r.i)); }
    catch (e) { log(`  ${sym}: gracz nie policzyl sygnalu (${e.message}) — pomijam`); continue; }
    if (!syg) continue;

    const kap = kapital();
    let margin = Math.min(stan.cash, kap * P.ALLOC);
    let notional = margin * P.LEWAR;
    if (notional < P.MIN_ZLECENIE) { log(`  ${sym}: pozycja ${usd(notional)} ponizej minimum ${usd(P.MIN_ZLECENIE)} — pomijam`); continue; }

    const long = syg.kier === 'LONG';
    // Znaczniki do dziennika rozbieznosci. `tSwieca` to OTWARCIE swiecy decyzji,
    // wiec jej zamkniecie wypada o SWIECA_MS pozniej — i dopiero od tamtej chwili
    // liczy sie opoznienie, bo to wtedy symulator uznalby sygnal za wazny.
    const tSwieca = r.D.c[r.i].t;
    const tDecyzja = Date.now();
    let tZlecenie = null, tWypelnienie = null;
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

      tZlecenie = Date.now();
      const w = await zlec({ idx: r.idx, szDecimals: r.szDecimals, kupno: long, wielkosc: sz, widziana, redukuje: false });
      tWypelnienie = Date.now();
      if (!w) continue;
      fill = w.fill; ileSztuk = w.ile;

      // Gielda mogla dac MNIEJ sztuk, niz chcielismy — IOC bierze tylko to, co
      // stoi po naszej cenie. Ksiegujemy wtedy mniejsza pozycje, bo inaczej bot
      // blokowalby marze, ktorej realnie nie wystawil, i liczylby wynik od
      // nominalu, ktorego nie ma na gieldzie.
      if (ileSztuk > 0 && ileSztuk < sz * 0.999) {
        const czesc = ileSztuk / sz;
        log(`    weszlo tylko ${(czesc * 100).toFixed(0)}% zlecenia — ksieguje mniejsza pozycje`);
        margin *= czesc; notional *= czesc;
      }
    }

    const stopA = def.stopAtr ?? CFG.STOP_ATR;
    const poslizgWe = poslizgKosztu(widziana, fill, long);
    // JEDEN znacznik czasu dla pozycji i dla wpisu w dzienniku.
    //
    // Wczesniej byly to dwa osobne wywolania nowISO() — jedno tutaj, drugie
    // ponizej. Potrafily rozjechac sie o milisekunde i po cichu zerwac jedyne
    // polaczenie miedzy warunkami wejscia a wynikiem trejdu.
    const teraz = nowISO();
    stan.cash -= margin + notional * P.TAKER;
    stan.pozycje[sym] = {
      sym, side: syg.kier, entryPrice: fill, entryTs: teraz,
      margin, notional, leverage: P.LEWAR,
      sz: ileSztuk,          // ile sztuk trzymamy — potrzebne, zeby zamknac dokladnie tyle
      // Cena, przy ktorej gielda zamknie nas sama. Liczymy ja przy wejsciu i
      // zapisujemy, zeby apka mogla pokazac, jak blisko krawedzi stoi pozycja.
      liqPrice: long ? fill * (1 - 0.9 / P.LEWAR) : fill * (1 + 0.9 / P.LEWAR),
      stopPrice: long ? fill - stopA * r.m.atr : fill + stopA * r.m.atr,
      takeProfit: long ? fill + CFG.TAKE_PROFIT_ATR * r.m.atr : fill - CFG.TAKE_PROFIT_ATR * r.m.atr,
      atrAtEntry: r.m.atr, bestPrice: fill, trailArmed: false,
      trailAtr: def.trailAtr ?? CFG.TRAIL_ATR, bezSmyczy: !!def.bezSmyczy,
      minGodzin: def.minGodzin ?? 0, stopZawsze: !!def.stopZawsze,
      karencjaStopH: def.karencjaStopH ?? 0, maxHoldH: def.maxHoldH ?? 0,
      // ── to, co ma dojechac do wiersza zamkniecia ────────────────────────────
      //
      // Pozycja jest JEDYNYM miejscem, w ktorym bot cokolwiek pamieta miedzy
      // przebiegami crona. Wszystko, czego tu nie polozymy, przestanie istniec
      // w chwili `delete stan.pozycje[sym]` — a wtedy zostanie sam wynik, bez
      // zadnego sladu, dlaczego bot w to wszedl.
      //
      // Przy okazji: apka pobiera plik stanu i tak, wiec dla pozycji jeszcze
      // OTWARTEJ warunki wejscia widac wlasnie stad. Dlatego mozemy je zdjac
      // z wiersza OPEN i nie placic za nie dwa razy.
      kod: KOD,
      powodWejscia: syg.powod,
      // Swieca decyzji (r.i), a nie ostatnia dostepna — to ona byla na ekranie,
      // gdy gracz powiedzial "wchodz".
      warunkiWejscia: warunki(r.m, r.D.c[r.i], long, r.D.c.slice(0, r.i + 1)),
      score: syg.score ?? null,     // sygnal go zwraca, a dotad byl wyrzucany
      poslizgWejscia: poslizgWe,
      stopAtr: stopA, celAtr: CFG.TAKE_PROFIT_ATR,
    };
    trejdy.push({
      ts: teraz, sym, side: syg.kier, typ: 'OPEN', powod: syg.powod,
      cenaWidziana: sig(widziana), cenaWypelnienia: sig(fill), poslizg: sig(poslizgWe),
      margin: sig(margin), notional: sig(notional), oplata: sig(notional * P.TAKER),
      // `warunki` zdjete stad celowo — pelny komplet jedzie na wierszu CLOSE,
      // a dla pozycji otwartej apka ma go w pliku stanu. Zero powtorzen.
      ...(ileSztuk < sz * 0.999 ? { czesc: sig(ileSztuk / sz, 3) } : {}),
    });
    log(`  OTWIERAM ${sym} ${syg.kier} @ ${fill} — ${syg.powod}`);

    // ── WIERSZ DZIENNIKA ROZBIEZNOSCI ────────────────────────────────────
    //
    // Pisany OSOBNO od `trejdy`, bo sluzy do czego innego: tamten plik jest
    // ogonem ostatnich zdarzen i sie przycina, a ten ma przetrwac caly zywy
    // test. Przy jednym wejsciu na tydzien czterdziesci wierszy to kilkanascie
    // kilobajtow — nie ma czego przycinac.
    try {
      const tKoniecSwiecy = tSwieca + SWIECA_MS;
      const zamknieta = tDecyzja >= tKoniecSwiecy;
      const opoznienieS = ((tWypelnienie ?? tDecyzja) - tKoniecSwiecy) / 1000;
      const rozb = {
        ts: teraz,
        gracz: P.GRACZ,
        sym,
        side: syg.kier,
        // ── czasy ──────────────────────────────────────────────────────
        swiecaOd: new Date(tSwieca).toISOString(),
        swiecaZamknieta: zamknieta,
        decyzjaPoSwiecyS: sig((tDecyzja - tKoniecSwiecy) / 1000, 4),
        zlecenieS: tZlecenie ? sig((tZlecenie - tDecyzja) / 1000, 4) : null,
        wypelnienieS: tWypelnienie && tZlecenie ? sig((tWypelnienie - tZlecenie) / 1000, 4) : null,
        opoznienieS: sig(opoznienieS, 4),
        // ── ceny ───────────────────────────────────────────────────────
        cenaSymulatora: sig(widziana),   // to, co wzialby symulator na tej swiecy
        cenaWypelnienia: sig(fill),
        poslizgUsd: sig((long ? fill - widziana : widziana - fill) * ileSztuk),
        poslizgFrakcja: sig(poslizgWe),
        // Poslizg w ATR — jedyna jednostka porownywalna miedzy BTC a BONK,
        // i ta sama, w ktorej liczymy stop i cel.
        poslizgAtr: r.m.atr > 0 ? sig((long ? fill - widziana : widziana - fill) / r.m.atr, 4) : null,
        atr: sig(r.m.atr),
        // ── koszty ─────────────────────────────────────────────────────
        oplataWejscia: sig(notional * P.TAKER),
        oplataRundyPlan: sig(2 * notional * P.TAKER),
        // Funding NIE JEST DZIS MIERZONY — bot go nie pobiera. Zapisujemy null
        // jawnie, zeby brak byl widoczny w danych, a nie wygladal na zero.
        funding: null,
        notional: sig(notional),
        alarmOpoznienie: opoznienieS > PROG_OPOZNIENIA_S,
      };
      const dziennik = czytaj(F_ROZBIEZNOSCI, []);
      dziennik.push(rozb);
      pisz(F_ROZBIEZNOSCI, dziennik);
      if (!zamknieta) {
        log(`    UWAGA: decyzja na swiecy JESZCZE NIEZAMKNIETEJ — symulator decydowalby po jej zamknieciu`);
      }
      if (rozb.alarmOpoznienie) {
        log(`    ALARM: ${opoznienieS.toFixed(0)} s od zamkniecia swiecy do wypelnienia (prog ${PROG_OPOZNIENIA_S} s)`);
      }
      log(`    dziennik: poslizg ${rozb.poslizgAtr} ATR, opoznienie ${opoznienieS.toFixed(0)} s`);
    } catch (e) {
      // Dziennik jest pomiarem, nie czescia handlu — jego awaria NIE MOZE
      // przewrocic bota, ktory ma juz otwarta prawdziwa pozycje.
      log(`    (dziennik rozbieznosci nie zapisal sie: ${e.message})`);
    }

    // ZAPIS NATYCHMIAST PO WYPELNIENIU, a nie dopiero na koncu przebiegu.
    //
    // Miedzy zlozeniem zlecenia a koncowym pisz(F_STAN) jest jeszcze reszta tej
    // petli i caly skan rynkow. Cokolwiek ubije proces po drodze — wyjatek,
    // restart serwera, timeout sieci — zostawiloby PRAWDZIWA pozycje na gieldzie
    // poza ksiegami bota. Przy nastepnym przebiegu sprawdzKonto albo zabije bota
    // (proces exit 1), albo, jesli akurat trzyma inna pozycje, w ogole tego nie
    // zauwazy i sierota zostanie na gieldzie bez nadzoru.
    //
    // Zapis jest tani (jeden maly plik), a wykonuje sie tylko po realnym wejsciu.
    if (!P.SUCHY) {
      stan.kapital = kapital();
      pisz(F_STAN, stan);
      piszWiersze(F_TREJDY, trejdy);
    }
    otwarte++;
  }
}

// ── zapis ───────────────────────────────────────────────────────────────────
stan.lastRun = nowISO();
stan.kapital = kapital();
stan.suchy = P.SUCHY;
// Start zapisujemy RAZ — przy zalozeniu stanu albo przy synchronizacji z kontem.
//
// Wczesniej ta linijka nadpisywala go przy KAZDYM przebiegu wartoscia z .env
// i kasowala to, co chwile wczesniej ustawil sprawdzKonto z prawdziwego salda.
// Widac to jak na dloni w historii Trenda: przebieg o 08:10 zapisal start 35,60
// (odczytane z konta), a przebieg o 08:15 nadpisal go na 37 z ustawien.
//
// Skutek: Smycz zaczal realnie od 25,00 USD, a `start` pokazywal 37 — i wynik
// wygladal na -31,85%, choc bot byl na +0,86%.
//
// `start` ma znaczyc "od ilu ten bot NAPRAWDE zaczal", a nie "co dzis stoi
// w pliku ustawien". Zmienic go moze tylko synchronizacja z prawdziwym saldem
// albo odtworzenie z ksiag wyzej.
if (stan.start == null) stan.start = P.START;
stan.szczyt = Math.max(stan.szczyt ?? stan.start, stan.kapital);
// Ceny widziane w tym przebiegu — apka pokazuje po nich biezacy wynik pozycji.
stan.ceny = Object.fromEntries(Object.entries(rynki).map(([s, r]) => [s, r.cena]));

// Skan wszystkich rynkow: co bot widzial i dlaczego wszedl albo nie wszedl.
// Liczymy go OSOBNO od petli wejsc, bo tamta konczy sie, gdy zabraknie miejsc —
// a wtedy w apce nie byloby widac reszty rynkow i wygladaloby to na awarie.
stan.skan = Object.entries(rynki).map(([sym, r]) => {
  let syg = null;
  try { syg = def.wejscie(sym, r.m, r.D.kawalek(r.i)); } catch { /* gracz moze nie umiec danego ksztaltu */ }
  const zajete = !!stan.pozycje[sym];
  return {
    sym, price: r.cena,
    side: syg?.kier ?? null,
    rsi: r.m.rsi, volPct: r.m.volPct,
    enter: !!syg && !zajete,
    held: zajete ? stan.pozycje[sym].side : null,
    reason: zajete ? 'juz trzymam te pozycje' : (syg?.powod ?? 'brak sygnalu'),
  };
});
pisz(F_STAN, stan);
// ── PRZYCINANIE: NIC NIE KASUJEMY ──────────────────────────────────────────
//
// Do werdyktu o zyskownosci trzeba okolo 714 rund. Przy tempie Smyczy (13 rund
// na dobe) to prawie dwa miesiace i ~1400 wpisow — a stary limit 500 ucinal
// probke DOKLADNIE zanim zaczela cokolwiek znaczyc. I robil to po cichu.
//
// Ogon idzie wiec do archiwum dopisywanego jednym `append`, a nie do kosza:
// git dokleja przyrost zamiast przepisywac plik, apka pobiera tylko goracy
// ogon, a badania maja pelna historie.
const OGON = num('REALNY_OGON', 400);
if (trejdy.length > OGON) {
  const doArchiwum = trejdy.slice(0, trejdy.length - OGON);
  fs.appendFileSync(F_ARCHIWUM, `${doArchiwum.map((x) => JSON.stringify(x)).join('\n')}\n`);
  log(`> do archiwum poszlo ${doArchiwum.length} starszych wpisow`);
  trejdy = trejdy.slice(-OGON);
}
piszWiersze(F_TREJDY, trejdy);

// Krzywa kapitalu — apka rysuje z niej wykres i liczy obsuniecia. Jeden punkt
// na przebieg, przycinany do 4000, tak jak w lidze.
let equity = czytaj(F_EQUITY, []);
if (!Array.isArray(equity)) equity = [];
equity.push({ ts: Date.now(), equityUsd: +stan.kapital.toFixed(4) });
if (equity.length > 4000) {
  const pol = Math.floor(equity.length / 2);
  equity = [...equity.slice(0, pol).filter((_, i) => i % 2 === 0), ...equity.slice(pol)];
}
pisz(F_EQUITY, equity);

// ── spis stada ───────────────────────────────────────────────────────────────
//
// Wspolny plik, do ktorego kazdy bot dopisuje swoja wizytowke. Bez niego apka
// musialaby zgadywac, ktore boty zyja — czyli strzelac osiemnastoma zapytaniami
// po nazwach wszystkich graczy i patrzec, ktore nie zwroca bledu.
//
// Zapis jest bezpieczny, bo run.sh uruchamia boty PO KOLEI w jednym procesie,
// wiec dwa nie pisza naraz. Gdyby to sie kiedys zmienilo, trzeba tu dolozyc
// blokade — inaczej ostatni zapis skasuje wpisy pozostalych.
if (PREFIKS !== 'realny') {
  const F_SPIS = path.join(KAT, 'stado.json');
  const spis = czytaj(F_SPIS, {});
  const zam = trejdy.filter((t) => t.typ === 'CLOSE');
  const R = zam.map((t) => t.R).filter((x) => x != null);
  spis[P.GRACZ] = {
    gracz: P.GRACZ,
    prefiks: PREFIKS,
    nazwa: def.nazwa,
    suchy: P.SUCHY,
    start: P.START,
    kapital: stan.kapital,
    zamkniete: stan.zamkniete,
    pozycji: Object.keys(stan.pozycje).length,
    sredR: R.length ? R.reduce((s, x) => s + x, 0) / R.length : null,
    wygrane: zam.length ? zam.filter((t) => t.pnlUsd > 0).length / zam.length : null,
    lastRun: stan.lastRun,
    koniec: stan.koniec ?? null,
    // Po kim ten bot przejal KONTO. Bez tego apka sumuje kapital poprzednika
    // i nastepcy jako dwie osobne kwoty, choc to sa DOKLADNIE TE SAME pieniadze.
    przejalPo: env('REALNY_PO', '') || null,
  };
  pisz(F_SPIS, spis);
}

log(`> kapital ${usd(stan.kapital)} (start ${usd(P.START)}), pozycji ${Object.keys(stan.pozycje).length}, trejdow ${stan.zamkniete}${P.MAX_TREJDOW > 0 ? `/${P.MAX_TREJDOW}` : ""}`);

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
