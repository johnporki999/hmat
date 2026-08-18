#!/usr/bin/env node
/**
 * POWIADOMIENIA O KOPARCE.
 *
 * Trzy rzeczy warte wybudzenia telefonu, w kolejnosci od najrzadszej:
 *
 *   BLOK        — zdarzenie zycia. Statystycznie raz na kilkanascie tysiecy lat,
 *                 wiec jesli kiedykolwiek padnie, telefon ma o tym krzyknac.
 *   REKORD      — najtrudniejszy udzial, jaki koparka kiedykolwiek znalazla.
 *                 Jedyna miara postepu, jaka przy kopaniu solo w ogole istnieje.
 *   MILCZENIE   — brak odczytu przez dluzszy czas. Zanik pradu, padniete Wi-Fi
 *                 albo zawieszenie. NAJBARDZIEJ PRAKTYCZNE z calej trojki, bo
 *                 bez tego dowiesz sie dopiero, gdy sam zajrzysz do apki.
 *
 * Uruchamiane przez `run.sh` co piec minut, tuz obok `powiadom.mjs`.
 *
 * PIERWSZY PRZEBIEG NICZEGO NIE WYSYLA — zapisuje tylko znaczniki. Inaczej po
 * kazdej instalacji dostawaloby sie powiadomienie o "rekordzie", ktory stoi
 * tam od tygodni.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KORZEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KAT = path.join(KORZEN, 'state');
const ODCZYT = path.join(KAT, 'bitaxe.json');
const ZNACZNIKI = path.join(KAT, 'koparka-znaczniki.json');
const EXPO = 'https://exp.host/--/api/v2/push/send';

const log = (...a) => console.log('[koparka]', ...a);

const wlaczone = (nazwa) =>
  ['1', 'true', 'tak'].includes(String(process.env[nazwa] || '').trim().toLowerCase());

/**
 * Ustawienia z `deploy/.env`, gdy nie ma ich w srodowisku — ta sama sztuczka,
 * co w `powiadom.mjs`. Czytamy TYLKO potrzebne klucze; reszta pliku to sekrety
 * portfela i nie ma powodu, zeby trafialy do pamieci tego procesu.
 */
function zPliku() {
  const NASZE = ['EXPO_PUSH_TOKEN', 'KOPARKA_MILCZY_MIN'];
  if (NASZE.every((k) => process.env[k] !== undefined)) return;
  let tekst;
  try {
    tekst = fs.readFileSync(path.join(KORZEN, 'deploy', '.env'), 'utf8');
  } catch {
    return;
  }
  for (const linia of tekst.split(/\r?\n/)) {
    const m = linia.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m || !NASZE.includes(m[1]) || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

function czytaj(plik, gdyBrak) {
  try {
    return JSON.parse(fs.readFileSync(plik, 'utf8'));
  } catch {
    return gdyBrak;
  }
}

function zapisz(plik, dane) {
  // Zapis przez plik tymczasowy: gdyby proces zginal w polowie, przy nastepnym
  // przebiegu nie czytalibysmy polowy JSON-a i nie wyslalibysmy wszystkiego
  // od nowa jako "nowe".
  const tmp = `${plik}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(dane, null, 1));
  fs.renameSync(tmp, plik);
}

/** Duze liczby czytelnie: 41 200 000 → 41,2 M. */
function skrot(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  if (x >= 1e12) return `${(x / 1e12).toFixed(2)} T`;
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)} G`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(2)} M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)} k`;
  return String(Math.round(x));
}

async function wyslij(tokeny, wiadomosci) {
  if (!wiadomosci.length) return;
  if (wlaczone('POWIADOM_PROBA')) {
    for (const w of wiadomosci) log(`PROBA │ ${w.title} │ ${w.body}`);
    return;
  }
  const plaskie = tokeny.flatMap((to) => wiadomosci.map((w) => ({ to, sound: 'default', ...w })));
  for (let i = 0; i < plaskie.length; i += 100) {
    const paczka = plaskie.slice(i, i + 100);
    const r = await fetch(EXPO, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(paczka),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    const blad = (j?.data || []).filter((x) => x?.status === 'error');
    if (!r.ok || blad.length) {
      log(`odpowiedz Expo: ${r.status}, bledow ${blad.length}`, blad[0]?.message || '');
    }
  }
}

/** Czy odczyt jest juz przeterminowany — wspolne dla alarmu ciszy i „stoi". */
const milczyTeraz = (wiek, prog) => wiek != null && wiek > prog;

async function main() {
  zPliku();

  const tokeny = String(process.env.EXPO_PUSH_TOKEN || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  if (!tokeny.length) { log('brak EXPO_PUSH_TOKEN — nie wysylam'); return; }

  const odczyt = czytaj(ODCZYT, null);
  if (!odczyt?.info) { log('brak odczytu z koparki — nic do roboty'); return; }
  const i = odczyt.info;

  const stary = czytaj(ZNACZNIKI, null);
  const pierwszy = stary === null;
  const zn = stary || {};

  /*
   * Prog milczenia. Koparka odzywa sie co minute, a ten skrypt chodzi co piec,
   * wiec 20 minut to cztery przespane cykle — dosc, zeby nie alarmowac przy
   * pojedynczym zgubionym pakiecie, i malo, zeby zauwazyc zanik pradu tego
   * samego wieczoru.
   */
  const PROG_MS = (Number(process.env.KOPARKA_MILCZY_MIN) || 20) * 60000;

  const wiadomosci = [];
  const teraz = Date.now();
  const wiek = Number(odczyt.pobrano) ? teraz - Number(odczyt.pobrano) : null;

  // ── 1. BLOK ──────────────────────────────────────────────────────────────
  const blok = Number(i.blockFound) || 0;
  if (!pierwszy && blok > (Number(zn.blockFound) || 0)) {
    wiadomosci.push({
      title: '⛏️ BLOK ZNALEZIONY',
      body: 'Twoja koparka trafiła blok. Sprawdź portfel.',
    });
    log('BLOK ZNALEZIONY');
  }

  // ── 2. REKORD ────────────────────────────────────────────────────────────
  const rekord = Number(i.bestDiff);
  const poprzedni = Number(zn.bestDiff);
  if (!pierwszy && Number.isFinite(rekord) && Number.isFinite(poprzedni) && rekord > poprzedni) {
    /*
     * Ile brakuje do bloku. Trudnosc sieci bierzemy z odczytu, jesli koparka ja
     * przyslala; bez niej podajemy sam rekord, bo lepszy niepelny komunikat niz
     * zaden. Procent ma szesc miejsc, bo przy 1 TH/s wszystko powyzej trzech
     * bylo by zerem.
     */
    const D = Number(i.networkDifficulty);
    const ile = Number.isFinite(D) && D > 0 ? ` · ${((rekord / D) * 100).toFixed(6)}% trudności` : '';
    wiadomosci.push({
      title: `🎯 Nowy rekord: ${skrot(rekord)}`,
      body: `Poprzedni ${skrot(poprzedni)}${ile}`,
    });
    log(`rekord ${poprzedni} → ${rekord}`);
  }

  // ── 3. RESTART ───────────────────────────────────────────────────────────
  /*
   * Wykrywamy go po SPADKU czasu pracy, a nie po `resetReason` — ta ostatnia
   * mowi tylko, dlaczego bylo ostatnie uruchomienie, i wyglada tak samo przez
   * cala dobe po zdarzeniu. Spadek uptime jest jednoznaczny: cokolwiek sie
   * stalo, urzadzenie zaczelo liczyc od zera.
   *
   * Po co to wiedziec: restart, ktorego NIE spowodowales sam, znaczy zanik
   * pradu albo pad oprogramowania. Bez tego powiadomienia dowiesz sie o nim
   * tylko przypadkiem, patrzac na kafelek "pracuje".
   */
  /*
   * WYKRYWANIE PRZEZ PORoWNANIE Z UPLYWEM CZASU, a nie przez samo "uptime spadl".
   *
   * Prosty warunek `up < upStary` gubi restart, ktory zdarzyl sie tuz po
   * poprzednim. Przyklad z liczbami: ostatni odczyt mial uptime 60 s, koparka
   * padla, wstala i po 105 s przyslala uptime 60. 60 < 60 jest FALSZEM, wiec
   * awaria przeszlaby niezauwazona — a to wlasnie seria szybkich restartow
   * jest najgorszym objawem i tym, o ktorym najbardziej chce sie wiedziec.
   *
   * Poprawnie: czas pracy powinien rosnac dokladnie tyle, ile minelo miedzy
   * odczytami. Jesli urosl WYRAZNIE mniej, urzadzenie po drodze wstalo od zera.
   * Oba znaczniki czasu pochodzą z zegara serwera, wiec roznica jest rzetelna.
   *
   * Tolerancja 60 s: rozruch trwa kilkanascie sekund, a nasze zadanie czeka
   * minute przed pierwszym wyslaniem — kazdy prawdziwy restart gubi wiecej.
   */
  const up = Number(i.uptimeSeconds);
  const upStary = Number(zn.uptimeSeconds);
  const pobrano = Number(odczyt.pobrano);
  const pobranoStary = Number(zn.pobrano);
  const przerwa = Number.isFinite(pobrano) && Number.isFinite(pobranoStary)
    ? (pobrano - pobranoStary) / 1000
    : null;
  const zgubione = Number.isFinite(up) && Number.isFinite(upStary) && przerwa != null
    ? (upStary + przerwa) - up
    : null;
  if (!pierwszy && zgubione != null && zgubione > 60) {
    const powod = String(i.resetReason || '').toLowerCase();
    const ludzko = powod.includes('panic') || powod.includes('exception')
      ? 'awaria oprogramowania'
      : powod.includes('power')
        ? 'zanik zasilania'
        : powod.includes('software')
          ? 'restart programowy'
          : (i.resetReason || 'nieznany powód');
    wiadomosci.push({
      title: '🔄 Koparka się zrestartowała',
      body: `${ludzko} · chodziła ${Math.round(upStary / 60)} min`,
    });
    log(`restart: uptime ${upStary} -> ${up} przy przerwie ${Math.round(przerwa)} s`
      + ` (zgubione ${Math.round(zgubione)} s), powod: ${i.resetReason || '?'}`);
  }

  // ── 4. STOI, ALE SIE ODZYWA ──────────────────────────────────────────────
  /*
   * DZIURA, KTORA MILCZENIE PRZEPUSZCZA.
   *
   * Przy przegrzaniu firmware wywoluje `mining_stop()`, zapisuje `overheat_mode`
   * i CZEKA — ale ESP32 zyje dalej i nasze zadanie dalej wysyla odczyty.
   * Z punktu widzenia alarmu "milczenie" wszystko jest w porzadku: dane
   * przychodza co minute. Tyle ze w srodku stoi zero.
   *
   * To samo dotyczy zatrzymania recznego i awarii ukladu. Dlatego pytamy
   * wprost o moc obliczeniowa, a nie o to, czy przyszedl pakiet.
   *
   * Prog 1 GH/s, nie 0: przy starcie i przy ponownym rozruchu po schlodzeniu
   * moc bywa przez chwile ulamkowa, a nie dokladnie zerowa.
   */
  const moc = Number(i.hashRate);
  const stoi = Number.isFinite(moc) && moc < 1 && !milczyTeraz(wiek, PROG_MS);
  if (!pierwszy && stoi && !zn.stoi) {
    const t = Number(i.temp);
    const gorace = Number.isFinite(t) && t >= 70;
    wiadomosci.push({
      title: '🛑 Koparka stoi',
      body: gorace
        ? `Przegrzanie — ${t.toFixed(0)}°C. Sprawdź wentylator.`
        : 'Zero mocy, ale odczyty przychodzą. Sprawdź stan w apce.',
    });
    log(`stoi: hashRate ${moc}, temp ${i.temp}`);
  }
  if (!pierwszy && !stoi && zn.stoi) {
    wiadomosci.push({
      title: '✅ Koparka znowu kopie',
      body: `${(moc / 1000).toFixed(2)} TH/s · ${Number(i.temp).toFixed(0)}°C`,
    });
    log('znowu kopie');
  }

  // ── 5. MILCZENIE ─────────────────────────────────────────────────────────
  /*
   * Stan trzymamy w znacznikach, zeby wyslac DOKLADNIE JEDNO powiadomienie na
   * epizod. Bez tego przy dobie bez pradu przyszloby ich 288.
   */
  const milczy = milczyTeraz(wiek, PROG_MS);
  if (!pierwszy && milczy && !zn.milczy) {
    wiadomosci.push({
      title: '⚠️ Koparka milczy',
      body: `Brak odczytu od ${Math.round(wiek / 60000)} min. Prąd, Wi-Fi albo zawieszenie.`,
    });
    log(`milczy od ${Math.round(wiek / 60000)} min`);
  }
  if (!pierwszy && !milczy && zn.milczy) {
    wiadomosci.push({
      title: '✅ Koparka wróciła',
      body: `${(Number(i.hashRate) / 1000).toFixed(2)} TH/s · ${Number(i.temp).toFixed(0)}°C`,
    });
    log('koparka wrocila');
  }

  // ── zapis znacznikow ─────────────────────────────────────────────────────
  zapisz(ZNACZNIKI, {
    blockFound: blok,
    // Rekord tylko rosnie. Gdyby koparka po wyczyszczeniu ustawien przyslala
    // mniejszy, NIE cofamy znacznika — inaczej przy nastepnym wzroscie poszloby
    // powiadomienie o "rekordzie", ktory rekordem nie jest.
    bestDiff: Number.isFinite(rekord)
      ? Math.max(rekord, Number.isFinite(poprzedni) ? poprzedni : 0)
      : poprzedni,
    milczy,
    stoi,
    // Czas pracy zapisujemy ZAWSZE, takze przy pierwszym przebiegu — inaczej
    // pierwszy restart po instalacji przeszedlby niezauwazony.
    uptimeSeconds: Number.isFinite(up) ? up : null,
    // Czas POBRANIA odczytu, nie czas sprawdzenia — porownujemy uplyw miedzy
    // dwoma odczytami z koparki, a nie miedzy dwoma przebiegami tego skryptu.
    pobrano: Number.isFinite(pobrano) ? pobrano : null,
    sprawdzono: teraz,
  });

  if (pierwszy) { log('pierwszy przebieg — zapisalem znaczniki, nic nie wysylam'); return; }
  if (!wiadomosci.length) { log('nic nowego'); return; }

  await wyslij(tokeny, wiadomosci);
  log(`wyslane: ${wiadomosci.length}`);
}

main().catch((e) => { log('blad:', e?.message || e); process.exit(0); });
