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
BOTY="${*:-perp liga ligab ligac stado}"

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
STADO_PRZEJMUJE="panika:SMYCZ panikaLuzna:TREND"

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
      STADO_EFEKT=""
      for g in $STADO; do
        GDUZE=$(echo "$g" | tr '[:lower:]' '[:upper:]')
        POMIN=0
        for para in ${STADO_PRZEJMUJE:-}; do
          [ "${para#*:}" = "$GDUZE" ] && POMIN=1
        done
        [ "$POMIN" = "0" ] && STADO_EFEKT="$STADO_EFEKT $g"
      done
      for para in ${STADO_PRZEJMUJE:-}; do
        STADO_EFEKT="$STADO_EFEKT ${para%%:*}"
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
          OTWARTE=$(node -e '
            const fs = require("fs");
            try {
              const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
              process.stdout.write(String(Object.keys(s.pozycje || {}).length));
            } catch { process.stdout.write("0"); }
          ' "$KATALOG/state/stado-$POPRZEDNIK-state.json" 2>/dev/null || echo 0)
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
        for w in ${STADO_WYGASZANE:-}; do
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
  grep -E 'stado/|BLAD|blad|bledem|pomijam|WYGASZANIE|nieudan|brak |UWAGA' "$LOG" 2>/dev/null | tail -60
} > "$KATALOG/state/logi-ostatnie.txt" 2>/dev/null || true

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
  sleep 5
done

log "NIE UDALO SIE wypchnac stanu"
exit 1
