#!/usr/bin/env node
/**
 * ODBIORNIK ODCZYTOW Z KOPARKI.
 *
 * Sluchа na serwerze i przyjmuje to, co przysyla Bitaxe z domu. Zapisuje
 * ostatni odczyt do `state/bitaxe.json`, skad zabierze go `run.sh` przy
 * najblizszym commicie — czyli w ciagu pieciu minut trafi na GitHuba i do apki.
 *
 * DLACZEGO TAK. Koparka siedzi za routerem i z internetu nikt do niej nie
 * dojdzie — ale polaczenia WYCHODZACE z domu przechodza bez zadnej
 * konfiguracji. Wystarczy wiec, ze zadzwoni sama. Serwer ma staly adres
 * publiczny, wiec zawsze wie, dokad.
 *
 * Konfiguracja (zmienne srodowiskowe):
 *   BITAXE_KLUCZ  — wspolny sekret, ten sam co w firmware koparki (wymagane)
 *   BITAXE_PORT   — port nasluchu, domyslnie 8787
 *
 * O BEZPIECZENSTWIE, uczciwie: to jest zwykly HTTP, wiec klucz jedzie przez
 * siec otwartym tekstem. Chroni przed przypadkowym skanerem, ktory znajdzie
 * otwarty port, a NIE przed kims, kto podsluchuje ruch. Uznajemy to za
 * wystarczajace, bo caly przesylany ladunek to moc obliczeniowa i temperatura
 * koparki — nie ma tu nic, co warto ukrywac, a klucz nie otwiera niczego
 * poza mozliwoscia nadpisania tego jednego pliku.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KORZEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLIK = path.join(KORZEN, 'state', 'bitaxe.json');
const PLIK_HIST = path.join(KORZEN, 'state', 'bitaxe-historia.json');

/*
 * Ile punktow historii trzymamy. 500 przy odczycie co minute to okolo osmiu
 * godzin, a przy zapisie co piec minut — prawie dwie doby. Plik wazy wtedy
 * jakies 40 kB, czyli tyle, ile apka i tak pobiera przy kazdym odswiezeniu.
 *
 * Historia zapisuje TYLKO to, co zmienia sie w czasie i po co sie na nia
 * patrzy: moc, temperatury, pobor i procent bledow. Adres portfela, model
 * ukladu i wersja firmware sa stale — trzymanie ich pieciuset razy byloby
 * marnowaniem miejsca w repozytorium.
 */
const HIST_MAX = 500;
const HIST_POLA = ['hashRate', 'temp', 'vrTemp', 'power', 'errorPercentage', 'bestDiff'];

const KLUCZ = process.env.BITAXE_KLUCZ?.trim();
const PORT = Number(process.env.BITAXE_PORT) || 8787;

// Najczestszy przyjmowany zapis. Koparka moze dzwonic czesciej — nadmiar
// odrzucamy tutaj, zeby nie mielic dysku i nie puchnac repozytorium.
const NAJCZESCIEJ_MS = 60000;
// Gorny limit ladunku. Odczyt to okolo kilobajta; wszystko powyzej to albo
// blad, albo ktos probuje wepchnac do repozytorium cos swojego.
const MAX_BAJTOW = 16 * 1024;

const log = (...a) => console.log(new Date().toISOString(), '[odbiornik]', ...a);

if (!KLUCZ) {
  log('brak BITAXE_KLUCZ — bez wspolnego sekretu nie uruchamiam sie');
  process.exit(1);
}

let ostatniZapis = 0;

/**
 * Przepisujemy TYLKO znane pola, zamiast zapisywac cokolwiek przyszlo.
 *
 * Gdyby isc na skroty i zrzucac cale przyslane JSON-y, kazdy, kto zna klucz,
 * moglby wsadzic do repozytorium dowolna tresc dowolnej wielkosci. Bialа
 * lista sprawia, ze najgorsze, co ktos moze zrobic, to sklamac o temperaturze.
 */
const POLA = [
  'hashRate', 'hashRate_1m', 'hashRate_10m', 'hashRate_1h', 'errorPercentage',
  'temp', 'temp2', 'vrTemp', 'power', 'voltage', 'current',
  'coreVoltage', 'coreVoltageActual', 'frequency',
  'fanspeed', 'fanrpm', 'fan2rpm', 'wifiRSSI',
  'sharesAccepted', 'sharesRejected', 'bestDiff', 'bestSessionDiff',
  'uptimeSeconds', 'ASICModel', 'boardVersion', 'version', 'hostname',
  'stratumURL', 'stratumUser',
];

function przesiej(zrodlo) {
  const wynik = {};
  for (const k of POLA) {
    const v = zrodlo[k];
    if (v === undefined || v === null) continue;
    // Tekst przycinamy — nazwa puli albo wersja nie ma prawa miec 10 kB.
    wynik[k] = typeof v === 'string' ? v.slice(0, 120) : v;
  }
  return wynik;
}

const serwer = http.createServer((req, res) => {
  const odpowiedz = (kod, tekst) => { res.writeHead(kod, { 'content-type': 'text/plain' }); res.end(tekst); };

  if (req.method !== 'POST' || !req.url.startsWith('/bitaxe')) return odpowiedz(404, 'nie tutaj');
  if (req.headers['x-klucz'] !== KLUCZ) {
    log(`odrzucone: zly klucz (${req.socket.remoteAddress})`);
    return odpowiedz(403, 'zly klucz');
  }

  /*
   * Zbieramy KAWALKI BAJTOW i sklejamy raz na koncu.
   *
   * Wczesniej bylo `dane += c`, czyli zamiana kazdego kawalka na tekst osobno.
   * Dla samych cyfr i nawiasow to dziala, ale wystarczy jeden znak spoza ASCII
   * na granicy kawalkow (nazwa puli, wersja firmware) i rozpada sie on na dwa
   * znaki zapytania. Blad, ktory pojawia sie raz na tysiac zadan i jest nie
   * do znalezienia.
   */
  const kawalki = [];
  let ile = 0;
  let zaDuzo = false;
  req.on('data', (c) => {
    if (zaDuzo) return;
    ile += c.length;
    if (ile > MAX_BAJTOW) { zaDuzo = true; req.destroy(); return; }
    kawalki.push(c);
  });

  req.on('end', () => {
    if (zaDuzo) { log('odrzucone: ladunek za duzy'); return odpowiedz(413, 'za duzo'); }

    let j;
    try {
      j = JSON.parse(Buffer.concat(kawalki).toString('utf8'));
    } catch { log('odrzucone: to nie jest JSON'); return odpowiedz(400, 'zly JSON'); }

    const teraz = Date.now();
    if (teraz - ostatniZapis < NAJCZESCIEJ_MS) {
      // Nie blad — koparka ma prawo dzwonic czesciej. Po prostu nie zapisujemy.
      return odpowiedz(200, 'za wczesnie, pomijam');
    }

    const info = przesiej(j);
    if (!Object.keys(info).length) { log('odrzucone: brak znanych pol'); return odpowiedz(400, 'pusto'); }

    try {
      // Zapis przez plik tymczasowy i podmiane nazwy: gdyby proces zginal
      // w polowie, `run.sh` nie zlapie w commicie polowy pliku. Ta sama
      // zasada, ktora stosuje bot przy swoim stanie.
      fs.mkdirSync(path.dirname(PLIK), { recursive: true });
      const tmp = `${PLIK}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pobrano: teraz, info }, null, 1));
      fs.renameSync(tmp, PLIK);

      // ── historia ────────────────────────────────────────────────────────
      let hist = [];
      try { hist = JSON.parse(fs.readFileSync(PLIK_HIST, 'utf8')); } catch { /* pierwszy raz */ }
      if (!Array.isArray(hist)) hist = [];
      const punkt = { ts: teraz };
      for (const k of HIST_POLA) if (Number.isFinite(Number(info[k]))) punkt[k] = Number(info[k]);
      hist.push(punkt);
      // Obcinamy od POCZATKU: najstarsze ida precz, najnowsze zostaja.
      if (hist.length > HIST_MAX) hist = hist.slice(hist.length - HIST_MAX);
      const tmpH = `${PLIK_HIST}.tmp`;
      fs.writeFileSync(tmpH, JSON.stringify(hist));
      fs.renameSync(tmpH, PLIK_HIST);

      ostatniZapis = teraz;
      const th = Number(info.hashRate) / 1000;
      log(`zapisane: ${Number.isFinite(th) ? th.toFixed(2) : '?'} TH/s, uklad ${info.temp ?? '?'}°C`);
      odpowiedz(200, 'ok');
    } catch (e) {
      log('nie udalo sie zapisac:', e.message);
      odpowiedz(500, 'blad zapisu');
    }
  });
});

/*
 * PORT JEST OTWARTY NA CALY INTERNET, wiec znajdzie go kazdy skaner.
 *
 * Sam klucz chroni przed ZAPISEM, ale nie przed samym zajmowaniem zasobow:
 * bez tych dwoch linijek ktos moglby otworzyc tysiac polaczen i zostawic je
 * wiszace. To nie jest atak wymagajacy pomyslowosci, tylko coś, co robia
 * automaty przeczesujace adresy.
 *
 * 20 jednoczesnych polaczen z zapasem wystarcza jednej koparce, a 10 sekund
 * bezczynnosci to duzo wiecej, niz potrzeba na wyslanie kilobajta.
 */
serwer.maxConnections = 20;
serwer.setTimeout(10000, (gniazdo) => gniazdo.destroy());

serwer.listen(PORT, () => log(`slucham na porcie ${PORT}, zapisuje do ${PLIK}`));
