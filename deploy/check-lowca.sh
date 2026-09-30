#!/usr/bin/env bash
# Owner-run, read-only account preflight. Does not run a trading loop.
set -euo pipefail
set +x
KATALOG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$KATALOG"
if [ ! -f deploy/.env ]; then
  echo 'Brak deploy/.env w katalogu Hajsomat.' >&2
  exit 1
fi
# Trusted private configuration; never print/export its contents here.
# shellcheck disable=SC1091
. deploy/.env
if [ -z "${KONTO_SITO5:-}" ]; then
  echo 'Brak KONTO_SITO5; nie wklejaj tutaj kluczy.' >&2
  exit 1
fi
REALNY_KONTO="$KONTO_SITO5" node bot/realny-lowca.mjs --account-check
