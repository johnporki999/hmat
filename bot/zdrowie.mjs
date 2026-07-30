/**
 * HAJSOMAT — kontrola zdrowia eksperymentu. Jedna komenda raz w tygodniu.
 *
 * Po co: najgrozniejszy blad tego projektu nie byl bledem w strategii, tylko
 * CICHA AWARIA DANYCH. Binance oddawal 451 przez dwa dni, kolektor zapisywal
 * pustki, a tabela wygladala normalnie. Zaden test statystyczny tego nie
 * zlapie — trzeba pytac wprost.
 *
 * Sprawdza szesc rzeczy i przy kazdej mowi OK / UWAGA / ALARM:
 *   1. czy liga w ogole chodzi (swiezosc stanu),
 *   2. czy kazdy zarejestrowany gracz istnieje w stanie i handluje,
 *   3. czy czujnik BTC Sejsmografa naprawde czyta ceny,
 *   4. czy kolektor zbiera bez dziur (H1 i H2 zaleza wylacznie od tego),
 *   5. ile jeszcze trzeba czekac na werdykt kazdego gracza,
 *   6. czy ktos obsuwa sie glebiej, niz przewidywalo Monte Carlo.
 *
 * Nic nie zmienia — tylko czyta i mowi.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stworzGraczy } from './gracze.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(path.resolve(__dirname, '..'), 'state');
const czytaj = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return d; } };

const H = 3600000, DOBA = 86400000;
let alarmy = 0, uwagi = 0;
const OK = (s) => console.log(`  \x1b[32mOK\x1b[0m     ${s}`);
const UWAGA = (s) => { uwagi++; console.log(`  \x1b[33mUWAGA\x1b[0m  ${s}`); };
const ALARM = (s) => { alarmy++; console.log(`  \x1b[31mALARM\x1b[0m  ${s}`); };
const godz = (ms) => `${(ms / H).toFixed(1)} h`;

console.log('=== KONTROLA ZDROWIA HAJSOMATU ===\n');

const stan = czytaj('liga-state.json', null);
const gracze = stworzGraczy({});
const teraz = Date.now();

// ── 1. czy liga chodzi ───────────────────────────────────────────────────────
console.log('1. Czy liga chodzi');
if (!stan) {
  ALARM('brak state/liga-state.json — liga nigdy nie wystartowala albo stan zniknal');
} else {
  const ost = Date.parse(stan.lastRun?.ts || 0);
  const wiek = teraz - ost;
  if (!ost) ALARM('stan nie ma znacznika ostatniego przebiegu');
  else if (wiek > 2 * H) ALARM(`ostatni przebieg ${godz(wiek)} temu — cron stoi (ma chodzic co 5 minut)`);
  else if (wiek > 30 * 60000) UWAGA(`ostatni przebieg ${godz(wiek)} temu — dluzej niz zwykle`);
  else OK(`ostatni przebieg ${(wiek / 60000).toFixed(0)} min temu`);
  const dni = (teraz - Date.parse(stan.createdAt)) / DOBA;
  OK(`liga zyje ${dni.toFixed(1)} dni, graczy w stanie: ${Object.keys(stan.gracze || {}).length}`);
}

// ── 2. gracze ────────────────────────────────────────────────────────────────
console.log('\n2. Czy wszyscy gracze grają');
const dni = stan ? (teraz - Date.parse(stan.createdAt)) / DOBA : 0;
for (const [id, def] of Object.entries(gracze)) {
  const g = stan?.gracze?.[id];
  if (!g) {
    if (stan?.sejsmo) ALARM(`${def.nazwa}: brak w stanie mimo dzialajacej nowej wersji — nie zostal dopisany`);
    else UWAGA(`${def.nazwa}: brak w stanie — serwer jeszcze nie pobral nowego kodu (dopisze sie sam)`);
    continue;
  }
  const n = g.stats?.trejdy || 0;
  const otw = Object.keys(g.positions || {}).length;
  if (def.nigdyNieZamykaj) { OK(`${def.nazwa}: ${otw} pozycji (z zalozenia nie zamyka)`); continue; }
  // Brak gracza w stanie znaczy co innego przed i po wdrozeniu nowego kodu.
  // Odczyt sejsmografu jest znacznikiem: jesli jest, serwer JUZ chodzi na
  // nowej wersji, wiec brak gracza to prawdziwa awaria, a nie oczekiwanie.
  if (n === 0 && otw === 0 && dni > 2) ALARM(`${def.nazwa}: 0 trejdow i 0 pozycji po ${dni.toFixed(1)} dniach — cos blokuje wejscia`);
  else if (n === 0 && dni > 2) UWAGA(`${def.nazwa}: jeszcze zadnego zamknietego trejdu (${otw} otwartych)`);
  else OK(`${def.nazwa}: ${n} trejdow, ${otw} otwartych`);
}

// ── 3. czujnik BTC ───────────────────────────────────────────────────────────
console.log('\n3. Czujnik BTC Sejsmografa');
const s = stan?.sejsmo;
if (!s) UWAGA('brak odczytu w stanie — serwer jeszcze nie ruszyl z nowa wersja liga.mjs');
else {
  const wiek = teraz - Date.parse(s.ts);
  if (s.blad) ALARM(`czujnik nie czyta cen BTC (${s.blad}) — Sejsmograf gra jak zwykly Cierpliwy, jego wynik jest bez wartosci`);
  else if (wiek > 2 * H) ALARM(`ostatni odczyt ${godz(wiek)} temu`);
  else OK(`BTC ${(s.doba * 100).toFixed(2)}% na dobe, prog ${(s.prog * 100).toFixed(0)}% — ${s.cisza ? 'CISZA' : 'spokoj'}`);
}

// ── 4. kolektor (H1 i H2 stoja wylacznie na tym) ─────────────────────────────
console.log('\n4. Kolektor danych spoza wykresu');
const info = czytaj('dane-info.json', null);
if (!info) ALARM('brak dane-info.json — kolektor nie zapisal nic');
else {
  const wiek = teraz - info.ostatni;
  if (wiek > 3 * H) ALARM(`ostatnia probka ${godz(wiek)} temu — kolektor stoi`);
  else if (wiek > 1 * H) UWAGA(`ostatnia probka ${godz(wiek)} temu`);
  else OK(`ostatnia probka ${(wiek / 60000).toFixed(0)} min temu, ${info.pomiarow} pomiarow, ${info.aktywa} aktywow`);
  // dziury: ile probek powinno byc wobec tego, ile jest
  const powinno = Math.floor((info.ostatni - Date.parse(info.start)) / (info.odstepMin * 60000));
  const brak = powinno - info.pomiarow;
  const procBrak = powinno > 0 ? brak / powinno : 0;
  if (procBrak > 0.2) ALARM(`brakuje ${brak} z ${powinno} probek (${(procBrak * 100).toFixed(0)}%) — to podkopuje H1 i H2`);
  else if (procBrak > 0.05) UWAGA(`brakuje ${brak} z ${powinno} probek (${(procBrak * 100).toFixed(0)}%)`);
  else OK(`kompletnosc probek ${((1 - procBrak) * 100).toFixed(0)}%`);
  // czy pliki dzienne rosna
  try {
    const pliki = fs.readdirSync(path.join(DIR, 'dane')).filter((f) => f.endsWith('.jsonl')).sort();
    const dzis = pliki[pliki.length - 1];
    const wierszy = fs.readFileSync(path.join(DIR, 'dane', dzis), 'utf8').trim().split('\n').length;
    if (wierszy < 5) ALARM(`dzisiejszy plik ${dzis} ma tylko ${wierszy} wierszy`);
    else OK(`${pliki.length} plikow dziennych, dzis ${wierszy} wierszy`);
  } catch { UWAGA('nie moge policzyc plikow dziennych'); }
}

// ── 5. kiedy poznamy odpowiedz ───────────────────────────────────────────────
console.log('\n5. Ile jeszcze do werdyktu');
const testy = stan?.lastRun?.ranking?.[0] ? stan.lastRun.istotnosc?.testy : null;
if (!testy) UWAGA('brak sekcji istotnosci w stanie');
else {
  // tempo z historii symulacji, gdy gracz ma za malo wlasnych trejdow
  const hist = { trend: 29487, antytrend: 28763, luzny: 18570, smycz: 45132, cierpliwy: 10750,
    czujny: 17611, sjesta: 8303, sejsmograf: 8344, kontra: 19707, kontraN: 9467, sito5: 3363, wybicie: 29218 };
  const tempoTrendu = (stan.gracze.trend?.stats?.trejdy || 0) / Math.max(dni, 0.1);
  const wiersze = testy.map((t) => {
    const n = t.n || 0;
    // Wlasne tempo zawsze, gdy jest z czego liczyc. Proporcja historyczna
    // zawyzala Cierpliwemu tempo czterokrotnie: w symulacji nie konkurowal
    // o cztery miejsca na pozycje, a na zywo trzyma je po kilkanascie godzin.
    const tempo = n >= 8 ? n / dni : (hist[t.id] ? (tempoTrendu * hist[t.id]) / hist.trend : n / dni);
    const brak = Math.max(0, (t.nPotrzebne || 677) - n);
    return { nazwa: t.nazwa, n, potrzeba: t.nPotrzebne || 677, tempo, dni: tempo > 0 ? brak / tempo : Infinity, szac: n < 8 };
  }).sort((a, b) => a.dni - b.dni);
  console.log(`     ${'gracz'.padEnd(14)}${'trejdow'.padStart(9)}${'potrzeba'.padStart(10)}${'tempo/dobe'.padStart(12)}${'zostalo'.padStart(18)}`);
  for (const w of wiersze) {
    const kiedy = w.dni < 1 ? 'juz teraz' : w.dni < 45 ? `${Math.ceil(w.dni)} dni` : `${(w.dni / 30.4).toFixed(1)} mies.`;
    console.log(`     ${w.nazwa.padEnd(14)}${String(w.n).padStart(9)}${String(w.potrzeba).padStart(10)}`
      + `${w.tempo.toFixed(1).padStart(12)}${(kiedy + (w.szac ? ' (szac.)' : '')).padStart(18)}`);
  }
}

// ── 6. obsuniecia ────────────────────────────────────────────────────────────
console.log('\n6. Obsunięcia wobec Monte Carlo');
const PROGI = { trend: [0.47, 0.56], antytrend: [0.51, 0.57], luzny: [0.51, 0.59], smycz: [0.44, 0.54],
  cierpliwy: [0.52, 0.65], czujny: [0.50, 0.59], sjesta: [0.50, 0.65], sejsmograf: [0.52, 0.65],
  kontra: [0.50, 0.59], kontraN: [0.50, 0.59], sito5: [0.51, 0.64], wybicie: [0.50, 0.56], malpa: [0.50, 0.56] };
const eq = czytaj('liga-equity.json', []);
if (!eq.length) UWAGA('brak krzywej kapitalu');
else {
  // Wpis krzywej to {ts, gracz: kapital, ...} — klucze graczy leza wprost obok ts.
  const szczyty = {}, ddMax = {};
  for (const w of eq) {
    for (const [id, kap] of Object.entries(w)) {
      if (id === 'ts' || typeof kap !== 'number') continue;
      szczyty[id] = Math.max(szczyty[id] ?? kap, kap);
      ddMax[id] = Math.max(ddMax[id] ?? 0, 1 - kap / szczyty[id]);
    }
  }
  let cos = false;
  for (const [id, dd] of Object.entries(ddMax).sort((a, b) => b[1] - a[1])) {
    const [typowe, alarm] = PROGI[id] || [0.5, 0.6];
    if (dd > alarm) { ALARM(`${id}: obsuniecie ${(dd * 100).toFixed(0)}% ponad prog alarmowy ${(alarm * 100).toFixed(0)}% — cos sie zmienilo wobec historii`); cos = true; }
    else if (dd > typowe) { UWAGA(`${id}: obsuniecie ${(dd * 100).toFixed(0)}% powyzej typowego ${(typowe * 100).toFixed(0)}%`); cos = true; }
  }
  if (!cos) OK(`najglebsze obsuniecie ${(Math.max(...Object.values(ddMax)) * 100).toFixed(0)}% — wszyscy w normie Monte Carlo`);
}

// ── podsumowanie ─────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
if (alarmy) console.log(`\x1b[31mALARMOW: ${alarmy}\x1b[0m, uwag: ${uwagi} — zajrzyj wyzej, zanim uwierzysz w tabele.`);
else if (uwagi) console.log(`Alarmow brak, uwag: ${uwagi}. Eksperyment zdrowy.`);
else console.log('\x1b[32mWszystko zdrowe.\x1b[0m Dane sa warte tyle, ile mysllimy.');
console.log('='.repeat(60));
