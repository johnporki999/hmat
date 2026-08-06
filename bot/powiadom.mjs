#!/usr/bin/env node
/**
 * POWIADOMIENIA O ZAMKNIETYCH TREJDACH.
 *
 * Wolane przez `deploy/run.sh` po kazdym przebiegu botow. Czyta pliki trejdow,
 * znajduje zamkniecia, ktorych jeszcze nie zglosilismy, i wysyla je na telefon
 * przez usluge Expo.
 *
 * DLACZEGO TUTAJ, A NIE W APCE. Apka jest czytnikiem — odpala sie, gdy ktos ja
 * otworzy. Powiadomienie o trejdzie ma sens wtedy, gdy telefon lezy w kieszeni,
 * czyli dokladnie wtedy, gdy apka nie dziala. Jedyne miejsce, ktore wie o
 * zamknieciu w chwili zamkniecia, to maszyna, na ktorej chodzi bot.
 *
 * ZASADA, KTORA RZADZI CALYM PLIKIEM: to jest dodatek. Bot ma handlowac nawet
 * wtedy, gdy powiadomienia sa zepsute, nieskonfigurowane albo Expo lezy.
 * Dlatego kazdy blad konczy sie wpisem w logu i wyjsciem z kodem 0 — nigdy
 * wyjatkiem, ktory moglby przewrocic przebieg bota.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KORZEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KAT = path.join(KORZEN, 'state');
const ZNACZNIKI = path.join(KAT, 'powiadomienia.json');
const EXPO = 'https://exp.host/--/api/v2/push/send';

const log = (...a) => console.log('[powiadom]', ...a);

/**
 * Odczyt przelacznika ze zmiennej srodowiskowej — ODPORNY na spacje.
 *
 * W `cmd` na Windowsie zapis `set X=1 && node ...` wpisuje do zmiennej "1 ",
 * ze spacja na koncu, bo powloka bierze wszystko az do `&&`. Porownanie
 * `=== '1'` wtedy nie wychodzi i przelacznik po cichu nie dziala — a to
 * najgorszy rodzaj bledu, bo wyglada jak poprawne uruchomienie.
 */
const wlaczone = (nazwa) => ['1', 'true', 'tak'].includes(String(process.env[nazwa] || '').trim().toLowerCase());

/** Powody zamkniecia po ludzku — w plikach siedza jako identyfikatory. */
const POWODY = {
  'STOP LOSS': 'stop',
  'TRAILING STOP': 'stop kroczący',
  'TAKE PROFIT': 'cel',
  ZNIKNELA_Z_GIELDY: 'para zniknęła z giełdy',
};

/** Ludzkie nazwy botow — te same, ktore pokazuje apka. */
const NAZWY = {
  trend: 'Trend', antytrend: 'Antytrend', luzny: 'Luźny', smycz: 'Smycz',
  cierpliwy: 'Cierpliwy', czujny: 'Czujny', sjesta: 'Sjesta', sejsmograf: 'Sejsmograf',
  krawiec: 'Krawiec', kontra: 'Kontra', kontraN: 'Kontra równa', sito5: 'Sito 5',
  sitoOstre: 'Sito ostre', panika: 'Panika', panikaLuzna: 'Panika luźna',
  wybicie: 'Wybicie', malpa: 'Małpa', byk: 'Byk', realny: 'Bot realny',
};

/**
 * Ustawienia z `deploy/.env`, gdy nie ma ich w srodowisku.
 *
 * Normalnie skrypt odpala `run.sh`, ktory ten plik wczytuje sam. Ale czlowiek
 * uruchamiajacy `node powiadom.mjs` recznie — zeby sprawdzic konfiguracje albo
 * wyslac demo — dostawal "brak EXPO_PUSH_TOKEN", mimo ze token siedzial
 * w pliku obok. Komunikat byl prawdziwy i kompletnie mylacy.
 *
 * Czytamy TYLKO trzy potrzebne klucze. Reszta tego pliku to sekrety portfela
 * i nie ma powodu, zeby w ogole trafialy do pamieci tego procesu.
 */
function zPliku() {
  const NASZE = ['EXPO_PUSH_TOKEN', 'POWIADOM_MIN_ZL', 'USD_PLN'];
  if (NASZE.every((k) => process.env[k] !== undefined)) return;
  let tekst;
  try {
    tekst = fs.readFileSync(path.join(KORZEN, 'deploy', '.env'), 'utf8');
  } catch {
    return;                                   // brak pliku to nie blad
  }
  for (const linia of tekst.split(/\r?\n/)) {
    const m = linia.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m || !NASZE.includes(m[1]) || process.env[m[1]] !== undefined) continue;
    // Zdejmujemy cudzyslowy, jesli ktos je dopisal — powloka tez by je zdjela.
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

/**
 * Kurs dolara. Ten sam serwis, z ktorego korzysta apka — zeby kwota
 * w powiadomieniu zgadzala sie z kwota na ekranie.
 */
async function kursPln() {
  const zEnv = Number(process.env.USD_PLN);
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=PLN', {
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    if (Number.isFinite(j?.rates?.PLN)) return j.rates.PLN;
  } catch {
    /* zaraz sprobujemy z konfiguracji */
  }
  return Number.isFinite(zEnv) && zEnv > 0 ? zEnv : null;
}

const lb = (n, d = 2) =>
  n.toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });

function tresc(nazwa, t, fx) {
  const surowy = String(t.powod || t.reason || '');
  const proc = Number.isFinite(t.R) ? t.R * 100 : null;
  const usd = Number(t.pnlUsd) || 0;
  const znak = usd >= 0 ? '+' : '−';
  const kwota = fx ? `${znak}${lb(Math.abs(usd) * fx)} zł` : `${znak}${lb(Math.abs(usd))} USDC`;
  return {
    // Nazwa bota i procent w tytule, bo to widac na zablokowanym ekranie bez
    // rozwijania powiadomienia. Reszta schodzi do tresci.
    title: proc == null
      ? `${nazwa} ${kwota}`
      : `${nazwa} ${proc >= 0 ? '+' : '−'}${lb(Math.abs(proc), 1)}%`,
    body: [kwota, t.sym, POWODY[surowy] || surowy.toLowerCase() || null]
      .filter(Boolean)
      .join(' · '),
  };
}

async function wyslij(tokeny, wiadomosci) {
  // Proba na sucho: wypisuje, co POSZLOBY na telefon, i nie rusza sieci.
  // Sluzy do sprawdzenia ustawien bez zasypywania sie wiadomosciami.
  if (wlaczone('POWIADOM_PROBA')) {
    for (const w of wiadomosci) log(`PROBA │ ${w.title} │ ${w.body}`);
    return;
  }

  // Expo przyjmuje najwyzej 100 wiadomosci na zadanie.
  const paczki = [];
  const plaskie = tokeny.flatMap((to) => wiadomosci.map((w) => ({ to, sound: 'default', ...w })));
  for (let i = 0; i < plaskie.length; i += 100) paczki.push(plaskie.slice(i, i + 100));

  for (const paczka of paczki) {
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

async function main() {
  zPliku();

  const tokeny = String(process.env.EXPO_PUSH_TOKEN || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  if (!tokeny.length) {
    log('brak EXPO_PUSH_TOKEN (ani w srodowisku, ani w deploy/.env) — pomijam');
    return;
  }

  /*
   * TRYB DEMONSTRACYJNY: jedno powiadomienie na zadanie, zbudowane z wymyslonego
   * trejdu, ale przepuszczone przez te sama funkcje `tresc()` co prawdziwe.
   *
   * To jest wazne: gdyby demo sklejalo swoj wlasny napis, sprawdzaloby jedynie,
   * czy Expo dostarcza wiadomosci — a nie to, czy NASZE powiadomienia wygladaja
   * poprawnie. Tak sprawdza obie rzeczy naraz.
   *
   * Znacznikow NIE rusza. Wyslanie demo nie moze spowodowac, ze prawdziwy trejd
   * zostanie uznany za juz zgloszony.
   */
  if (wlaczone('POWIADOM_TEST')) {
    const fx = await kursPln();
    const udawany = {
      sym: 'JTO', pnlUsd: 0.52, R: 0.036, powod: 'TAKE PROFIT',
    };
    const w = tresc('Sito 5', udawany, fx);
    log(`demo → ${w.title} │ ${w.body}`);
    await wyslij(tokeny, [w]);
    log(`demo wyslane na ${tokeny.length} ${tokeny.length === 1 ? 'urzadzenie' : 'urzadzen'}`);
    return;
  }

  /*
   * PROG KWOTOWY. Domyslnie zero, czyli wszystko — tak, jak bylo zamowione.
   *
   * Zostawiam go widocznym, bo pomiar na czterech dniach danych mowi jasno:
   * przy zerze wychodzi 28,7 powiadomien dziennie, w wiekszosci o kwotach
   * ponizej zlotowki. Kto ustawi 1.00, dostanie 4,5 dziennie i tylko te
   * trejdy, o ktorych naprawde chce wiedziec.
   */
  const prog = Math.abs(Number(String(process.env.POWIADOM_MIN_ZL || '').trim()) || 0);

  const znaczniki = czytaj(ZNACZNIKI, {});
  const pierwszyRaz = !Object.keys(znaczniki).length;

  const pliki = fs
    .readdirSync(KAT)
    .filter((f) => f.endsWith('-trades.json'))
    /*
     * Tylko `stado-*`, czyli boty na PRAWDZIWYCH pieniadzach.
     *
     * Liga i backtesty robia setki zamkniec dziennie za wirtualne pieniadze —
     * telefon nie ma o czym brzeczec. Wypada tez `realny-*`: to STARY prefiks
     * bota Smycz sprzed przeniesienia do stada, a jego 20 zamkniec siedzi
     * takze w `stado-smycz-trades.json`. Sprawdzone: wszystkie 20 pokrywa sie
     * co do znacznika czasu i kwoty, wiec kazde poszloby na telefon dwa razy.
     */
    .filter((f) => f.startsWith('stado-'));

  const doWyslania = [];
  const nowe = { ...znaczniki };

  for (const plik of pliki) {
    const prefiks = plik.replace('-trades.json', '');
    const gracz = prefiks.replace(/^stado-/, '');
    const nazwa = NAZWY[gracz] || gracz;

    const trejdy = czytaj(path.join(KAT, plik), []);
    const zamkniecia = (Array.isArray(trejdy) ? trejdy : [])
      .filter((t) => (t.typ || t.type) === 'CLOSE' && t.ts)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    if (!zamkniecia.length) continue;

    const ostatni = znaczniki[prefiks] ? Date.parse(znaczniki[prefiks]) : 0;
    nowe[prefiks] = zamkniecia[zamkniecia.length - 1].ts;

    if (pierwszyRaz) continue;                    // patrz nizej
    for (const t of zamkniecia) {
      if (Date.parse(t.ts) > ostatni) doWyslania.push({ nazwa, t });
    }
  }

  /*
   * PIERWSZY PRZEBIEG NICZEGO NIE WYSYLA.
   *
   * Bez tego wlaczenie powiadomien konczyloby sie setka wiadomosci o trejdach
   * sprzed tygodni — a to jest ten rodzaj pierwszego wrazenia, po ktorym
   * czlowiek wylacza powiadomienia i nigdy ich nie wlacza z powrotem.
   * Zapisujemy wiec tylko, gdzie jestesmy, i zaczynamy zglaszac od nastepnego.
   */
  fs.writeFileSync(ZNACZNIKI, JSON.stringify(nowe, null, 2));
  if (pierwszyRaz) {
    log(`pierwszy przebieg — zapamietalem stan ${pliki.length} botow, nic nie wysylam`);
    return;
  }
  if (!doWyslania.length) return;

  // Najnowsze na koncu, zeby na ekranie blokady lezaly w kolejnosci zdarzen.
  doWyslania.sort((a, b) => Date.parse(a.t.ts) - Date.parse(b.t.ts));

  const fx = await kursPln();
  // Prog liczymy w zlotowkach, wiec bez kursu nie ma czego odsiewac.
  const doProgu = prog > 0 && fx
    ? doWyslania.filter(({ t }) => Math.abs((Number(t.pnlUsd) || 0) * fx) >= prog)
    : doWyslania;
  if (!doProgu.length) {
    log(`${doWyslania.length} zamkniec ponizej progu ${prog} zl — nic nie wysylam`);
    return;
  }

  const wiadomosci = doProgu.map(({ nazwa, t }) => tresc(nazwa, t, fx));
  await wyslij(tokeny, wiadomosci);
  log(`wyslane: ${wiadomosci.length} na ${tokeny.length} ${tokeny.length === 1 ? 'urzadzenie' : 'urzadzen'}`);
}

main().catch((e) => {
  // Powiadomienia nie moga przewrocic przebiegu bota — to tylko dodatek.
  log('blad:', e?.message || e);
});
