/**
 * HAJSOMAT — ile trejdów trzeba, żeby różnica przestała być przypadkiem.
 *
 * Po dziesięciu trejdach w tabeli prowadzi ten, kto miał szczęście. Po tysiącu —
 * ten, kto ma przewagę. Gdzieś pomiędzy jest granica i ten plik ją wylicza,
 * zamiast zostawiać ocenę oku.
 *
 * Porównujemy każdą strategię z małpą testem t Welcha — nie zakłada on, że obie
 * strony mają tę samą zmienność, a nie mają. Próg istotności dzielimy przez liczbę
 * porównań: przy czterech strategiach naraz jedna wygrywa "istotnie" samym trafem
 * znacznie częściej niż raz na dwadzieścia razy, jeśli tego nie uwzględnimy.
 *
 * SAMOTEST: `node istotnosc.mjs` puszcza to przez dane, których odpowiedź znamy
 * z góry — bo narzędziu do wykrywania złudzeń nie wolno wierzyć na słowo.
 */

export const MIN_TREJDOW = 10;   // ponizej tego nie ma o czym mowic
export const MOC = 0.8;          // szansa, ze wykryjemy roznice, jesli ona istnieje
export const ALFA = 0.05;

// Najmniejsza roznica, ktorej w ogole chcemy szukac — 0,2 odchylenia standardowego.
// To nie jest liczba wzieta z sufitu, tylko decyzja: jesli strategia bije malpe
// mniej niz o tyle, uznajemy, ze nie warto za tym gonic.
//
// Ta jedna stala robi cos wazniejszego, niz widac. Bez niej, gdy roznica wychodzi
// bliska zeru, "ile jeszcze trejdow" leci w nieskonczonosc i eksperyment nigdy sie
// nie konczy. Z nia jest sufit: okolo 560 trejdow na gracza. Po tylu wiemy albo ze
// przewaga jest, albo ze nie ma zadnej wartej zachodu. Jedno i drugie to odpowiedz.
export const D_MIN = 0.2;

/** Dystrybuanta rozkładu normalnego (Abramowitz–Stegun 26.2.17, błąd < 7,5e-8). */
export function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Odwrotność phi przez połowienie przedziału — wolna, ale nie da się w niej pomylić. */
export function zKwantyl(p) {
  let lo = -8, hi = 8;
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    if (phi(m) < p) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/** Średnia i wariancja z sum. Wariancja null, gdy próbka za mała. */
export function opis(st) {
  const n = st?.trejdy || 0;
  if (n < 2) return { n, srednia: n ? (st.sumaR || 0) / n : 0, wariancja: null };
  const srednia = (st.sumaR || 0) / n;
  const wariancja = Math.max(0, ((st.sumaR2 || 0) - n * srednia * srednia) / (n - 1));
  return { n, srednia, wariancja };
}

/**
 * Porównuje strategie z małpą. Jeden wiersz na strategię.
 * @param gracze   {id: {stats:{trejdy,sumaR,sumaR2}}}
 * @param defs     {id: {nazwa, nigdyNieZamykaj?}} — pomijamy tych, co nie zamykają
 * @param idMalpy  id gracza-punktu-odniesienia
 * @param porownan ile strategii testujemy naraz (poprawka Bonferroniego)
 */
export function istotnosc(gracze, defs, idMalpy, porownan) {
  const M = opis(gracze[idMalpy]?.stats);
  const alfaSkor = ALFA / Math.max(1, porownan);
  const zAlfa = zKwantyl(1 - alfaSkor / 2);
  const zBeta = zKwantyl(MOC);

  // Ile trejdow na strone trzeba, zeby roznice tej wielkosci wylapac na pewno:
  //   n = 2 (z_alfa + z_beta)^2 / d^2,   d = roznica w odchyleniach standardowych
  // Im wieksza roznica, tym mniej trejdow. Ale d nie schodzi ponizej D_MIN,
  // wiec liczba nigdy nie ucieka w nieskonczonosc.
  const ileTrzeba = (d) => Math.ceil((2 * (zAlfa + zBeta) ** 2) / Math.max(d, D_MIN) ** 2);

  return Object.keys(defs)
    // pozaTestem wylacza z porownan graczy, ktorych zwroty na trejd sa kopia innego
    // gracza (np. Krawiec = Trend z innym depozytem) — liczenie ich dwa razy tylko
    // zaostrzaloby prog Bonferroniego wszystkim, nie dodajac zadnej informacji.
    .filter((id) => id !== idMalpy && !defs[id].nigdyNieZamykaj && !defs[id].pozaTestem)
    .map((id) => {
      const A = opis(gracze[id]?.stats);
      const out = {
        id, nazwa: defs[id].nazwa,
        n: A.n, srednia: A.srednia, nMalpy: M.n, sredniaMalpy: M.srednia,
        roznica: A.srednia - M.srednia,
        d: null, t: null, p: null,
        nPotrzebne: ileTrzeba(0), postep: 0, werdykt: 'malo',
      };

      if (A.n < MIN_TREJDOW || M.n < MIN_TREJDOW || A.wariancja == null || M.wariancja == null) {
        out.postep = Math.min(1, A.n / out.nPotrzebne);
        return out;
      }

      const se = Math.sqrt(A.wariancja / A.n + M.wariancja / M.n);
      out.t = se > 0 ? out.roznica / se : 0;
      out.p = 2 * (1 - phi(Math.abs(out.t)));

      const sdWspolne = Math.sqrt((A.wariancja + M.wariancja) / 2);
      out.d = sdWspolne > 0 ? Math.abs(out.roznica) / sdWspolne : 0;
      out.nPotrzebne = ileTrzeba(out.d);
      out.postep = Math.min(1, A.n / out.nPotrzebne);

      if (out.p < alfaSkor) out.werdykt = out.roznica > 0 ? 'bije' : 'gorzej';
      else if (out.postep >= 1) out.werdykt = 'remis';  // zebralismy dosc, przewagi nie ma
      else out.werdykt = 'niewiadomo';
      return out;
    });
}

export const SLOWA = {
  malo: 'za mało danych',
  niewiadomo: 'jeszcze nie wiadomo',
  remis: 'brak przewagi wartej zachodu',
  bije: 'BIJE MAŁPĘ (istotnie)',
  gorzej: 'PRZEGRYWA z małpą (istotnie)',
};

// ─────────────────────────────────────────────────────────────────────────────
// Samotest — `node istotnosc.mjs`
//
// Puszczamy narzędzie przez dane, których odpowiedź znamy z góry. Jeśli nie zda
// tych trzech prób, każdy jego werdykt na prawdziwej lidze jest bezwartościowy.
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('istotnosc.mjs')) {
  const zielony = (ok) => (ok ? '  OK ' : ' BŁĄD');
  let bledy = 0;
  const sprawdz = (opis, ok, szczegol = '') => {
    if (!ok) bledy++;
    console.log(`${zielony(ok)}  ${opis}${szczegol ? `   ${szczegol}` : ''}`);
  };

  console.log('=== SAMOTEST ISTOTNOŚCI ===\n');

  // ── 1. Rozkład normalny zgadza się z tablicami ──
  console.log('1. Rozkład normalny — wartości z tablic statystycznych');
  sprawdz('phi(0) = 0,5', Math.abs(phi(0) - 0.5) < 1e-6, phi(0).toFixed(6));
  sprawdz('phi(1,96) = 0,975', Math.abs(phi(1.96) - 0.975) < 1e-4, phi(1.96).toFixed(6));
  sprawdz('phi(-2,576) = 0,005', Math.abs(phi(-2.576) - 0.005) < 1e-4, phi(-2.576).toFixed(6));
  sprawdz('zKwantyl(0,975) = 1,96', Math.abs(zKwantyl(0.975) - 1.959964) < 1e-4, zKwantyl(0.975).toFixed(6));
  sprawdz('zKwantyl(0,8) = 0,8416', Math.abs(zKwantyl(0.8) - 0.841621) < 1e-4, zKwantyl(0.8).toFixed(6));

  // ── 2. Średnia i wariancja z sum zgadzają się z liczeniem wprost ──
  console.log('\n2. Średnia i wariancja liczone z sum, nie z tablicy');
  const probka = [0.12, -0.31, 0.04, 0.55, -0.18, -1, 0.22];
  const st = probka.reduce((a, r) => ({ trejdy: a.trejdy + 1, sumaR: a.sumaR + r, sumaR2: a.sumaR2 + r * r }),
    { trejdy: 0, sumaR: 0, sumaR2: 0 });
  const wprost = probka.reduce((a, b) => a + b, 0) / probka.length;
  const warWprost = probka.reduce((a, b) => a + (b - wprost) ** 2, 0) / (probka.length - 1);
  const o = opis(st);
  sprawdz('średnia', Math.abs(o.srednia - wprost) < 1e-12, o.srednia.toFixed(8));
  sprawdz('wariancja', Math.abs(o.wariancja - warWprost) < 1e-12, o.wariancja.toFixed(8));

  // ── 3. Najważniejsze: jak często wykrywamy przewagę, której NIE MA ──
  //
  // To jest test samego narzędzia. Puszczamy 2000 lig, w których wszyscy gracze
  // są dokładnie tacy sami jak małpa — czysty los, zero przewagi. Poprawnie
  // działający test powinien ogłosić "BIJE" mniej więcej w 5% lig, bo taki
  // ustawiliśmy próg. Jeśli ogłasza znacznie częściej, cały ranking jest
  // maszyną do produkowania złudzeń.
  const los = (() => { let s = 20260727; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  const normalna = () => { // Box-Muller
    const u = Math.max(1e-12, los()), v = los();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const zbierz = (n, mu, sd) => {
    const s = { trejdy: 0, sumaR: 0, sumaR2: 0 };
    for (let i = 0; i < n; i++) { const r = mu + sd * normalna(); s.trejdy++; s.sumaR += r; s.sumaR2 += r * r; }
    return { stats: s };
  };
  const DEFS = { a: { nazwa: 'A' }, b: { nazwa: 'B' }, c: { nazwa: 'C' }, d: { nazwa: 'D' }, malpa: { nazwa: 'M' } };

  console.log('\n3. Fałszywe alarmy — 2000 lig, w których NIKT nie ma przewagi');
  const POWT = 2000, N = 300, SD = 0.25;
  let ligZFalszywym = 0, falszywychWierszy = 0;
  for (let i = 0; i < POWT; i++) {
    const g = { a: zbierz(N, 0, SD), b: zbierz(N, 0, SD), c: zbierz(N, 0, SD), d: zbierz(N, 0, SD), malpa: zbierz(N, 0, SD) };
    const w = istotnosc(g, DEFS, 'malpa', 4);
    const ile = w.filter((x) => x.werdykt === 'bije' || x.werdykt === 'gorzej').length;
    falszywychWierszy += ile;
    if (ile > 0) ligZFalszywym++;
  }
  const odsetekLig = ligZFalszywym / POWT;
  const odsetekWierszy = falszywychWierszy / (POWT * 4);
  sprawdz(`liga z choć jednym fałszywym alarmem ≤ 6%`, odsetekLig <= 0.06, `${(odsetekLig * 100).toFixed(2)}%`);
  sprawdz(`pojedynczy wiersz fałszywie istotny ≈ 1,25%`, odsetekWierszy < 0.02, `${(odsetekWierszy * 100).toFixed(2)}%`);

  // Dowód, ze poprawka faktycznie cos robi — ten sam los, prog niepodzielony.
  let bezPoprawki = 0;
  for (let i = 0; i < POWT; i++) {
    const g = { a: zbierz(N, 0, SD), b: zbierz(N, 0, SD), c: zbierz(N, 0, SD), d: zbierz(N, 0, SD), malpa: zbierz(N, 0, SD) };
    const w = istotnosc(g, DEFS, 'malpa', 1);
    if (w.some((x) => x.werdykt === 'bije' || x.werdykt === 'gorzej')) bezPoprawki++;
  }
  sprawdz('bez poprawki alarmów jest wyraźnie więcej', bezPoprawki / POWT > odsetekLig * 1.8,
    `${((bezPoprawki / POWT) * 100).toFixed(2)}% wobec ${(odsetekLig * 100).toFixed(2)}%`);

  // ── 4. I odwrotnie: czy wykrywamy przewagę, która JEST ──
  console.log('\n4. Wykrywalność — 500 lig, w których gracz A ma prawdziwą przewagę 0,2 SD');
  let trafione = 0;
  const POWT2 = 500;
  for (let i = 0; i < POWT2; i++) {
    const g = {
      a: zbierz(560, 0.2 * SD, SD),
      b: zbierz(560, 0, SD), c: zbierz(560, 0, SD), d: zbierz(560, 0, SD), malpa: zbierz(560, 0, SD),
    };
    const w = istotnosc(g, DEFS, 'malpa', 4);
    if (w.find((x) => x.id === 'a')?.werdykt === 'bije') trafione++;
  }
  const moc = trafione / POWT2;
  sprawdz(`wykryte w ≥ 70% lig (celowaliśmy w ${MOC * 100}%)`, moc >= 0.7, `${(moc * 100).toFixed(1)}%`);
  console.log('   (liczba trejdów wzięta z naszego własnego wzoru — to sprawdza i wzór, i test naraz)');

  // ── 5. Zdrowy rozsądek na krańcach ──
  console.log('\n5. Krańce');
  const pusty = { malpa: { stats: { trejdy: 0, sumaR: 0, sumaR2: 0 } }, a: { stats: { trejdy: 0, sumaR: 0, sumaR2: 0 } } };
  const w0 = istotnosc(pusty, { a: { nazwa: 'A' }, malpa: { nazwa: 'M' } }, 'malpa', 1);
  sprawdz('zero trejdów → "za mało danych", bez wysypki', w0[0].werdykt === 'malo' && Number.isFinite(w0[0].nPotrzebne),
    `nPotrzebne=${w0[0].nPotrzebne}`);
  const idealny = { malpa: zbierz(400, 0, SD), a: zbierz(400, 0, SD) };
  const w1 = istotnosc(idealny, { a: { nazwa: 'A' }, malpa: { nazwa: 'M' } }, 'malpa', 1);
  sprawdz('nPotrzebne nigdy nie ucieka w nieskończoność', w1[0].nPotrzebne <= 600, `${w1[0].nPotrzebne}`);
  sprawdz('gracz "nigdyNieZamykaj" wypada z porównania',
    istotnosc({ malpa: zbierz(50, 0, SD), byk: zbierz(0, 0, SD) },
      { byk: { nazwa: 'Byk', nigdyNieZamykaj: true }, malpa: { nazwa: 'M' } }, 'malpa', 1).length === 0);

  console.log(`\n${bledy === 0 ? '✓ WSZYSTKO ZDANE' : `✗ BŁĘDÓW: ${bledy}`}`);
  process.exit(bledy === 0 ? 0 : 1);
}
