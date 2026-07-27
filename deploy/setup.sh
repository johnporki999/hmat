#!/usr/bin/env bash
#
# Jednorazowa instalacja na swiezym serwerze (Debian/Ubuntu).
#
# Uruchom NA SERWERZE:
#   curl -fsSL https://raw.githubusercontent.com/UZYTKOWNIK/REPO/main/deploy/setup.sh | bash -s -- UZYTKOWNIK/REPO
#
# albo, jesli repo juz sklonowales:
#   bash deploy/setup.sh

set -euo pipefail

REPO="${1:-}"
KATALOG="$HOME/hajsomat"

echo "=== Hajsomat — instalacja na serwerze ==="

# ── Node ─────────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "--- instaluje Node 24 ---"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node --version)"

# ── git, flock ───────────────────────────────────────────────────────────────
sudo apt-get install -y git util-linux >/dev/null 2>&1 || true

# ── kod ──────────────────────────────────────────────────────────────────────
if [ -d "$KATALOG/.git" ]; then
  echo "--- repo juz jest, aktualizuje ---"
  git -C "$KATALOG" pull --ff-only
elif [ -n "$REPO" ]; then
  echo "--- pobieram $REPO ---"
  git clone "https://github.com/${REPO}.git" "$KATALOG"
else
  echo "Podaj repozytorium, np.: bash setup.sh johnporki999/hmat"
  exit 1
fi

cd "$KATALOG"

# ── zaleznosci bota ──────────────────────────────────────────────────────────
echo "--- instaluje zaleznosci ---"
( cd bot && npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund )

# ── ustawienia ───────────────────────────────────────────────────────────────
if [ ! -f deploy/.env ]; then
  cp deploy/hajsomat.env.example deploy/.env
  chmod 600 deploy/.env
  echo ""
  echo ">>> UZUPELNIJ USTAWIENIA:  nano $KATALOG/deploy/.env"
  echo ">>> Najwazniejsze: GITHUB_TOKEN i GITHUB_REPO"
  echo ""
fi

chmod +x deploy/run.sh

# ── harmonogram ──────────────────────────────────────────────────────────────
WPIS="*/5 * * * * $KATALOG/deploy/run.sh >/dev/null 2>&1"
if crontab -l 2>/dev/null | grep -Fq "$KATALOG/deploy/run.sh"; then
  echo "--- harmonogram juz ustawiony ---"
else
  # UWAGA na pulapke: przy "set -e" polecenie crontab -l na maszynie bez
  # zadnego harmonogramu konczy sie bledem i ubija caly podshell, zanim echo
  # zdazy cokolwiek dopisac. Efekt: do crontab trafia pusty tekst, czyli
  # kasujemy harmonogram zamiast go zalozyc, a skrypt raportuje sukces.
  # Dlatego "|| true" i nawiasy klamrowe zamiast okraglych.
  { crontab -l 2>/dev/null || true; echo "$WPIS"; } | crontab -

  # Nie ufamy, ze sie udalo — sprawdzamy.
  if crontab -l 2>/dev/null | grep -Fq "$KATALOG/deploy/run.sh"; then
    echo "--- harmonogram ustawiony: co 5 minut ---"
  else
    echo ""
    echo "!!! NIE UDALO SIE ustawic harmonogramu. Dodaj go recznie:"
    echo "    (crontab -l 2>/dev/null; echo '$WPIS') | crontab -"
    echo ""
  fi
fi

echo ""
echo "=== Gotowe ==="
echo "Ustawienia:  nano $KATALOG/deploy/.env"
echo "Test teraz:  $KATALOG/deploy/run.sh"
echo "Podglad:     tail -f $KATALOG/logs/hajsomat.log"
echo "Harmonogram: crontab -l"
