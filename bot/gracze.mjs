/**
 * HAJSOMAT — definicje graczy ligi.
 *
 * Ten plik istnieje po to, zeby liga na zywo (liga.mjs) i test na historii
 * (ligahist.mjs) uzywaly DOKLADNIE tych samych graczy — a nie dwoch kopii, ktore
 * po miesiacu cichutko sie rozjada. Bez tego test historyczny sprawdzalby cos
 * innego niz to, co faktycznie chodzi na serwerze, i jego wynik bylby bezwartosciowy.
 *
 * Dwie rzeczy sa tu sparametryzowane, bo w tescie musza dzialac inaczej niz na zywo:
 *
 *   los()      — malpa na zywo rzuca Math.random(), a w tescie generatorem z ziarnem,
 *                zeby ten sam przebieg dawal ten sam wynik.
 *   terazMs    — na zywo to Date.now(), w tescie czas swiecy. Bez tego stop czasowy
 *                nigdy by nie zadzialal na historii.
 */

import { CFG, entrySignal, shortSignal, envNum } from './strategy.mjs';

/**
 * Sygnał bota kontraktowego. Zwraca {kier, powod} albo null.
 *
 * Każdy gracz musi umieć powiedzieć, CO go wywołało — inaczej za pół roku będziemy
 * mieli tabelę wyników bez żadnej informacji, dlaczego wyszła właśnie taka.
 */
export const sygnalTrendu = (sym, m, c) => {
  const L = entrySignal(sym, m, CFG, {});
  if (L.enter) return { kier: 'LONG', powod: L.reason, score: L.score };

  // Short leci przez TEN SAM shortSignal, ktorego uzywa bot kontraktowy.
  //
  // Wczesniej bylo tu recznie napisane "lustro": cztery surowe warunki BEZ progu
  // punktowego. Skutek byl powazny — 78% trejdow gracza Trend to shorty, wiec
  // prawie cala liga mierzyla strategie LUZNIEJSZA niz ta, ktora naprawde chodzi
  // na serwerze. Podnoszenie MIN_SCORE nie zmienialo liczby trejdow ani o jeden,
  // co wlasnie zdradzilo blad.
  const S = shortSignal(sym, m, CFG);
  if (S.enter) return { kier: 'SHORT', powod: S.reason, score: S.score };
  return null;
};

/**
 * Prognoza gracza w chwili wejscia — LICZBY zapisane PRZED wynikiem.
 *
 * Kazdy gracz ligi ma te same wyjscia, wiec kazdy skladajac pozycje "obiecuje"
 * to samo: zlapanie ruchu do wysokosci take profitu. Zapisujemy te obietnice
 * razem z kosztem rundy, bo bez utrwalonej prognozy kazda strate da sie po
 * fakcie opowiedziec jako "przeciez bylo widac" — a z nia bot/dlaczego.mjs
 * odroznia "zle ocenilismy" od "ocenilismy dobrze, wyszlo inaczej".
 */
export const prognozaWejscia = (m, oplataRundy, score = null) => ({
  spodziewanyRuch: +((CFG.TAKE_PROFIT_ATR * m.atr) / m.price).toFixed(5),
  koszt: +oplataRundy.toFixed(5),
  score,
});

/** Zwraca {kier:'LONG'|'SHORT', powod} albo null. */
export const stworzGraczy = ({ malpaSzansa = 0.06, los = Math.random } = {}) => ({
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
  // na trejd wobec -0,017% obecnych zasad, dodatnio na obu probkach. To byl najlepszy
  // wynik ze wszystkich 16 przetestowanych wariantow wyjscia.
  //
  // UWAGA — TEN WYNIK SIE NIE POTWIERDZIL.
  //
  // Druga symulacja (bot/ligahist.mjs), na tych samych swiecach, ale z pelna mechanika
  // ligi, daje Smyczy -0,13% na trejd, czyli mniej wiecej tyle co zwyklemu Trendowi.
  // Szukalem przyczyny rozbieznosci i wykluczylem trzy:
  //
  //   1. uruchamianie stopow wewnatrz swiecy zamiast na zamknieciu  — nie to
  //   2. konkurencje o wolne miejsca na pozycje                     — nie to
  //   3. liczenie szczytu pozycji z maksimum swiecy zamiast z zamkniec — nie to
  //
  // Co ciekawe, obie symulacje zgadzaja sie co do WERSJI PODSTAWOWEJ (Trend), a rozjezdzaja
  // tylko na ciasnym trailingu. Czyli roznica siedzi gdzies w symulowaniu samej smyczy.
  //
  // Wniosek na dzis: odkrycie o trailingu jest KRUCHE i nie wolno na nim niczego opierac.
  // Dlatego Smycz zostaje w lidze — rozstrzygnie to rzeczywistosc, nie kolejna symulacja.
  smycz: {
    nazwa: 'Smycz',
    opis: 'te same wejscia co Trend, ale trailing 0,5 ATR zamiast 2,0',
    wejscie: sygnalTrendu,
    trailAtr: 0.5,
  },

  // Te same wejscia co Trend, te same wyjscia — tylko nie wolno mu zamknac pozycji
  // przed uplywem 12 godzin.
  //
  // Skad pomysl: koszt rundy jest staly, wiec liczy sie, ile ruchu ceny przypada
  // na ta sama oplate. Pomiar z 5 lat (bot/wyjscia.mjs):
  //
  //   trzymanie  2h -> lacznie  -9427%   (88 935 trejdow)
  //   trzymanie  3h ->          -1040%   (61 204, czyli obecne zasady)
  //   trzymanie 36h ->             -6%   ( 6 232)
  //
  // Roznica miedzy ruina a zerem, i to bez dotykania sygnalu. Za slaba statystycznie,
  // zeby na niej polegac, ale mechanizm jest arytmetyczny, nie statystyczny: stala
  // oplata podzielona przez wiekszy ruch to mniejszy udzial kosztu.
  //
  // Ryzyko jest realne i trzeba je nazwac: przez 12 godzin pozycja idzie bez stopa,
  // wiec moze dojechac do likwidacji. Wlasnie po to jest ten gracz — zeby zobaczyc,
  // czy oszczednosc na oplatach przewyzsza koszt kilku takich wypadkow.
  cierpliwy: {
    nazwa: 'Cierpliwy',
    opis: 'te same wejscia co Trend, ale nie zamyka nic przed uplywem 12 godzin',
    wejscie: sygnalTrendu,
    // Da sie przestawic zmienna MIN_GODZIN — sluzy do sprawdzenia, czy 12 to
    // prawdziwy mechanizm, czy szczesliwa liczba dopasowana do tej historii.
    minGodzin: envNum('MIN_GODZIN', 12),
  },

  // Cierpliwy z dzialajacym stopem. Rozni ich JEDNA flaga.
  //
  // Cierpliwy dostal dwie zmiany naraz — trzyma dluzej I nie ma stopa przez ten czas.
  // To dwa rozne pomysly sklejone w jednego gracza, wiec z jego wyniku nie da sie
  // odczytac, ktory z nich zadzialal. Czujny je rozdziela:
  //
  //   Czujny wypada tak samo dobrze -> liczy sie sama cierpliwosc
  //   Czujny wypada gorzej          -> to stop loss szkodzil, i to jest wieksze odkrycie
  //   Czujny wypada lepiej          -> stop pomaga, a Cierpliwy mial szczescie
  //
  // Wersja z dzialajacym stopem jest tez znacznie bezpieczniejsza w prawdziwym
  // handlu — Cierpliwy zaliczyl 8 likwidacji, osiem razy wiecej niz ktokolwiek inny.
  czujny: {
    nazwa: 'Czujny',
    opis: 'jak Cierpliwy, ale stop loss dziala normalnie przez caly czas',
    wejscie: sygnalTrendu,
    minGodzin: envNum('MIN_GODZIN', 12),
    stopZawsze: true,
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
      if (los() >= malpaSzansa) return null;
      return { kier: los() < 0.5 ? 'LONG' : 'SHORT', powod: 'rzut monetą — żadnego powodu' };
    },
  },

  byk: {
    nazwa: 'Byk',
    opis: 'kupuje SOL i nigdy nie sprzedaje',
    wejscie: (sym) => (sym === 'SOL' ? { kier: 'LONG', powod: 'kupuję SOL i nie sprzedaję' } : null),
    nigdyNieZamykaj: true,
  },
});
/**
 * Cena, przy ktorej gielda zamyka pozycje.
 * liqAt = jaka czesc depozytu przepada (0,9 = tracimy 90% i wylatujemy).
 */
export const liqPrice = (side, entry, lev, liqAt) =>
  side === 'LONG' ? entry * (1 - liqAt / lev) : entry * (1 + liqAt / lev);

export const pnlAt = (p, px) =>
  p.side === 'LONG' ? p.qty * (px - p.entryPrice) : p.qty * (p.entryPrice - px);

/**
 * Czy zamykac pozycje. Zwraca powod albo null.
 * Identyczne dla wszystkich graczy — to jest warunek sensownosci calej ligi.
 */
export function czyWyjsc(p, atr, px, terazMs, swieca = null) {
  const long = p.side === 'LONG';
  const a = p.atrAtEntry || atr;
  const heldH = (terazMs - Date.parse(p.entryTs)) / 3600000;

  // Na zywo bot widzi tylko biezaca cene i tak tez liczy sie domyslnie (swieca = null).
  //
  // W tescie historycznym mozna podac cala swiece i wtedy stop sprawdzamy tez wobec
  // jej maksimum i minimum. Roznica nie jest kosmetyczna: przy ciasnym trailingu
  // decyduje o tym, czy pozycja wychodzi w punkcie, czy dopiero na zamknieciu swiecy.
  const dolCeny = swieca ? swieca.l : px;
  const goraCeny = swieca ? swieca.h : px;
  const wStop = long ? dolCeny <= p.stopPrice : goraCeny >= p.stopPrice;

  // Gracze z minimalnym czasem trzymania nie zamykaja nic przed jego uplywem.
  //
  // Koszt rundy jest STALY (0,12% wartosci pozycji), wiec przy trzymaniu 2 godzin
  // oplata zjada 42% typowego ruchu ceny w tym czasie, a przy 36 godzinach tylko 2%.
  // Zamkniecie po godzinie oznacza zaplacenie pelnej oplaty za ruch, ktory nie zdazyl
  // sie wydarzyc.
  //
  // Roznica miedzy dwoma graczami siedzi w jednej fladze:
  //   Cierpliwy (stopZawsze = false) — blokuje TAKZE stop loss
  //   Czujny    (stopZawsze = true)  — stop dziala normalnie, reszta czeka
  //
  // To rozdziela dwa pytania, ktore latwo pomylic: czy pomaga sama cierpliwosc,
  // czy raczej to, ze stop nie wyrzuca pozycji przedwczesnie.
  //
  // Likwidacji nie blokuje nikt — to nie jest nasza decyzja, gielda zamyka pozycje
  // sama. Sprawdzana jest poza ta funkcja i dziala zawsze.
  if (p.minGodzin && heldH < p.minGodzin) {
    if (p.stopZawsze && wStop) return 'STOP LOSS';
    return null;
  }

  // Na zywo bot widzi tylko biezaca cene i tak tez liczy sie domyslnie (swieca = null).
  //
  // W tescie historycznym mozna podac cala swiece i wtedy stop sprawdzamy tez wobec
  // jej maksimum i minimum. Roznica nie jest kosmetyczna: przy ciasnym trailingu
  // decyduje o tym, czy pozycja wychodzi w punkcie, czy dopiero na zamknieciu swiecy.
  // Dwa nasze narzedzia dawaly sprzeczne wyniki dla gracza Smycz wlasnie z tego powodu.
  if (wStop) return 'STOP LOSS';
  if (long ? goraCeny >= p.takeProfit : dolCeny <= p.takeProfit) return 'TAKE PROFIT';
  if (p.trailArmed) {
    // Dlugosc smyczy zapisujemy przy pozycji, bo gracz Smycz ma wlasna.
    const dl = p.trailAtr ?? CFG.TRAIL_ATR;
    const tr = long ? p.bestPrice - dl * a : p.bestPrice + dl * a;
    if (long ? px <= tr : px >= tr) return 'TRAILING STOP';
  }
  if (heldH > CFG.MAX_HOLD_HOURS && (long ? px < p.entryPrice : px > p.entryPrice)) return 'stop czasowy';
  return null;
}
