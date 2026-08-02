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
# Od 31.07.2026 chodzi tez `realny` — bot na Hyperliquid, ktory ma zmierzyc,
# ile NAPRAWDE kosztuje wejscie i wyjscie. Domyslnie w trybie suchym
# (REALNY_SUCHY nieustawione = 1), a tryb zywy nie jest jeszcze napisany —
# wiec dzis nie ma mozliwosci, zeby wydal choc grosz. Zeby to zmienilo sie
# swiadomie, a nie przypadkiem, wlaczenie wymaga REALNY_SUCHY=0 w deploy/.env
# ORAZ dopisania obslugi podpisywania zlecen w bot/realny.mjs.
#
# Od 02.08.2026 `realny` ustepuje miejsca `stado` — kilku botom na prawdziwych
# pieniadzach, kazdemu na wlasnym koncie. Stary `realny` zostaje w case-u, zeby
# dalo sie do niego wrocic jednym slowem, ale domyslnie juz nie chodzi.
#
# Zeby dorzucic spot:  run.sh trade perp liga ligab stado
BOTY="${*:-perp liga ligab stado}"

# Uniwersum Ligi B — 24 alty, wszystkie notowane przez Krakena (Binance oddaje
# 451 z amerykanskiego IP, wiec to jedyne zrodlo swiec na tym serwerze).
LIGAB_AKTYWA="1INCH,ALCX,ARB,ASTR,AVA,BCH,CELO,CTSI,EDU,FIDA,GALA,HFT,JST,LQTY,MASK,NEO,OGN,QNT,RLC,SAND,STORJ,SUPER,VET,YFI"

# Zabierz to, co przyszlo z zewnatrz (np. zmiany kodu wypchniete z komputera)
git fetch origin "$GALAZ" --quiet 2>>"$LOG" || log "fetch nieudany"
git merge --ff-only "origin/$GALAZ" --quiet 2>>"$LOG" || log "nie moge przewinac galezi (lokalne zmiany?)"

cd "$KATALOG/bot"
for bot in $BOTY; do
  USTAW=""
  case "$bot" in
    trade) PLIK="trade.mjs" ;;
    perp)  PLIK="perpbot.mjs" ;;
    liga)  PLIK="liga.mjs" ;;
    # Ta sama liga.mjs, inna konfiguracja — bez drugiej kopii mechaniki,
    # ktora po miesiacu rozjechalaby sie z pierwsza.
    ligab) PLIK="liga.mjs"
           USTAW="LIGA_PREFIX=liga-b LIGA_ASSETS=$LIGAB_AKTYWA LIGA_MAX_POZYCJI=10 LIGA_ALLOC_PCT=0.08" ;;
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
      for gracz in $STADO; do
        DUZE=$(echo "$gracz" | tr '[:lower:]' '[:upper:]')
        # Odczyt zmiennych po nazwie gracza: KONTO_SMYCZ, AGENT_SMYCZ, START_SMYCZ.
        eval "KONTO=\${KONTO_$DUZE:-}"
        eval "AGENT=\${AGENT_$DUZE:-}"
        eval "START=\${START_$DUZE:-}"
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
            REALNY_MAX_TREJDOW=0 \
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
