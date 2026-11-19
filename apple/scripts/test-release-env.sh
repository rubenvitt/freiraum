#!/usr/bin/env bash
# Test für release-env.sh: check (keine/alle/teilweise Secrets) und version.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/release-env.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0
CHECKS=0

check() { # Beschreibung erwartet tatsächlich
  CHECKS=$((CHECKS + 1))
  if [ "$2" != "$3" ]; then
    echo "FEHLER: $1 (erwartet '$2', erhalten '$3')"
    FAILS=$((FAILS + 1))
  fi
}

SECRETS="MACOS_CERTIFICATE_P12 MACOS_CERTIFICATE_PASSWORD MACOS_PROVISIONING_PROFILE ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 SPARKLE_PRIVATE_KEY"
VARS="APPLE_TEAM_ID FREIRAUM_BUNDLE_PREFIX FREIRAUM_DOMAIN SPARKLE_PUBLIC_KEY"

# Führt `check` mit sauberer Umgebung aus. Argumente: Liste von NAME=WERT.
run_check() {
  : > "$TMP/out"
  env -i PATH="$PATH" GITHUB_OUTPUT="$TMP/out" "$@" bash "$SCRIPT" check > "$TMP/stdout" 2> "$TMP/stderr"
}

ALL=()
for n in $SECRETS; do ALL+=("$n=geheim-$n"); done
for n in $VARS; do ALL+=("$n=wert-$n"); done

# Fall 1: keine Secrets -> Warnung, enabled=false, Exit 0
run_check
check "keine Secrets: Exit-Code" 0 $?
check "keine Secrets: enabled=false" "enabled=false" "$(cat "$TMP/out")"
grep -q '^::warning::' "$TMP/stdout"
check "keine Secrets: ::warning:: ausgegeben" 0 $?

# Fall 2: alles gesetzt -> enabled=true, Exit 0, keine Secret-Werte in der Ausgabe
run_check "${ALL[@]}"
check "alle gesetzt: Exit-Code" 0 $?
check "alle gesetzt: enabled=true" "enabled=true" "$(cat "$TMP/out")"
grep -q 'geheim-' "$TMP/out" "$TMP/stdout" "$TMP/stderr"
check "alle gesetzt: keine Secret-Werte in Ausgabe" 1 $?

# Fall 3: teilweise -> Fehler mit fehlenden Namen, Exit 1
PART=()
for n in $SECRETS; do
  case "$n" in ASC_KEY_ID|SPARKLE_PRIVATE_KEY) ;; *) PART+=("$n=geheim-$n") ;; esac
done
for n in $VARS; do PART+=("$n=wert-$n"); done
run_check "${PART[@]}"
check "teilweise: Exit-Code" 1 $?
OUT="$(cat "$TMP/stdout")"
case "$OUT" in
  *"::error::Es fehlen: ASC_KEY_ID, SPARKLE_PRIVATE_KEY"*) check "teilweise: Fehlertext" ok ok ;;
  *) check "teilweise: Fehlertext" "::error::Es fehlen: ASC_KEY_ID, SPARKLE_PRIVATE_KEY" "$OUT" ;;
esac
grep -q 'geheim-' "$TMP/out" "$TMP/stdout" "$TMP/stderr"
check "teilweise: keine Secret-Werte" 1 $?
check "teilweise: kein enabled=true" "" "$(grep 'enabled=true' "$TMP/out")"

# Fall 4: Secrets gesetzt, Variable fehlt -> Fehler
NOVAR=()
for n in $SECRETS; do NOVAR+=("$n=geheim-$n"); done
for n in $VARS; do [ "$n" = "FREIRAUM_DOMAIN" ] || NOVAR+=("$n=wert-$n"); done
run_check "${NOVAR[@]}"
check "Variable fehlt: Exit-Code" 1 $?
OUT="$(cat "$TMP/stdout")"
case "$OUT" in
  *"::error::Es fehlen: FREIRAUM_DOMAIN"*) check "Variable fehlt: Fehlertext" ok ok ;;
  *) check "Variable fehlt: Fehlertext" "::error::Es fehlen: FREIRAUM_DOMAIN" "$OUT" ;;
esac

# Fall 5: ohne GITHUB_OUTPUT -> enabled=… auf stdout
env -i PATH="$PATH" bash "$SCRIPT" check > "$TMP/stdout" 2> "$TMP/stderr"
check "ohne GITHUB_OUTPUT: Exit-Code" 0 $?
grep -qx 'enabled=false' "$TMP/stdout"
check "ohne GITHUB_OUTPUT: enabled=false auf stdout" 0 $?

# version
printf 'name: Freiraum\nsettings:\n  base:\n    MARKETING_VERSION: "0.1"\n' > "$TMP/a.yml"
check "version 0.1" "0.1.57" "$("$SCRIPT" version "$TMP/a.yml" 57)"
printf 'settings:\n    MARKETING_VERSION: "0.2"\n' > "$TMP/b.yml"
check "version 0.2" "0.2.58" "$("$SCRIPT" version "$TMP/b.yml" 58)"
printf 'settings:\n    MARKETING_VERSION: 1.3\n' > "$TMP/c.yml"
check "version unquoted" "1.3.9" "$("$SCRIPT" version "$TMP/c.yml" 9)"
printf 'settings:\n    OTHER: 1\n' > "$TMP/d.yml"
"$SCRIPT" version "$TMP/d.yml" 1 > /dev/null 2> "$TMP/e"
rc=$?
check "version fehlt: Exit-Code" 1 "$rc"
[ -s "$TMP/e" ]
rc=$?
check "version fehlt: Fehlermeldung" 0 "$rc"
printf 'settings:\n    MARKETING_VERSION: "abc"\n' > "$TMP/f.yml"
"$SCRIPT" version "$TMP/f.yml" 1 > /dev/null 2>&1
rc=$?
check "version ungültig: Exit-Code" 1 "$rc"
"$SCRIPT" version "$TMP/nicht-da.yml" 1 > /dev/null 2>&1
rc=$?
check "version Datei fehlt: Exit-Code" 1 "$rc"

if [ "$FAILS" -ne 0 ]; then
  echo "test-release-env: $FAILS von $CHECKS Prüfungen fehlgeschlagen"
  exit 1
fi
echo "test-release-env: alle $CHECKS Prüfungen bestanden"
