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
# Liga botow chodzi obok — pieciu graczy na osobnych portfelach.
# Zeby dorzucic spot:  run.sh trade perp liga
BOTY="${*:-perp liga}"

# Zabierz to, co przyszlo z zewnatrz (np. zmiany kodu wypchniete z komputera)
git fetch origin "$GALAZ" --quiet 2>>"$LOG" || log "fetch nieudany"
git merge --ff-only "origin/$GALAZ" --quiet 2>>"$LOG" || log "nie moge przewinac galezi (lokalne zmiany?)"

cd "$KATALOG/bot"
for bot in $BOTY; do
  case "$bot" in
    trade) PLIK="trade.mjs" ;;
    perp)  PLIK="perpbot.mjs" ;;
    liga)  PLIK="liga.mjs" ;;
    *) log "nieznany bot: $bot"; continue ;;
  esac
  log "--- $PLIK ---"
  if node "$PLIK" >>"$LOG" 2>&1; then
    log "$PLIK OK"
  else
    log "$PLIK zakonczyl sie bledem (kod $?)"
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
