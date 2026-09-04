#!/usr/bin/env bash
#
# Wywolywane przez crona co 5 minut. Odpala oba boty i zapisuje stan do repo.
#
# Na GitHub Actions robil to plik workflow. Tutaj musimy sami: pobrac ewentualne
# zmiany, uruchomic boty, zacommitowac i wypchnac. Wszystko po kolei, w jednym
# procesie — dzieki temu dwa boty nie wchodza sobie w droge przy commitowaniu.

set -uo pipefail

KATALOG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$KATALOG"

LOGI="$KATALOG/logs"
mkdir -p "$LOGI"
LOG="$LOGI/hajsomat.log"

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# Nie pozwalamy na dwa przebiegi naraz — gdyby jeden sie przeciagnal, drugi odpusci.
# Gdy flock nie jest zainstalowany, jedziemy bez blokady zamiast po cichu nie
# robic nic. Cichy sukces bylby tu najgorszy z mozliwych bledow.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$KATALOG/.hajsomat.lock"
  if ! flock -n 9; then
    log "poprzedni przebieg jeszcze trwa — pomijam"
    exit 0
  fi
else
  log "UWAGA: brak flock, jade bez blokady (zainstaluj: sudo apt install util-linux)"
fi

# Ustawienia
if [ -f "$KATALOG/deploy/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$KATALOG/deploy/.env"
  set +a
else
  log "BRAK deploy/.env — skopiuj hajsomat.env.example i uzupelnij"
  exit 1
fi

GALAZ="${GIT_BRANCH:-main}"

# Ile OTWARTYCH pozycji ma bot ze stada. Uzywane w dwoch miejscach przy
# przejmowaniu kont, wiec raz, a nie dwa razy wklejone.
stado_otwarte() {
  node -e '
    const fs = require("fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(Object.keys(s.pozycje || {}).length));
    } catch { process.stdout.write("0"); }
  ' "$KATALOG/state/stado-$1-state.json" 2>/dev/null || echo 0
}

# Ktore boty uruchomic. Domyslnie tylko kontraktowy — spot zostal wylaczony,
# bo przy stalych oplatach sieciowych nie mial szans, a dzwignia daje ruchy
# na tyle duze, ze oplaty przestaja decydowac.
# Liga botow chodzi obok — kazdy gracz na osobnym portfelu.
#
# Od 31.07.2026 dzialaja DWIE ligi na tym samym kodzie:
#   liga  — 8 aktywow Solany, 4 miejsca po 20% kapitalu (jak dotad),
#   ligab — 24 alty spoza Solany, 10 miejsc po 8%.
# Laczne zaangazowanie kapitalu jest w obu takie samo (80%), rozni je
# wylacznie ROZPROSZENIE. Dzieki temu roznica miedzy nimi mierzy jedna rzecz.
#
# Od 02.08.2026 chodzi `stado` — kilka botow na Hyperliquid, kazdy na wlasnym
# koncie. Tryb zywy JEST napisany i dziala, wiec jedyne, co dzieli te boty od
# wydawania prawdziwych pieniedzy, to jedna zmienna:
#
#   REALNY_SUCHY=1 (albo brak)  — nic nie skladaja, tylko licza sygnaly
#   REALNY_SUCHY=0              — handluja naprawde
#
# Ta zmienna NIE jest nadpisywana przez petle stada; pochodzi wylacznie
# z deploy/.env, zeby przejscie na zywo bylo swiadoma decyzja czlowieka,
# a nie skutkiem ubocznym zmiany w skrypcie.
# ORAZ dopisania obslugi podpisywania zlecen w bot/realny.mjs.
#
# Od 02.08.2026 `realny` ustepuje miejsca `stado` — kilku botom na prawdziwych
# pieniadzach, kazdemu na wlasnym koncie. Stary `realny` zostaje w case-u, zeby
# dalo sie do niego wrocic jednym slowem, ale domyslnie juz nie chodzi.
#
# Zeby dorzucic spot:  run.sh trade perp liga ligab stado
BOTY="${*:-perp liga ligab ligac ligahl forwardpanika stado}"

# Uniwersum Ligi A — DOKLADNIE to, na czym liga gra od 27.07.2026 (odczytane
# z zywego state/liga-state.json, pole lastRun.prices).
#
# Wczesniej ta lista NIE byla tu podana i liga brala ja z CFG.ASSETS, czyli ze
# zmiennej ASSETS w deploy/.env — tej samej, ktora konfiguruje bota perp.
# Znaczylo to, ze dolozenie albo usuniecie jednej monety przy strojeniu perpa
# po cichu zmienialoby BOISKO osiemnastu graczom w polowie eksperymentu
# i uniewazniloby wszystkie porownania miedzy nimi. Teraz boisko jest zapisane
# tutaj, a liga.mjs dodatkowo odmawia startu, gdy sie rozjedzie.
#
# BTC i ETH SA w tej liscie celowo — liga handluje nimi od pierwszego przebiegu.
# Usuniecie ich teraz byloby wlasnie ta zmiana boiska, ktorej unikamy.
LIGAA_AKTYWA="SOL,JUP,JTO,PYTH,RAY,ORCA,RENDER,BONK,W,TNSR,DRIFT,KMNO,PENGU,BTC,ETH"

# Uniwersum Ligi B — 24 alty, wszystkie notowane przez Krakena (Binance oddaje
# 451 z amerykanskiego IP, wiec to jedyne zrodlo swiec na tym serwerze).
LIGAB_AKTYWA="1INCH,ALCX,ARB,ASTR,AVA,BCH,CELO,CTSI,EDU,FIDA,GALA,HFT,JST,LQTY,MASK,NEO,OGN,QNT,RLC,SAND,STORJ,SUPER,VET,YFI"

# SKLAD Ligi A i B — PRZYPIETY, dokladnie tak jak uniwersum.
#
# Prog istotnosci dzieli sie przez liczbe porownywanych graczy, wiec dolozenie
# jednego nowego utrudnia werdykt WSZYSTKIM pozostalym — a oni zbieraja dane
# od lipca. Bez tej listy kazdy wariant dopisany do gracze.mjs wchodzilby do
# trwajacego eksperymentu po cichu i zmienial jego warunki w polowie.
#
# Nowe pomysly ida do Ligi C, ktora ma wlasne liczenie i nie kosztuje nikogo nic.
LIGAAB_GRACZE="trend,antytrend,luzny,smycz,cierpliwy,czujny,sjesta,sejsmograf,krawiec,kontra,kontraN,sito5,sitoOstre,panika,panikaLuzna,wybicie,malpa,byk"

# LIGA C — poletko doswiadczalne.
#
# Te same aktywa co Liga A, zeby porownanie bylo bezposrednie, ale wlasny,
# maly sklad: oryginal, wariant i malpa. Przy trzech graczach prog Bonferroniego
# jest lagodny, wiec drobna roznica ma szanse sie ujawnic — a w Lidze A przy
# szesnastu utonelaby.
#
# Tu ladują hipotezy, ktore dopiero sprawdzamy. Gdy ktoras wygra przekonujaco,
# wtedy — i dopiero wtedy — warto rozwazyc dopisanie jej do Ligi A.
LIGAC_GRACZE="smycz,smyczFiltr,malpa,panika,panikaOstra"

# ---- LIGA HL: forward test na danych, ktorych nikt nie widzial (H34) ----
#
# Ligi A, B i C pobieraja swiece z Krakena/Binance (SPOT). Bot na zywo decyduje
# na swiecach Hyperliquid (PERPY). Aneks 85 zmierzyl, ze to nie jest ta sama
# seria: ATR na HL jest o 5-23% NIZSZY. Prog Paniki liczy sie wlasnie z ATR,
# wiec ligi pokazuja inna czestosc sygnalow niz ta, ktora bot moze osiagnac.
#
# Ta liga gra na DOKLADNIE tych 11 rynkach co realny.mjs i na DOKLADNIE tych
# samych swiecach. Kapital 10 000 wirtualnych dolarow, zeby minimum zlecenia
# nie ograniczalo rozproszenia — to jedyna roznica wobec konta poza zrodlem.
#
# Kryterium rozstrzygniecia zapisane w H34 PRZED startem: konczy sie, gdy
# ktorykolwiek gracz zbierze 40 zamknietych trejdow. Progow nie wolno zmieniac.
LIGAHL_AKTYWA="SOL,JUP,JTO,PYTH,RENDER,BONK,BTC,ETH,W,TNSR,PENGU"
LIGAHL_GRACZE="panika,panikaLuzna,sitoOstre,sito5,kontraN,malpa,malpaDluga"

# H38 — czysty paper A/B momentu wejscia. Oba ramiona czytaja te sama migawke
# przygotowana przez ligahl: Panika 5m widzi budowana swiece, Panika 15m czeka
# na jej zamkniecie. Nie ma tu klucza konta ani sciezki skladania zlecen.
FORWARDPANIKA_GRACZE="panika5m,panika15m,malpa"
FORWARDPANIKA_SNAPSHOT="$KATALOG/logs/liga-hl-snapshot.json"

# STADO WYGASZANE — boty na prawdziwych pieniadzach, ktore maja dokonczyc
# otwarte pozycje i przestac wchodzic w nowe. Decyzja z 03.08.2026: zostaje
# sam Sito 5.
#
# Lista jest TUTAJ, a nie w deploy/.env, bo wygaszenie bota to zmiana, ktora
# ma byc widoczna w historii repozytorium razem z powodem — inaczej za miesiac
# nikt nie odtworzy, kiedy i dlaczego Smycz przestal grac.
#
# 04.08.2026: obaj dokonczyli i stoja plaskie (Smycz 68 trejdow, 21,97 USD;
# Trend 37 trejdow, 29,76 USD). Zostaja na liscie, zeby przypadkowe przywrocenie
# ich do STADO nie wznowilo handlu bez decyzji.
STADO_WYGASZANE="smycz trend"

# ── PRZEJECIE KONT ─────────────────────────────────────────────────────────
#
# Nowy bot wchodzi na KONTO wygaszonego. Format: nowy:SUFIKS_STAREGO, gdzie
# sufiks wskazuje zmienne KONTO_*/AGENT_* w deploy/.env.
#
# Po co tak, zamiast dopisac nowe konta w .env: konta juz istnieja, maja na
# sobie pieniadze (21,97 i 29,76 USD) i wlasne klucze agenta. Zakladanie dwoch
# nowych portfeli, przelewanie srodkow i generowanie kluczy to trzy operacje
# recznie, z ktorych kazda moze pojsc zle — a nie daja nic poza ladniejszym
# nazewnictwem.
#
# CZEGO TO NIE ROBI: nie dotyka plikow stanu. Nowy bot ma wlasny prefiks, wiec
# zaklada `stado-panika-*` od zera, a `stado-smycz-*` zostaje nietkniete jako
# zapis tamtego eksperymentu. Historia sie nie miesza, kapital tak — i to jest
# swiadome, bo pieniadze sa te same.
#
# START liczy sie SAM: realny.mjs przy pierwszym uruchomieniu porownuje saldo
# konta z REALNY_START_USD i gdy sie roznia, bierze saldo (realny.mjs:384).
# Nowe boty odczytaja wiec 21,97 i 29,76 bez naszego udzialu.
#
# 21.08.2026 — Sito ostre wchodzi na konto Sita 5. Powod: Aneks 73. Sito ostre
# jest jedynym graczem z DODATNIM R na trejd w obu ligach naraz (+0,306% na
# 15 aktywach Solany, +0,396% na 24 spoza niej) i jedynym, ktory potwierdzil
# przewidywanie zapisane PRZED zebraniem danych (Aneks 4, punkt 1: "ma wypasc
# lepiej na trejd niz Sito 5"). Wypadl lepiej w obu ligach.
#
# CENA TEJ ZMIANY, ZAPISANA WPROST:
#   - Sito ostre wchodzi 2-2,5x rzadziej. Sito 5 zrobilo 79 trejdow w 19 dni;
#     nastepca zrobi ich okolo 30 na miesiac. Na moc testu na zywo trzeba
#     bedzie czekac ponad rok — to jest wdrozenie, nie pomiar.
#   - Zywy dorobek Sita 5 (79 trejdow, 35,80 -> 34,81 USD) zamyka sie tutaj.
#     Plik `stado-sito5-*` zostaje nietkniety jako zapis tamtego eksperymentu.
#   - Sito ostre ma dopiero 30% proby w lidze A i 57% w lidze B. Decyzja jest
#     podjeta na tropie, nie na dowodzie, i tak ma byc czytana.
#
# Progi (ER >= 0,45, RSI < 25) sa ZAMROZONE regula z Aneksu 4, punkt 3.
STADO_PRZEJMUJE="panika:SMYCZ panikaLuzna:TREND sitoOstre:SITO5"

# ---- ROZPROSZENIE PER GRACZ ----
#
# Format: gracz:miejsc:alloc. Bez wpisu obowiazuja domyslne z realny.mjs
# (2 miejsca po 40%).
#
# 23.08.2026 - Sito ostre z 2 miejsc na 6. Powod: Aneks 79.
#
# Sito ostre kupuje glebokie wyprzedanie, ktore na skorelowanych kryptowalutach
# dzieje sie JEDNOCZESNIE. Przy dwoch miejscach oba sloty wypelniaja sie w krachu
# praktycznie jedna pozycja - to nie brak dywersyfikacji, tylko jej przeciwienstwo.
#
# Zmierzone w KAT 5 (95 okien rocznych, 126 rynkow, dzwignia 3, ten sam bot),
# mediana kapitalu koncowego ze startu 1000:
#
#   miejsc x alloc   mediana   najgorsze okno   pod kreska   najlepsze
#   2 x 0,40 (bylo)      193     0 (RUINA)          80%        12 375
#   4 x 0,20             318    13                  82%         5 368
#   6 x 0,13 (jest)      428    61                  87%         3 791
#   8 x 0,10             549    93                  82%         4 006
#
# Zaangazowanie kapitalu prawie bez zmian (78% wobec 80%) - zmienia sie WYLACZNIE
# rozproszenie. Mediana ponad dwukrotnie w gore, a podloga przestaje byc zerem.
#
# DLACZEGO 6, SKORO 8 WYPADA LEPIEJ: Hyperliquid odrzuca zlecenia ponizej 10 USD
# nominalu, a nominal to kapital x alloc x dzwignia. Przy dzisiejszych 34,80 USD:
#   alloc 0,13 -> 13,6 USD, dziala az kapital spadnie do 25,6 USD
#   alloc 0,10 -> 10,4 USD, przestaje dzialac juz przy 33,3 USD
# Mediana tej strategii jest ujemna, wiec kapital najpewniej spadnie. Osiem miejsc
# przestaloby po cichu handlowac i wygladaloby to na awarie bota, a nie na wybor.
#
# CENA, ZAPISANA WPROST: gorny ogon sie kurczy (najlepsze okno 12 375 -> 3 791),
# a odsetek okien pod kreska rosnie z 80% na 87%. Swiadomy wybor: na koncie 35 USD
# ruina jest nieodwracalna, a loteryjny ogon i tak konta nie odbuduje.
#
# CZEGO TA ZMIANA NIE ROBI: nie czyni Sita ostrego botem zarabiajacym. Nawet przy
# rozproszeniu 40 x 2% mediana wynosi 975, czyli wciaz pod kreska. To poprawa
# ustawienia z gorszego niz najgorsze testowane do srodka siatki - nic wiecej.
#
# Progi wejscia (ER >= 0,45, RSI < 25) sa ZAMROZONE regula z Aneksu 4 punkt 3
# i ta zmiana ich NIE dotyka. Zmienia sie wylacznie wielkosc i liczba pozycji.
STADO_ROZPROSZENIE="sitoOstre:6:0.13"

# Zabierz to, co przyszlo z zewnatrz (np. zmiany kodu wypchniete z komputera)
git fetch origin "$GALAZ" --quiet 2>>"$LOG" || log "fetch nieudany"
git merge --ff-only "origin/$GALAZ" --quiet 2>>"$LOG" || log "nie moge przewinac galezi (lokalne zmiany?)"

cd "$KATALOG/bot"
for bot in $BOTY; do
  USTAW=""
  case "$bot" in
    trade) PLIK="trade.mjs" ;;
    perp)  PLIK="perpbot.mjs" ;;
    liga)  PLIK="liga.mjs"
           USTAW="LIGA_ASSETS=$LIGAA_AKTYWA LIGA_GRACZE=$LIGAAB_GRACZE" ;;
    # Liga C — poletko doswiadczalne, wlasny prefiks stanu i wlasny maly sklad.
    ligac) PLIK="liga.mjs"
           USTAW="LIGA_PREFIX=liga-c LIGA_ASSETS=$LIGAA_AKTYWA LIGA_GRACZE=$LIGAC_GRACZE" ;;
    # Ta sama liga.mjs, inna konfiguracja — bez drugiej kopii mechaniki,
    # ktora po miesiacu rozjechalaby sie z pierwsza.
    # Forward test na swiecach Hyperliquid — H34. Zrodlo HL wlacza LIGA_ZRODLO=hl;
    # bez tej zmiennej liga.mjs zachowuje sie dokladnie jak dotad.
    ligahl) PLIK="liga.mjs"
           USTAW="LIGA_ZRODLO=hl LIGA_KONTEKST_HL=1 LIGA_SNAPSHOT_OUT=$FORWARDPANIKA_SNAPSHOT LIGA_PREFIX=liga-hl LIGA_START_USD=10000 LIGA_ASSETS=$LIGAHL_AKTYWA LIGA_GRACZE=$LIGAHL_GRACZE" ;;
    forwardpanika) PLIK="liga.mjs"
           USTAW="LIGA_ZRODLO=hl LIGA_TEST_CZAS=1 LIGA_FUNDING_HL=1 LIGA_KONTEKST_WYMAGANY=1 LIGA_SNAPSHOT_IN=$FORWARDPANIKA_SNAPSHOT LIGA_SNAPSHOT_MAX_AGE_MS=120000 LIGA_PREFIX=forward-panika LIGA_START_USD=10000 LIGA_ASSETS=$LIGAHL_AKTYWA LIGA_GRACZE=$FORWARDPANIKA_GRACZE LIGA_MAX_POZYCJI=2 LIGA_ALLOC_PCT=0.10 LIGA_MALPA_SZANSA=0.02041389128443849 PERP_OPEN_FEE=0.00045 PERP_BORROW_LONG_H=0 PERP_BORROW_SHORT_H=0" ;;
    ligab) PLIK="liga.mjs"
           USTAW="LIGA_PREFIX=liga-b LIGA_ASSETS=$LIGAB_AKTYWA LIGA_GRACZE=$LIGAAB_GRACZE LIGA_MAX_POZYCJI=10 LIGA_ALLOC_PCT=0.08" ;;
    realny) PLIK="realny.mjs" ;;
    # STADO — kilka botow na PRAWDZIWYCH pieniadzach, kazdy na WLASNYM koncie
    # Hyperliquid. Osobne konta, a nie subkonta, bo te wymagaja 100 tys. USD
    # obrotu; trzy zwykle portfele daja to samo rozdzielenie pozycji.
    #
    # Bez rozdzielenia to nie byloby stado, tylko jeden bot o pomieszanych
    # sygnalach: gielda widzi jeden rachunek i jedna pozycje na rynek, wiec
    # long Smyczy i short Sita 5 na tym samym aktywie zniosly by sie nawzajem.
    #
    # Konfiguracja w deploy/.env, po jednym komplecie na bota:
    #   STADO="smycz sito5 trend"
    #   KONTO_SMYCZ=0x...   AGENT_SMYCZ=0x...   START_SMYCZ=37
    stado)
      if [ -z "${STADO:-}" ]; then
        log "stado: brak zmiennej STADO w deploy/.env — pomijam"
        continue
      fi
      # Sklad efektywny: ze STADO wypadaja boty, ktorych konto ktos przejmuje,
      # a wchodza ci, ktorzy przejmuja. Dzieki temu podmiana idzie przez git,
      # a deploy/.env na serwerze zostaje nietkniety.
      #
      # POPRZEDNIK ZNIKA DOPIERO, GDY JEST PLASKI. Wczesniej bylo tak, ze bot
      # przejmowany wypadal ze skladu od razu, a przejmujacy odbijal sie od
      # bezpiecznika ("ma otwarte pozycje") i tez nie wchodzil. Wynik: w tym
      # jednym przebiegu NIE CHODZIL ZADEN Z NICH, a lewarowana pozycja
      # zostawala bez opieki — stop i take profit sa u nas wirtualne, wiec
      # pilnuje ich wylacznie petla wyjsc wlasnego bota.
      #
      # Teraz poprzednik zostaje w skladzie (w trybie wygaszania, bo trafia
      # tez na liste WYGASZANE_EFEKT nizej), a nastepca czeka na swoja kolej.
      # Podmiana dzieje sie sama, w pierwszym przebiegu po zamknieciu pozycji.
      STADO_EFEKT=""
      for g in $STADO; do
        GDUZE=$(echo "$g" | tr '[:lower:]' '[:upper:]')
        POMIN=0
        for para in ${STADO_PRZEJMUJE:-}; do
          if [ "${para#*:}" = "$GDUZE" ] && [ "$(stado_otwarte "$g")" = "0" ]; then
            POMIN=1
          fi
        done
        [ "$POMIN" = "0" ] && STADO_EFEKT="$STADO_EFEKT $g"
      done
      # Poprzednicy zawsze wygaszani: gdy sa jeszcze w skladzie, maja dokonczyc
      # otwarte i nie otwierac nowych. Gdy sa plascy, i tak ich tu nie ma.
      WYGASZANE_EFEKT="${STADO_WYGASZANE:-}"
      for para in ${STADO_PRZEJMUJE:-}; do
        NASTEPCA="${para%%:*}"
        PRZED=$(echo "${para#*:}" | tr '[:upper:]' '[:lower:]')
        case " $WYGASZANE_EFEKT " in
          *" $PRZED "*) ;;
          *) WYGASZANE_EFEKT="$WYGASZANE_EFEKT $PRZED" ;;
        esac
        if [ "$(stado_otwarte "$PRZED")" = "0" ]; then
          STADO_EFEKT="$STADO_EFEKT $NASTEPCA"
        else
          log "stado/$NASTEPCA: czeka — $PRZED ma jeszcze otwarta pozycje, wygaszam poprzednika"
        fi
      done

      for gracz in $STADO_EFEKT; do
        DUZE=$(echo "$gracz" | tr '[:lower:]' '[:upper:]')
        # Bot przejmujacy czyta zmienne konta POPRZEDNIKA, nie swoje wlasne.
        POPRZEDNIK=""
        for para in ${STADO_PRZEJMUJE:-}; do
          if [ "${para%%:*}" = "$gracz" ]; then
            DUZE="${para#*:}"
            POPRZEDNIK=$(echo "$DUZE" | tr '[:upper:]' '[:lower:]')
          fi
        done
        # ── BEZPIECZNIK PRZEJECIA ────────────────────────────────────────
        #
        # Nie wolno wejsc na konto, na ktorym poprzednik ma jeszcze OTWARTA
        # POZYCJE. Stop i take profit sa u nas wirtualne — pilnuje ich petla
        # wyjsc tamtego bota. Gdyby przestal chodzic z otwarta pozycja,
        # zostalaby ona bez ochrony az do likwidacji, a nowy bot nic o niej
        # nie wie, bo ma wlasny plik stanu.
        if [ -n "$POPRZEDNIK" ]; then
          OTWARTE=$(stado_otwarte "$POPRZEDNIK")
          if [ "${OTWARTE:-0}" != "0" ]; then
            log "stado/$gracz: POPRZEDNIK $POPRZEDNIK MA $OTWARTE OTWARTYCH POZYCJI — nie przejmuje konta"
            continue
          fi
          log "stado/$gracz: przejmuje konto po $POPRZEDNIK (poprzednik plaski)"
        fi
        # Odczyt zmiennych po nazwie gracza: KONTO_SMYCZ, AGENT_SMYCZ, START_SMYCZ.
        eval "KONTO=\${KONTO_$DUZE:-}"
        eval "AGENT=\${AGENT_$DUZE:-}"
        eval "START=\${START_$DUZE:-}"
        # ── WYGASZANIE ────────────────────────────────────────────────────
        #
        # Bot z tej listy ma DOKONCZYC to, co ma otwarte, i nie wchodzic
        # w nic nowego. NIE wolno go po prostu usunac ze STADO: stop, take
        # profit i smycz sa u nas WIRTUALNE — na gieldzie nie wisi zadne
        # zlecenie zabezpieczajace, wiec bot, ktory przestaje sie uruchamiac,
        # zostawia lewarowana pozycje bez ochrony az do likwidacji.
        #
        # REALNY_MAX_TREJDOW tez nie zadziala jako stala liczba. Po ustawieniu
        # `koniec` realny.mjs przy nastepnym przebiegu robi process.exit(0)
        # PRZED petla wyjsc — czyli dokladnie ten sam problem.
        #
        # Dziala natomiast limit liczony CO PRZEBIEG jako `zamkniete + otwarte`:
        #   - wejscia sa blokowane zawsze (zamkniete + otwarte >= limit),
        #   - `koniec` zapada dopiero wtedy, gdy otwartych jest zero,
        #     bo tylko wtedy zamkniete >= limit.
        # Bot pilnuje wiec swojej pozycji do konca, a wygasa sam, gdy jest plaski.
        LIMIT=0
        for w in ${WYGASZANE_EFEKT:-}; do
          if [ "$w" = "$gracz" ]; then
            LIMIT=$(node -e '
              const fs = require("fs");
              try {
                const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
                const otw = Object.keys(s.pozycje || {}).length;
                // Minimum 1, bo limit 0 znaczy w realny.mjs "bez limitu".
                process.stdout.write(String(Math.max(1, (s.zamkniete || 0) + otw)));
              } catch { process.stdout.write("1"); }
            ' "$KATALOG/state/stado-$gracz-state.json" 2>/dev/null || echo 1)
            log "stado/$gracz: WYGASZANIE — limit $LIMIT (dokancza otwarte, nie otwiera nowych)"
          fi
        done
        if [ -z "$KONTO" ] || [ -z "$AGENT" ]; then
          log "stado/$gracz: brak KONTO_$DUZE albo AGENT_$DUZE — pomijam tego bota"
          continue
        fi
        # Rozproszenie: nadpisuje domyslne miejsca/alloc tylko wskazanym graczom.
        MIEJSC=""; ALLOC=""
        for wpis in ${STADO_ROZPROSZENIE:-}; do
          if [ "${wpis%%:*}" = "$gracz" ]; then
            reszta="${wpis#*:}"
            MIEJSC="${reszta%%:*}"
            ALLOC="${reszta#*:}"
            log "stado/$gracz: rozproszenie $MIEJSC miejsc po $ALLOC"
          fi
        done

        log "--- stado/$gracz (realny.mjs) ---"
        # Kazdy bot ma WLASNY prefiks stanu, wlasne konto i wlasny klucz agenta.
        # Tak samo jak liga/ligab: jeden plik, kilka konfiguracji.
        #
        # BEZ progu przerwania (REALNY_STOP_KAPITAL=0) — swiadoma decyzja.
        # Pomiar (bot/cache/spr-stop.mjs) pokazal, ze prog -30% wylaczylby Smycz
        # w 90% miesiecy, a Trend w 86%, czyli eksperyment konczylby sie bez
        # wyniku. Zostaje naturalna podloga: ponizej ~8,33 USD zlecenie schodzi
        # pod minimum gieldy (10 USD nominalu) i bot po prostu przestaje wchodzic.
        if env \
            REALNY_PREFIKS="stado-$gracz" \
            REALNY_GRACZ="$gracz" \
            REALNY_KONTO="$KONTO" \
            REALNY_AGENT_KEY="$AGENT" \
            REALNY_START_USD="${START:-37}" \
            REALNY_MAX_TREJDOW="$LIMIT" \
            REALNY_PO="$POPRZEDNIK" \
            REALNY_STOP_KAPITAL=0 \
            ${MIEJSC:+REALNY_MIEJSC=$MIEJSC} \
            ${ALLOC:+REALNY_ALLOC=$ALLOC} \
            node realny.mjs >>"$LOG" 2>&1; then
          log "stado/$gracz OK"
        else
          log "stado/$gracz zakonczyl sie bledem (kod $?)"
        fi
      done
      continue ;;
    *) log "nieznany bot: $bot"; continue ;;
  esac
  log "--- $bot ($PLIK) ---"
  if env $USTAW node "$PLIK" >>"$LOG" 2>&1; then
    log "$bot OK"
  else
    log "$bot zakonczyl sie bledem (kod $?)"
  fi
done

# Kolektor danych spoza wykresu. Sam sie throttluje do co 15 minut, wiec
# mozna go wolac przy kazdym przebiegu. Jego blad nie moze zatrzymac bota.
if [ "${KOLEKTOR:-1}" = "1" ]; then
  if node kolektor.mjs >>"$LOG" 2>&1; then :; else log "kolektor zakonczyl sie bledem"; fi
fi
cd "$KATALOG"

# Zapis stanu do repo — apka czyta go wlasnie stamtad
if [ -z "$(git status --porcelain -- state 2>/dev/null)" ]; then
  log "stan bez zmian"
  exit 0
fi

# ── LOG WYCHODZI Z SERWERA RAZEM ZE STANEM ─────────────────────────────────
#
# Sito 5 przestalo chodzic 04.08 o 17:20 i przez kilkanascie godzin nie dalo sie
# powiedziec dlaczego, bo log siedzi WYLACZNIE na serwerze. Diagnoza z zewnatrz
# sprowadzala sie do zgadywania — a zgadywanie trzy razy z rzedu to nie diagnoza.
#
# Publikujemy wiec ogon logu razem ze stanem. Nie caly plik: tylko ostatnie
# linie, i tylko te, ktore cos znacza (bledy, pominiecia, wygaszenia), plus
# jedna linia na bota z ostatniego przebiegu.
#
# Uwaga na sekrety: log nie zawiera kluczy ani adresow kont — `realny.mjs`
# drukuje wylacznie nazwy graczy i wyniki. Filtr ponizej i tak przepuszcza
# tylko dopasowane wzorce, zamiast zrzucac plik w ciemno.
{
  echo "# ogon logu serwera, $(date -u '+%Y-%m-%d %H:%M UTC')"
  echo "# publikowany po to, zeby dalo sie diagnozowac bota bez dostepu do maszyny"
  echo
  grep -E 'stado/|BLAD|blad|bledem|pomijam|WYGASZANIE|nieudan|brak |UWAGA' "$LOG" 2>/dev/null | tail -40
  echo
  echo "# --- surowy ogon logu (adresy zamaskowane) ---"
  # Sam filtr nie wystarczyl: "stado/sito5 zakonczyl sie bledem (kod 1)" mowi, ZE
  # sie wywalilo, ale nie DLACZEGO — komunikat node'a nie pasuje do zadnego wzorca.
  # Bierzemy wiec takze surowy ogon, maskujac adresy 0x... i dlugie ciagi hex,
  # zeby do repozytorium nie trafil zaden identyfikator konta ani klucz.
  tail -50 "$LOG" 2>/dev/null | sed -E 's/0x[0-9a-fA-F]{6,}/0x…/g; s/[0-9a-fA-F]{32,}/…/g'
} > "$KATALOG/state/logi-ostatnie.txt" 2>/dev/null || true

# --- Powiadomienia o zamknietych trejdach -----------------------------------
#
# PO botach, a PRZED commitem — plik ze znacznikami (state/powiadomienia.json)
# ma trafic do repo w tym samym commicie co trejdy, ktore zglosil. Inaczej po
# odtworzeniu maszyny z repozytorium znaczniki byłyby starsze niz trejdy
# i telefon dostalby drugi raz to samo.
#
# Wymaga EXPO_PUSH_TOKEN w deploy/.env. Bez niego skrypt sam sie pomija.
# POWIADOM_MIN_ZL ustawia prog kwotowy (domyslnie 0, czyli wszystko).
#
# `|| true`, bo powiadomienia nie moga przewrocic publikacji stanu — stan bota
# jest wazniejszy niz brzeczyk w telefonie.
if [ -f "$KATALOG/bot/powiadom.mjs" ]; then
  (cd "$KATALOG/bot" && node powiadom.mjs >>"$LOG" 2>&1) || true
fi

# Powiadomienia o koparce — osobny skrypt, bo zrodlo danych i zdarzenia sa inne:
# blok, rekord i MILCZENIE. To ostatnie jest najwazniejsze, bo o zaniku pradu
# w domu inaczej dowiesz sie dopiero, gdy sam zajrzysz do apki.
if [ -f "$KATALOG/bot/koparka.mjs" ]; then
  (cd "$KATALOG/bot" && node koparka.mjs >>"$LOG" 2>&1) || true
fi

git config user.name "hajsomat-bot"
git config user.email "bot@users.noreply.github.com"
git add state
git commit -q -m "stan bota $(date -u '+%Y-%m-%d %H:%M UTC') [skip ci]" 2>>"$LOG"

if [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_REPO:-}" ]; then
  URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
else
  URL="origin"
fi

for i in 1 2 3; do
  if git pull --rebase --autostash --quiet "$URL" "$GALAZ" 2>>"$LOG" \
     && git push --quiet "$URL" "HEAD:$GALAZ" 2>>"$LOG"; then
    log "stan wypchniety"
    exit 0
  fi
  log "push nieudany, proba $i"
  # ── SAMONAPRAWA PO PRZEPISANIU HISTORII ─────────────────────────────────
  #
  # Gdy historia na origin zostala przepisana (usuniecie plikow z calej
  # historii + force push), rebase nie znajduje wspolnego przodka i zostaje
  # w polowie albo probuje przegrac tysiace commitow. Bez tej sekcji pipeline
  # stanu klablby sie co 5 minut az do recznej interwencji na serwerze.
  #
  # Naprawa: przerwij rebase, zrownaj sie z origin. Kosztuje jeden przebieg
  # stanu (nastepny odtworzy go z gieldy i danych), zyskuje zywy pipeline.
  if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    git rebase --abort 2>>"$LOG" || true
    if git fetch "$URL" "$GALAZ" 2>>"$LOG" && git reset --hard FETCH_HEAD 2>>"$LOG"; then
      log "historia na origin przepisana - zrownalem sie z origin i jade dalej"
    fi
  fi
  sleep 5
done

log "NIE UDALO SIE wypchnac stanu"
exit 1
