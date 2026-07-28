/**
 * HAJSOMAT — kolektor danych spoza wykresu.
 *
 * Zbiera to, czego nie widac na swiecach, i czego nie da sie pobrac wstecz.
 * Historia tych danych u zrodel siega 30 dni albo wcale — wiec jedyny sposob,
 * zeby miec ich rok, to zaczac zbierac dzisiaj.
 *
 * Co zbieramy dla kazdego aktywa:
 *
 *   Z Jupitera (co dzieje sie na lancuchu):
 *     - liczba posiadaczy tokena i jej zmiana,
 *     - plynnosc i jej zmiana,
 *     - wolumen kupna i sprzedazy,
 *     - wolumen ORGANICZNY — Jupiter odsiewa boty i sztuczny obrot,
 *       wiec to jest to, co robia prawdziwi ludzie,
 *     - liczba kupujacych, sprzedajacych i handlujacych netto.
 *
 *   Z Binance (co robia inni gracze na kontraktach):
 *     - otwarte pozycje, czyli ile pieniedzy siedzi w rynku,
 *     - jaka czesc najlepszych traderow gra na wzrost, a jaka na spadek,
 *     - kto sie pcha po cenie: kupujacy czy sprzedajacy.
 *
 * Zapis: state/dane/RRRR-MM-DD.jsonl — jedna linia na aktywo na pomiar.
 * Format JSONL, bo dopisywanie do niego jest tanie i git dobrze go pakuje.
 *
 * Wywolywany co przebieg bota, ale sam pilnuje, zeby zbierac nie czesciej
 * niz co ODSTEP_MIN minut.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSE, CFG, env, envNum, envBool } from './strategy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'state', 'dane');
const F_INFO = path.join(ROOT, 'state', 'dane-info.json');

const ODSTEP_MIN = envNum('KOLEKTOR_ODSTEP_MIN', 15);
const WYMUS = envBool('KOLEKTOR_WYMUS', false);

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dzis = () => new Date().toISOString().slice(0, 10);

async function pobierz(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'hajsomat-kolektor/1.0', accept: 'application/json' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Zaokragla, zeby pliki nie puchly od osiemnastu miejsc po przecinku. */
const r = (v, m = 6) => (typeof v === 'number' && isFinite(v) ? Number(v.toFixed(m)) : null);

// ─────────────────────────────────────────────────────────────────────────────
// Zrodla
// ─────────────────────────────────────────────────────────────────────────────

/** Dane z lancucha: posiadacze, plynnosc, przeplywy organiczne. */
async function zJupitera(sym) {
  const mint = UNIVERSE[sym]?.mint;
  if (!mint) return {};
  const d = await pobierz(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
  const arr = Array.isArray(d) ? d : d?.tokens || [];
  const t = arr.find((x) => (x.id || x.address) === mint);
  if (!t) return {};
  const s = t.stats1h || {};
  return {
    px: r(t.usdPrice, 8),
    hold: t.holderCount ?? null,
    liq: r(t.liquidity, 0),
    mcap: r(t.mcap, 0),
    org: r(t.organicScore, 1),
    // okno godzinne
    h_pc: r(s.priceChange, 5),
    h_hc: r(s.holderChange, 6),
    h_lc: r(s.liquidityChange, 5),
    h_bv: r(s.buyVolume, 0),
    h_sv: r(s.sellVolume, 0),
    h_bo: r(s.buyOrganicVolume, 0),
    h_so: r(s.sellOrganicVolume, 0),
    h_nb: s.numBuys ?? null,
    h_ns: s.numSells ?? null,
    h_nt: s.numTraders ?? null,
    h_nob: s.numOrganicBuyers ?? null,
    h_nnb: s.numNetBuyers ?? null,
  };
}

/** Pozycjonowanie innych graczy. Nie kazdy token ma kontrakty na Binance. */
async function zBinance(sym) {
  const S = `${sym}USDT`;
  const B = 'https://fapi.binance.com';
  const [oi, lsa, lsp, tk] = await Promise.all([
    pobierz(`${B}/fapi/v1/openInterest?symbol=${S}`),
    pobierz(`${B}/futures/data/topLongShortAccountRatio?symbol=${S}&period=5m&limit=1`),
    pobierz(`${B}/futures/data/topLongShortPositionRatio?symbol=${S}&period=5m&limit=1`),
    pobierz(`${B}/futures/data/takerlongshortRatio?symbol=${S}&period=5m&limit=1`),
  ]);
  if (!oi && !lsa) return {}; // brak kontraktow na to aktywo
  return {
    oi: r(Number(oi?.openInterest), 2),
    ls_a: r(Number(lsa?.[0]?.longShortRatio), 4),
    ls_p: r(Number(lsp?.[0]?.longShortRatio), 4),
    tk: r(Number(tk?.[0]?.buySellRatio), 4),
  };
}

/**
 * Dane o calym rynku, nie o pojedynczym tokenie. Cztery zapytania na pomiar,
 * a dotycza wszystkich aktywow naraz. Zapisujemy je jako osobny wiersz z
 * symbolem _RYNEK.
 *
 * Aktywnosc deweloperow i obciazenie sieci sa calkowicie niezalezne od ceny —
 * w przeciwienstwie do kapitalu zablokowanego, ktory liczy sie w dolarach
 * i rosnie sam, gdy tokeny drozeja.
 */
/**
 * Znane portfele gield na Solanie. Rosnace saldo = ludzie wplacaja tokeny na
 * gielde, a wplacaja zwykle po to, zeby sprzedac. Sygnal calkowicie niezalezny
 * od ceny.
 *
 * Przypisanie adresow do gield jest publiczna wiedza, ale nie da sie go
 * potwierdzic z cala pewnoscia. Liczy sie trend sumy, nie to, czy konkretny
 * adres na pewno nalezy do konkretnej gieldy.
 */
const PORTFELE_GIELD = [
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', // Binance
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Binance
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', // Coinbase
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', // Coinbase
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', // Bybit
];

async function saldaGield() {
  const rpc = env('RPC_URL', 'https://api.mainnet-beta.solana.com');
  let suma = 0;

  // Pojedynczo, bo publiczny wezel odrzuca zapytania zbiorcze bledem 429.
  for (const adres of PORTFELE_GIELD) {
    let ok = false;
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [adres] }),
      });
      const v = (await r.json())?.result?.value;
      if (typeof v === 'number') {
        suma += v / 1e9;
        ok = true;
      }
    } catch {
      /* nizej */
    }
    // Gdy choc jeden adres nie odpowie, suma bylaby mniejsza i wygladalaby
    // jak wyplyw z gieldy, ktory sie nie wydarzyl. Lepiej nie zapisac nic
    // niz zapisac liczbe, ktorej nie da sie porownac z poprzednimi.
    if (!ok) return null;
    await sleep(300);
  }
  return suma > 0 ? suma : null;
}

async function oRynku() {
  const gieldy = await saldaGield();
  const [fng, tps, cg, tvl] = await Promise.all([
    pobierz('https://api.alternative.me/fng/?limit=1'),
    (async () => {
      try {
        const r = await fetch('https://api.mainnet-beta.solana.com', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPerformanceSamples', params: [1] }),
        });
        const p = (await r.json())?.result?.[0];
        return p ? p.numTransactions / p.samplePeriodSecs : null;
      } catch {
        return null;
      }
    })(),
    pobierz(
      'https://api.coingecko.com/api/v3/coins/solana?localization=false&tickers=false' +
        '&market_data=false&community_data=true&developer_data=true'
    ),
    pobierz('https://api.llama.fi/v2/historicalChainTvl/Solana'),
  ]);

  const d = cg?.developer_data || {};
  return {
    fng: fng?.data?.[0]?.value ? Number(fng.data[0].value) : null,
    tps: r(tps, 0),
    dev_com: d.commit_count_4_weeks ?? null,
    dev_ludzi: d.pull_request_contributors ?? null,
    sent: r(cg?.sentiment_votes_up_percentage, 2),
    tvl: Array.isArray(tvl) && tvl.length ? r(tvl[tvl.length - 1].tvl, 0) : null,
    gield_sol: r(gieldy, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const info = (() => {
  try {
    return JSON.parse(fs.readFileSync(F_INFO, 'utf8'));
  } catch {
    return { start: null, ostatni: 0, pomiarow: 0, wierszy: 0 };
  }
})();

const odOstatniego = (Date.now() - (info.ostatni || 0)) / 60000;
if (!WYMUS && odOstatniego < ODSTEP_MIN) {
  log(`> kolektor: ostatni pomiar ${odOstatniego.toFixed(1)} min temu, czekam do ${ODSTEP_MIN}`);
  process.exit(0);
}

/**
 * Prawdziwy koszt rundy na Jupiterze, mierzony teraz — nie zakladany.
 *
 * To najwazniejsza pojedyncza liczba w calym projekcie: rozstrzygala o porzuceniu
 * spotu, o filtrze oplacalnosci i o wyniku Cierpliwego. A my znamy ja z JEDNEGO
 * pomiaru z 26 lipca. Koszt zmienia sie z plynnoscia — w spokojny wtorek i w panike
 * to sa inne swiaty — i tej zmiennosci nie da sie pobrac wstecz.
 *
 * Pomiar: kwotowanie USDC -> token dla 150 USD, potem token -> USDC dla tego,
 * co wyszlo. Ile ubylo z konca wobec poczatku, to koszt rundy (spread + wplyw
 * na cene, bez oplat sieciowych, ktore sa stale).
 */
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const KWOTA_RT = 150_000_000; // 150 USD w jednostkach USDC (6 miejsc)

async function kosztRundy(sym) {
  const mint = UNIVERSE[sym].mint;
  const q = (inM, outM, amount) =>
    pobierz(
      `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inM}&outputMint=${outM}` +
        `&amount=${amount}&slippageBps=50`
    );
  const tam = await q(USDC, mint, KWOTA_RT);
  if (!tam?.outAmount) return null;
  await sleep(250);
  const nazad = await q(mint, USDC, tam.outAmount);
  if (!nazad?.outAmount) return null;
  const strata = (KWOTA_RT - Number(nazad.outAmount)) / KWOTA_RT;
  // Lekko ujemna "strata" to prawdziwy pomiar: na hiperplynnnym SOL kwotowania
  // potrafia sie skrzyzowac o ulamek punktu bazowego i koszt wychodzi ~zero.
  // Odrzucamy dopiero wartosci bez sensu w obie strony.
  return strata > -0.01 && strata < 0.2 ? +strata.toFixed(5) : null;
}

const aktywa = CFG.ASSETS.filter((s) => UNIVERSE[s]);
log(`> kolektor: zbieram dane dla ${aktywa.length} aktywow...`);

const teraz = Date.now();
const wiersze = [];
let zJup = 0;
let zBin = 0;

for (const sym of aktywa) {
  const [j, b, rt] = await Promise.all([zJupitera(sym), zBinance(sym), kosztRundy(sym)]);
  if (Object.keys(j).length) zJup += 1;
  if (Object.keys(b).length) zBin += 1;
  if (!Object.keys(j).length && !Object.keys(b).length && rt == null) continue;
  wiersze.push(JSON.stringify({ t: teraz, sym, ...j, ...b, ...(rt != null ? { rt } : {}) }));
  await sleep(250); // uprzejmosc wobec darmowych API
}

// warstwa rynkowa — jeden wiersz, dotyczy wszystkiego
const rynek = await oRynku();
if (Object.values(rynek).some((v) => v != null)) {
  wiersze.push(JSON.stringify({ t: teraz, sym: '_RYNEK', ...rynek }));
}

if (!wiersze.length) {
  log('! kolektor: nie udalo sie pobrac niczego');
  process.exit(0);
}

fs.mkdirSync(DIR, { recursive: true });
const plik = path.join(DIR, `${dzis()}.jsonl`);
fs.appendFileSync(plik, wiersze.join('\n') + '\n', 'utf8');

info.start = info.start || new Date(teraz).toISOString();
info.ostatni = teraz;
info.ostatniISO = new Date(teraz).toISOString();
info.pomiarow = (info.pomiarow || 0) + 1;
info.wierszy = (info.wierszy || 0) + wiersze.length;
info.aktywa = aktywa.length;
info.dni = Math.max(1, Math.round((teraz - Date.parse(info.start)) / 86400000));
info.odstepMin = ODSTEP_MIN;
fs.writeFileSync(F_INFO, JSON.stringify(info, null, 2) + '\n', 'utf8');

log(
  `> kolektor: zapisano ${wiersze.length} wierszy (Jupiter ${zJup}, Binance ${zBin}) ` +
    `— lacznie ${info.wierszy} wierszy przez ${info.dni} dni`
);
