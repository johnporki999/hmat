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
 * Ksztalt swiecy decyzji, znormalizowany do kierunku trejdu.
 *
 * Te same dwie liczby, ktore liczy laboratorium (kat 9, NAZWY_CECH). Sa tu
 * przepisane CELOWO, tak samo jak przygotujAktywo w realny.mjs: laboratorium
 * siedzi w bot/laboratorium.mjs, ktory na serwerze jest, ale importowanie
 * narzedzia badawczego do sciezki decyzyjnej bota bylo by zaproszeniem do tego,
 * zeby zmiana w badaniu po cichu zmienila zachowanie handlu.
 *
 *   knotZa     — knot po NASZEJ stronie, jako czesc zakresu swiecy.
 *                Duzy = rynek probowal isc przeciw nam i zostal odrzucony.
 *   zamkniecie — gdzie swieca zamknela sie w swoim zakresie, liczac od naszej
 *                strony. 1 = zamkniecie na naszym koncu, 0 = na przeciwnym.
 *
 * Zwraca null, gdy swieca nie ma zakresu (zdarza sie na martwych rynkach).
 */
export function ksztaltSwiecy(swieca, long) {
  if (!swieca) return null;
  const zakres = swieca.h - swieca.l;
  if (!(zakres > 0)) return null;
  const gora = swieca.h - Math.max(swieca.o, swieca.c);
  const dol = Math.min(swieca.o, swieca.c) - swieca.l;
  return {
    knotZa: (long ? dol : gora) / zakres,
    zamkniecie: (long ? swieca.c - swieca.l : swieca.h - swieca.c) / zakres,
  };
}

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

  // Smycz z JEDNYM dodatkowym warunkiem: nie wchodzi, gdy swieca decyzji ma
  // maly knot po naszej stronie ORAZ zamknela sie daleko od naszego konca.
  //
  // Skad progi: laboratorium, kat 9, 1,19 mln zasymulowanych trejdow Smyczy na
  // 127 monetach. Progi to MEDIANY obu cech policzone WYLACZNIE na probce
  // uczacej (2017-2024); probka testowa (2024-2026) sluzyla tylko do sprawdzenia.
  //
  // CZEGO SIE SPODZIEWAC — i to trzeba powiedziec wprost, zeby za pol roku nikt
  // nie liczyl na cuda. Na probce testowej filtr dal:
  //
  //   +0,08 pkt proc. wygranych, +0,004 pkt proc. sredniego wyniku
  //   +0,0023 ATR w jednostkach ryzyka, przy koszcie rundy okolo 0,13 ATR
  //
  // Czyli efekt jest PRAWDZIWY — przeszedl wszystkie trzy kontrole, ktore zabily
  // wczesniejszy filtr zmiennosci (odsetek wygranych i wynik rosna razem, poprawa
  // widac takze w jednostkach ryzyka, i nie znika po obcieciu ogona) — ale odzyskuje
  // niecale 2% tego, co placimy gieldzie. Na uczacej bylo +0,057 pkt proc., czyli
  // rozpad o 93%.
  //
  // Po co wiec w ogole ten gracz: zeby sprawdzic to na trejdach, ktore sie jeszcze
  // NIE WYDARZYLY. Symulacja moze sie mylic na sto sposobow, a liga tylko na jeden.
  // Efekt jest tak maly, ze werdykt zajmie bardzo dlugo — i to tez jest wynik.
  //
  // Uwaga na interpretacje: ten sam wzor widac u MALPY wchodzacej losowo, wiec nie
  // jest to slabosc akurat naszego sygnalu, tylko wlasnosc rynku. Wchodzenie na
  // skraju swiecy, ktorej nikt sie nie przeciwstawil, jest odrobine gorsze zawsze.
  smyczFiltr: {
    nazwa: 'Smycz czysta',
    opis: 'Smycz, ale nie wchodzi na skraju swiecy bez odrzucenia',
    trailAtr: 0.5,
    wejscie: (sym, m, c) => {
      const syg = sygnalTrendu(sym, m, c);
      if (!syg) return null;
      const k = ksztaltSwiecy(c?.[c.length - 1], syg.kier === 'LONG');
      // Brak ksztaltu (swieca bez zakresu) = nie blokujemy. Filtr ma odrzucac
      // konkretny uklad, a nie wszystko, czego nie umie policzyc.
      if (k && k.knotZa <= 0.1451 && k.zamkniecie > 0.1923) return null;
      return syg;
    },
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

  // Cierpliwy plus doba wolnego po kazdej wygranej. Pomysl z pytania z 29.07.2026:
  // "a jakby zrobic bota co jak ma dobrego trejda, to czeka pare godzin".
  //
  // Pomysl mial dwie mozliwe wersje i tylko jedna dziala (bot/cache/czekacz.mjs,
  // silnik skalibrowany pomiarem wykonania, 10 aktywow, 5 lat):
  //
  //   trzymaj wygrana pozycje dluzej -> GORZEJ u wszystkich (nawet u malpy):
  //     blokowanie TP/traila to czas na wyparowanie zysku plus dodatkowe odsetki
  //   pauza 24h po wygranym trejdzie -> Cierpliwy z -0,114% na +0,024% na trejd,
  //     PIERWSZY dodatni wynik zasad na zywo w historii naszych symulacji
  //
  // Cztery testy uczciwosci, wszystkie zaliczone (sprawdz-b24.mjs, sjesta-aktywa.mjs):
  //   1. podzial historii 60/40 — poprawa w OBU polowkach (+0,10 pp i +0,20 pp),
  //   2. malpa z ta sama pauza nie zyskuje NIC — pauza sama w sobie jest pusta,
  //      dziala dopiero na wejsciach Cierpliwego,
  //   3. dawka jak w mechanizmie, nie jak w szumie: 4h nic, 12h troche, 24h duzo,
  //   4. poprawa na 7 z 10 aktywow (najmocniej BONK +0,73 pp; wyjatek ORCA).
  //
  // Mechanizm po ludzku: wygrane Cierpliwego przychodza na KONCU dlugich ruchow
  // (trzyma minimum 12h), wiec natychmiastowy powrot to dosiadanie zdyszanego konia.
  // Doba przerwy pozwala rynkowi rozdac karty od nowa.
  //
  // Zastrzezenie zapisane uczciwie: to najlepsza z 30 komorek tabeli czekacza,
  // wiec mimo czterech testow to trop, nie dowod. Dowodem bedzie to, co zrobi
  // TUTAJ — na trejdach, ktore sie jeszcze nie wydarzyly. Pauza liczy sie
  // osobno per aktywo, bo dokladnie tak byla symulowana.
  sjesta: {
    nazwa: 'Sjesta',
    opis: 'jak Cierpliwy, ale po wygranej ma dobę wolnego na tym aktywie',
    wejscie: sygnalTrendu,
    minGodzin: envNum('MIN_GODZIN', 12),
    pauzaPoWygranejH: 24,
  },

  // Cierpliwy, ktory nie otwiera niczego przez 24h po tapnieciu calego rynku
  // (dobowy ruch BTC ponad 5%). BTC jest tu CZUJNIKIEM, nie aktywem do handlu.
  //
  // Jedyny ocalaly z baterii szesciu rodzin regul "kiedy grac" (29.07.2026,
  // bot/cache/motanie*.mjs, wnioski w bot/cache/MOTANIE-WNIOSKI.md). Bateria
  // dala 16 "zwyciezcow" przy oczekiwanych ~14 falszywych z samego przypadku,
  // wiec o wszystkim decydowaly dogrywki — i tylko ta rodzina je przeszla:
  //
  //   dawka: progi 3/4/5/6/8/10% — efekt maleje PLYNNIE z progiem (wzgorze,
  //     nie szpikulec, jak przy zdemaskowanym "oknie azjatyckim"),
  //   kontrola: malpa nie zyskuje przy ZADNEJ z szesciu dawek — czyli to nie
  //     jest efekt rezimu rynku, tylko jakosci naszych wejsc w chaosie,
  //   spojnosc: poprawa w obu polowkach historii u trend/luzny/cierpliwy,
  //   szerokosc: 7 z 10 aktywow,
  //   mechanizm zgodny z niezalezna analiza tapniecia: po wstrzasie calego
  //   rynku sygnaly trendowe altow strzelaja w chaos skorelowany.
  //
  // Prog 5% jest z baterii, nie z dogrywki. Najlepiej wypadl 3%, ale zostal
  // wybrany PO obejrzeniu dawki, wiec do ligi wchodzi wersja pre-rejestrowana.
  sejsmograf: {
    nazwa: 'Sejsmograf',
    opis: 'jak Cierpliwy, ale milczy przez dobę po tąpnięciu całego rynku',
    wejscie: sygnalTrendu,
    minGodzin: envNum('MIN_GODZIN', 12),
    sejsmograf: true,
  },

  // Te same wejscia i wyjscia co Trend. Rozni go JEDNO: wielkosc depozytu.
  //
  // Wszyscy inni stawiaja staly procent kapitalu, wiec przy stopie 1,6 ATR trejd
  // na dzikim aktywie (ATR 3% ceny) moze zabrac ~6x wiecej pieniedzy niz na
  // spokojnym (0,5%). Krawiec szyje depozyt na miare: dobiera go tak, zeby
  // KAZDY trejd ryzykowal ta sama czesc kapitalu — 1% przy uderzeniu w stop.
  //
  //   depozyt = kapital * 1% / (dzwignia * stopATR * zmiennosc)
  //   (z limitem gora = zwykle 20% i podloga = MIN_MARGIN)
  //
  // Czego to NIE zmieni: przewagi na trejd — zmierzono, ze zwrot z depozytu nie
  // zalezy od stawki. Co MA zmienic: sciezke pieniedzy — mniejsze wahania przy tej
  // samej sredniej to mniejszy podatek od zmiennosci (ta sama strategia dawala od
  // -66% do +8% zaleznie wylacznie od stawki) i mniejsze likwidacje.
  //
  // pozaTestem: jego zwroty NA TREJD sa z definicji niemal kopia Trendu (te same
  // wejscia/wyjscia), wiec porownywanie go z malpa testem zwrotow byloby liczeniem
  // Trendu dwa razy i tylko psuloby prog Bonferroniego wszystkim. Krawca rozlicza
  // KRZYWA KAPITALU w tabeli — to tam mieszka jego pomysl.
  krawiec: {
    nazwa: 'Krawiec',
    opis: 'te same wejscia co Trend, ale depozyt szyty na miare ryzyka trejdu',
    wejscie: sygnalTrendu,
    ryzykoPct: 0.01,
    pozaTestem: true,
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

  // Jedyny ocalaly z farmy 600 sit (bot/cache/farma.mjs, 28.07.2026).
  //
  // Farma wygenerowala 300 losowych kombinacji warunkow wejscia plus 300 sit czysto
  // losowych jako kontrole i przepuscila wszystkie przez 5 lat na 10 aktywach —
  // 7,4 miliona zasymulowanych trejdow. Podium probki uczacej okazalo sie pulapka
  // (najlepsze sito: +0,319% na uczacej, -0,063% na testowej). To jedno wyszlo czysto:
  //
  //   uczaca +0,105%, testowa +0,105% (co do tysiecznej), 6311 trejdow
  //   dodatni w 5 z 6 lat, w tym w 2026; na plusie 8 z 10 aktywow
  //   nie dziala na BTC i ETH — dziala na altach, czyli tam, gdzie rynek
  //   jest za maly dla duzych graczy (zgodnie z teoria projektu)
  //
  // ALE UWAGA — to zastrzezenie dotyczy tylko BADANIA. W lidze Sito 5 handluje
  // BTC i ETH, bo one SA w uniwersum ligi (patrz deploy/run.sh, LIGAA_AKTYWA)
  // i nie ma tu mechanizmu, ktory wylaczalby pojedynczemu graczowi wybrane
  // aktywa. Czesc jego wyniku pochodzi wiec z rynkow, na ktorych — wedlug
  // wlasnej pre-rejestracji — dzialac nie powinien. Przy czytaniu tabeli
  // trzeba o tym pamietac: to nie jest czysty test tej hipotezy.
  //
  // Po ludzku: kupuj mocne wyprzedanie, ale tylko gdy spadek jest prosty
  // i jednokierunkowy, a nie pila. To ta sama rodzina co Kontra (ktora ma
  // najpewniejsza alfe ponad malpe na zywo) plus filtr prostoty ruchu —
  // dwie niezalezne metody doszly do tego samego miejsca.
  //
  // Zastrzezenie zapisane uczciwie: sito wyroznione sposrod dziesiatki takze
  // po obejrzeniu probki testowej, wiec to trop, nie dowod. Dowodem bedzie
  // to, co zrobi TUTAJ, na trejdach, ktore sie jeszcze nie wydarzyly.
  sito5: {
    nazwa: 'Sito 5',
    opis: 'z farmy 600 sit: kupuje mocne wyprzedanie, gdy spadek jest prosty',
    wejscie: (sym, m) => {
      if (m.er != null && m.er >= 0.35 && m.rsi < 35) {
        return { kier: 'LONG', powod: `prosty zjazd (ER ${m.er.toFixed(2)}), RSI ${m.rsi.toFixed(1)} — kupuję` };
      }
      return null;
    },
  },

  // Sito 5 z zakrecona srubka: ER >= 0,45 zamiast 0,35 i RSI < 25 zamiast 35.
  //
  // Skad: pomiar selektywnosci na 73 zywych monetach spoza naszego podworka
  // (bot/cache/selektywnosc.mjs, 30.07.2026). Siatka 25 progow dala najczystszy
  // ksztalt w calym projekcie — przewaga nad malpa rosnie MONOTONICZNIE w obie
  // strony zaostrzania, a wszystkie 25 komorek ma ten sam znak na obu polowkach
  // historii:
  //
  //   ER>=0,15  +0,21 ... +0,47      ER>=0,45  +0,79 ... +1,27
  //   ER>=0,35  +0,34 ... +0,58      ER>=0,55  +2,98 ... +3,95
  //
  // To gladka rampa, nie szpikulec — odwrotnie niz "okno azjatyckie", ktore
  // rozpadlo sie przy pierwszym dotknieciu. Wniosek pochodny: oryginalne progi
  // Sita 5 byly ZA LUZNE, a nie przepasowane.
  //
  // DLACZEGO SRODEK RAMPY, A NIE NAJLEPSZY ROG: przy ER>=0,55 zostaje 7-9
  // trejdow na monete na rok, wiec pojedyncze zdarzenia waza tam za duzo,
  // a +3,95 pp to liczba, ktorej sam nie brałbym powaznie. 0,45/25 lezy na
  // gladkiej czesci krzywej i daje ~31 trejdow na monete na rok.
  //
  // CENA, KTORA PLACIMY, ZAPISANA WPROST: zaostrzenie mnozy przewage na trejd
  // ~19x, ale dzieli liczbe trejdow ~100x. Laczny urobek SPADA (144 -> 27
  // w jednostkach umownych). Ten gracz jest wiec zakladem o to, ze w lidze
  // waskim gardlem sa MIEJSCA (4 sloty), a nie okazje — jesli tak, ostrzejszy
  // filtr jest darmowy, bo odrzuca trejdy, ktorych i tak nie dalo sie wziac.
  //
  // Zaleznosc od Sita 5 zapisana uczciwie: kazde wejscie Ostrego Sita jest tez
  // wejsciem Sita 5 (warunki sa zagniezdzone), wiec ci dwaj gracze NIE sa
  // niezalezni. Rozlicza ich to samo kryterium co wszystkich, ale przy czytaniu
  // tabeli trzeba o tym pamietac.
  sitoOstre: {
    nazwa: 'Sito ostre',
    opis: 'jak Sito 5, ale wchodzi tylko przy bardzo prostym zjeździe i głębokim wyprzedaniu',
    wejscie: (sym, m) => {
      if (m.er != null && m.er >= 0.45 && m.rsi < 25) {
        return { kier: 'LONG', powod: `bardzo prosty zjazd (ER ${m.er.toFixed(2)}), RSI ${m.rsi.toFixed(1)} — kupuję` };
      }
      return null;
    },
  },

  // Kupuje glebokie wyprzedanie, ale TYLKO gdy rynkiem rzuca: ATR co najmniej
  // 2% ceny na swiece kwadransowa (okolo 20% zmiennosci dziennej — krach albo
  // wystrzal) i RSI ponizej 28.
  //
  // To nie jest nowy mechanizm. To TEN SAM pomysl co Sito 5, ograniczony do
  // chwil, w ktorych ruch jest dosc duzy, zeby zaplacic bramke. Sito ma racje,
  // tylko za czesto gra o stawke mniejsza od oplaty.
  //
  // Skad: przeszukanie 5000 wariantow Sita na naszych 10 monetach i sprawdzenie
  // zwyciezcow na 73 obcych (bot/cache/warianty*.mjs, sprawdzam.mjs, 31.07.2026).
  // Korelacja wynikow rozwojowych i testowych: 0,953. Dla porownania farma
  // 150 tysiecy sit miala 0,207 — tam szukalismy szczesliwcow, tu trafilismy
  // w cos strukturalnego.
  //
  // PIEC TESTOW, KTORE MOGLY GO ZABIC — i czego nauczyl kazdy:
  //   1. KOSZT LICZONY Z DANYCH, nie z zalozenia. Spread oszacowany estymatorem
  //      Corwina-Schultza wychodzi w tych chwilach 0,315% na strone, czyli
  //      PIEC RAZY wiecej niz nasze 0,06%. Przy tym koszcie sama zmiennosc
  //      ginie (-2,20% na trejd, kapital x0,04), a polaczenie z wyprzedaniem
  //      przezywa: +2,85% i kapital x1,43. Odwrotnie, niz sie wydawalo.
  //   2. Wejscie swiece pozniej (15 min opoznienia, trzy razy gorzej niz realne
  //      pieciominutowe odpytywanie): +1,98%, kapital x1,34.
  //   3. Obie polowy historii dodatnie: +1,78% i +3,54%.
  //   4. Szerokosc: 58 z 69 monet na plusie; po usunieciu piatki najlepszych
  //      zostaje +2,49% i x1,38.
  //   5. Przy PODWOJONYM oszacowanym spreadzie: +1,09%, kapital x1,05 — czyli
  //      przewaga jest cienka, ale wciaz dodatnia.
  //
  // Ryzyko zapisane wprost: Corwin-Schultz to estymator, nie pomiar. W cienkiej
  // ksiedze zlecen podczas krachu prawdziwy koszt moze przebic nawet podwojony
  // szacunek — a tam zostaje juz tylko +1,09%. Nie mierzymy tez wplywu wlasnego
  // zlecenia na cene. To jest glowna niepewnosc tego gracza i liga ma ja
  // rozstrzygnac na prawdziwych trejdach.
  panika: {
    nazwa: 'Panika',
    opis: 'kupuje głębokie wyprzedanie, ale tylko gdy rynkiem naprawdę rzuca',
    wejscie: (sym, m) => {
      if (m.volPct >= 0.02 && m.rsi <= 28) {
        return { kier: 'LONG', powod: `panika: zmienność ${(m.volPct * 100).toFixed(1)}% ATR, RSI ${m.rsi.toFixed(1)} — kupuję` };
      }
      return null;
    },
  },

  // Panika z wyjsciami dopasowanymi do jej wlasnego rezimu: stop 3,5 ATR
  // zamiast 1,6 i BEZ smyczy.
  //
  // Skad: ostatnia nietknieta os wokol Paniki (bot/cache/wyjscia-paniki*.mjs,
  // 31.07.2026). Jej wyjscia byly odziedziczone po regulach ligi, a te powstaly
  // dla normalnych warunkow. Panika gra tam, gdzie cena skacze 2% na swiece
  // kwadransowa — stop 1,6 ATR i smycz 2,0 ATR sa w tym rezimie WEWNATRZ SZUMU
  // i zamieniaja przyszle wygrane w straty, zanim ruch zdazy sie rozwinac.
  //
  // Kazda wartosc sprawdzana na DWOCH ROZLACZNYCH polowach monet ORAZ dwoch
  // polowach historii; "lepsze" tylko przy poprawie we wszystkich czterech:
  //
  //   stop:  1,0 → +3,2 | 1,6 (obecny) → +3,8 | 2,4 → +4,5 | 3,5 → +5,0 | bez → +6,1
  //   smycz: 1,0 → +3,5 | 2,0 (obecna) → +4,0 | 3,0 → +3,9 | bez smyczy → +4,5
  //   take profit: brak zwyciezcy, stop czasowy: bez znaczenia
  //
  // Polaczenie stop 3,5 + bez smyczy daje +6,1/+5,7 wobec +3,8/+4,2 u Paniki,
  // przy likwidacjach 0,8% wobec 0,6% — czyli niemal caly zysk przy ryzyku
  // praktycznie nietknietym.
  //
  // DLACZEGO NIE "BEZ STOPA W OGOLE": tamten uklad daje najwiecej (+8,1/+9,0),
  // ale likwidacje skacza z 0,6% na 4,2%, czyli siedmiokrotnie. Pomiar dzwigni
  // (bot/cache/lewar2.mjs) pokazal, ze taki handel — wiecej sredniej za wiecej
  // ogona — konczy sie gorszym KAPITALEM mimo lepszej sredniej. Bierzemy srodek
  // rampy, nie rog, tak samo jak przy Sicie ostrym.
  //
  // Paniki NIE zmieniamy — jej reguly sa pre-rejestrowane (Aneks 5), a zmiana
  // w trakcie uniewaznilaby eksperyment. Ci dwaj graja obok siebie i to liga
  // rozstrzygnie, czy luzniejsze wyjscia sa warte swojej ceny.
  panikaLuzna: {
    nazwa: 'Panika luźna',
    opis: 'jak Panika, ale ze stopem 3,5 ATR i bez smyczy — wyjścia dopasowane do burzy',
    wejscie: (sym, m) => {
      if (m.volPct >= 0.02 && m.rsi <= 28) {
        return { kier: 'LONG', powod: `panika: zmienność ${(m.volPct * 100).toFixed(1)}% ATR, RSI ${m.rsi.toFixed(1)} — kupuję luźno` };
      }
      return null;
    },
    stopAtr: 3.5,
    bezSmyczy: true,
  },

  /**
   * PANIKA OSTRA — Panika plus jedyny filtr wejścia, który przeżył wszystkie
   * progi tego projektu (H15, Aneks 18 w HIPOTEZY.md, 03.08.2026).
   *
   * Warunek: cena musi stać co najmniej 2,66 ATR PONIŻEJ średniej szybkiej.
   * To nie jest nowa oś ani egzotyczny kształt świecy — to jest „panikuj
   * mocniej". I właśnie dlatego jest wiarygodne: gdyby zwycięzcą okazał się
   * knot górny albo luka, podejrzewałbym przekopanie danych.
   *
   * CZEGO DOKŁADNIE DOWIÓDŁ POMIAR (kąt 8 na 127 monetach):
   *   - poza próbką +0,053 ATR i +2,04 pkt proc. wygranych,
   *   - po obcięciu R na +20% nadal +0,386 pp, więc to nie jest sam ogon,
   *   - poprzeczka z cech CZYSTO LOSOWYCH |t| = 2,09, a `ext` ma 6,31,
   *   - obie rozłączne połowy monet: +0,053 i +0,048 ATR.
   *
   * CZEGO NIE DOWIÓDŁ: efekt istnieje TYLKO przy ciasnym wyjściu. Przy stopie
   * 3,5 bez smyczy zostaje +0,0008 ATR i pod obcięciem zmienia znak. Dlatego
   * ten gracz dziedziczy wyjścia Paniki (stop 1,6 ATR, smycz 2,0) i nie wolno
   * ich tu „poprawić" — bez nich filtr nie ma czego pilnować.
   *
   * Paniki NIE dotykamy: jest pre-rejestrowana w Aneksie 5, a zmiana reguł
   * w trakcie unieważniłaby eksperyment. Ci dwaj grają obok siebie w Lidze C.
   */
  panikaOstra: {
    nazwa: 'Panika ostra',
    opis: 'jak Panika, ale wchodzi tylko gdy cena jest ≥2,66 ATR pod średnią szybką',
    wejscie: (sym, m) => {
      if (!(m.volPct >= 0.02 && m.rsi <= 28)) return null;
      if (!(m.atr > 0)) return null;
      const ext = (m.price - m.emaFast) / m.atr;
      if (!(ext <= -2.66)) return null;
      return {
        kier: 'LONG',
        powod: `panika ostra: ${(m.volPct * 100).toFixed(1)}% ATR, RSI ${m.rsi.toFixed(1)}, ${ext.toFixed(2)} ATR pod średnią — kupuję`,
      };
    },
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

  // Małpa TYLKO DŁUGA — punkt odniesienia dla graczy, którzy nie skracają.
  //
  // Nie jest gotowa do ligi i NIE MA JEJ w składzie żadnej z nich (składy są
  // przypięte w deploy/run.sh). Istnieje wyłącznie dla laboratorium, i to
  // z konkretnego powodu, który raz już nas kosztował wynik:
  //
  // Zwykła małpa 50/50 ma ZEROWĄ ekspozycję na dryf rynku. Gdy porównuje się
  // z nią gracza grającego wyłącznie długo, ten dostaje premię za sam wzrost
  // i wygląda na lepszego, choć nic nie wnosi. Na akcjach ta premia wyniosła
  // +0,87 pp i wywróciła cały wniosek (bot/cache/GIELDA-WNIOSKI.md, błąd nr 2).
  //
  // Panika, Sito 5, Sito ostre i Wybicie-long grają tylko w górę. Każde
  // porównanie ich z małpą MUSI używać tej wersji.
  malpaDluga: {
    nazwa: 'Małpa długa',
    opis: 'rzuca monetą, ale wyłącznie w górę — odniesienie dla graczy tylko-długich',
    wejscie: () => (los() < malpaSzansa ? { kier: 'LONG', powod: 'rzut monetą — żadnego powodu' } : null),
  },

  // ── NAIWNI: mocniejsza hipoteza zerowa niz malpa ────────────────────────────
  //
  // Malpa losowa jest SLABA kontrola dla Paniki. Panika kupuje wyprzedanie, wiec
  // porownywanie jej z losowym wejsciem mowi tylko tyle, ze kupowanie po spadku
  // bije kupowanie w losowej chwili. To za malo.
  //
  // Wlasciwe pytanie brzmi: czy cala maszyneria (RSI <= 28, ATR >= 2%, ER) daje
  // COKOLWIEK ponad najprostsza regule powrotu do sredniej — "cena spadla o X%,
  // kupuj". Jesli Panika tego nie bije, jej warunki sa dekoracja.
  //
  // Drabina zamrozona z gory: 5%, 10%, 20% spadku w 16 swiecach (4 godziny).
  // Trzy wartosci, jeden wymiar, zadnej siatki.
  //
  // TO SA GRACZE WYLACZNIE DO LABORATORIUM. Sklady lig sa przypiete w
  // deploy/run.sh, wiec nie maja jak tam trafic — i nie maja tam trafic.
  ...(() => {
    const naiwny = (prog) => ({
      nazwa: `Naiwny ${Math.round(prog * 100)}%`,
      opis: `kupuje po spadku o ${Math.round(prog * 100)}% w 4 h — bez RSI, bez ATR, bez ER`,
      wejscie: (sym, m, c) => {
        if (!c || c.length < 17) return null;
        const teraz = c[c.length - 1].c, wczesniej = c[c.length - 17].c;
        if (!(wczesniej > 0) || !(teraz > 0)) return null;
        const zmiana = teraz / wczesniej - 1;
        return zmiana <= -prog
          ? { kier: 'LONG', powod: `spadek ${(-zmiana * 100).toFixed(1)}% w 4 h — kupuję bez pytania` }
          : null;
      },
    });
    // Test rozstrzygajacy: czy wartosc siedzi w WEJSCIU czy w WYJSCIU.
    // Naiwna regula wejscia + wyjscia Paniki luznej (stop 3,5 ATR, bez smyczy).
    // Jesli to dogoni Panike luzna, maszyneria wejscia jest dekoracja.
    const luzny = { stopAtr: 3.5, bezSmyczy: true };
    return {
      naiwny5: naiwny(0.05), naiwny10: naiwny(0.10), naiwny20: naiwny(0.20),
      naiwny10Luzny: { ...naiwny(0.10), ...luzny, nazwa: 'Naiwny 10% luźny' },
    };
  })(),

  // ── PROGI PANIKI: test funkcji celu w DOLARACH, nie procentach ──────────────
  //
  // Aneks 5 zamrozil prog 2% ATR i pokazal, ze obnizanie go NISZCZY strategie —
  // przy 1,0% portfel jest na minusie. Ale to bylo mierzone w PROCENTACH.
  //
  // Nasze ograniczenie jest nominalne: sufit dotyczy pojedynczego zlecenia, nie
  // rocznego obrotu. Luzniejszy prog daje wiecej trejdow o nizszym zwrocie —
  // w procentach gorzej, w DOLARACH pod sufitem moze byc lepiej.
  //
  // Wszystkie z wyjsciami Paniki luznej, bo to one daja najwiekszy efekt.
  // Gracze wylacznie do laboratorium — sklady lig sa przypiete.
  ...(() => {
    const luzna = (progAtr) => ({
      nazwa: `Panika ${(progAtr * 100).toFixed(1)}%`,
      opis: `RSI ≤ 28 i ATR ≥ ${(progAtr * 100).toFixed(1)}% — wyjścia luźne`,
      wejscie: (sym, m) => (m.volPct >= progAtr && m.rsi <= 28
        ? { kier: 'LONG', powod: `panika: ${(m.volPct * 100).toFixed(1)}% ATR, RSI ${m.rsi.toFixed(1)}` }
        : null),
      stopAtr: 3.5,
      bezSmyczy: true,
    });
    return { panika15: luzna(0.015), panika10: luzna(0.010), panika07: luzna(0.007) };
  })(),

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

  /**
   * KARENCJA STOPA — stop nie dziala przez pierwsze `karencjaStopH` godzin,
   * ale take profit i smycz dzialaja normalnie.
   *
   * To NIE jest to samo co `minGodzin`. Tamto wstrzymuje WSZYSTKIE wyjscia
   * i pyta "czy oplaca sie w ogole byc cierpliwym". To pyta o cos wezszego:
   * czy stop w pierwszych minutach mierzy RYZYKO, czy zbiera SZUM.
   *
   * Skad pomysl: dwa nasze wlasne wyniki stoja obok siebie i az prosza sie
   * o zlozenie. Aneks 15 — "najlepsze wejscia to te, w ktorych odbicie zaczyna
   * sie natychmiast". Aneks 17 — "po przegranej cena wraca +1,6 ATR w 12 h,
   * stop wyrzuca tuz przed odbiciem". Razem znacza, ze pierwsze minuty po
   * wejsciu w panike to obszar, w ktorym cena jeszcze szarpie, a stop lapie
   * to szarpniecie zamiast prawdziwego pogorszenia.
   *
   * PODLOGA JEST OBOWIAZKOWA I DAROWA: likwidacji nie blokuje nikt, bo to nie
   * jest nasza decyzja — gielda zamyka pozycje sama, a silnik sprawdza ja poza
   * ta funkcja. Bez tego karencja przy dzwigni 3x bylaby zakladem o to, ze
   * gielda nie kichnie.
   */
  if (p.karencjaStopH && heldH < p.karencjaStopH && wStop) {
    if (long ? goraCeny >= p.takeProfit : dolCeny <= p.takeProfit) return 'TAKE PROFIT';
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
  // Smycz da sie WYLACZYC calkiem (Panika luzna). Pomiar na 73 obcych monetach
  // pokazal, ze w rezimie skrajnej zmiennosci smycz 2,0 ATR lezy wewnatrz szumu
  // i wyrzuca pozycje, zanim ruch zdazy sie rozwinac.
  if (p.trailArmed && !p.bezSmyczy) {
    // Dlugosc smyczy zapisujemy przy pozycji, bo gracz Smycz ma wlasna.
    const dl = p.trailAtr ?? CFG.TRAIL_ATR;
    const tr = long ? p.bestPrice - dl * a : p.bestPrice + dl * a;
    if (long ? px <= tr : px >= tr) return 'TRAILING STOP';
  }
  // Prog wlasny gracza ma pierwszenstwo nad globalnym — inaczej nie da sie
  // zmierzyc wczesnego usmiercania bez ruszania calej ligi.
  if (heldH > (p.maxHoldH || CFG.MAX_HOLD_HOURS) && (long ? px < p.entryPrice : px > p.entryPrice)) return 'stop czasowy';
  return null;
}
