#!/usr/bin/env bash
# Test für appcast.sh: erzeugt Appcasts und prüft sie mit xmllint.
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/appcast.sh"
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

xp() { xmllint --xpath "$1" "$2" 2>/dev/null; }

# Fall 1: Normalfall
URL="https://example.invalid/releases/download/macos-v0.1.57/Freiraum.dmg"
NOTES="https://example.invalid/releases/tag/macos-v0.1.57"
"$SCRIPT" --version 0.1.57 --build 57 --url "$URL" --length 12345 \
  --signature "c2lnbmF0dXJlPT0=" --notes-url "$NOTES" > "$TMP/a.xml"
check "Exit-Code Normalfall" 0 $?
xmllint --noout "$TMP/a.xml" 2>/dev/null
check "XML wohlgeformt" 0 $?
check "Version" "0.1.57" "$(xp 'string(//*[local-name()="shortVersionString"])' "$TMP/a.xml")"
check "Build" "57" "$(xp 'string(//*[local-name()="version"])' "$TMP/a.xml")"
check "Titel" "Freiraum 0.1.57" "$(xp 'string(//item/title)' "$TMP/a.xml")"
check "Mindestsystem" "26.0" "$(xp 'string(//*[local-name()="minimumSystemVersion"])' "$TMP/a.xml")"
check "Länge" "12345" "$(xp 'string(//enclosure/@length)' "$TMP/a.xml")"
check "Signatur" "c2lnbmF0dXJlPT0=" "$(xp 'string(//enclosure/@*[local-name()="edSignature"])' "$TMP/a.xml")"
check "URL" "$URL" "$(xp 'string(//enclosure/@url)' "$TMP/a.xml")"
check "Typ" "application/octet-stream" "$(xp 'string(//enclosure/@type)' "$TMP/a.xml")"
check "Notes-Link" "$NOTES" "$(xp 'string(//*[local-name()="fullReleaseNotesLink"])' "$TMP/a.xml")"
PUB="$(xp 'string(//pubDate)' "$TMP/a.xml")"
case "$PUB" in
  [A-Z][a-z][a-z],\ [0-9][0-9]\ [A-Z][a-z][a-z]\ [0-9][0-9][0-9][0-9]\ [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\ +0000) check "pubDate Format" ok ok ;;
  *) check "pubDate Format" "RFC 822" "$PUB" ;;
esac

# Fall 2: Sonderzeichen werden escaped
SPECIAL='https://example.invalid/r?a=1&b=2&c="<x>"'
"$SCRIPT" --version 0.1.58 --build 58 --url "$SPECIAL" --length 1 \
  --signature "sig" --notes-url "$SPECIAL" > "$TMP/b.xml"
check "Exit-Code Sonderzeichen" 0 $?
xmllint --noout "$TMP/b.xml" 2>/dev/null
check "XML mit Sonderzeichen wohlgeformt" 0 $?
check "Notes-URL mit & unverändert" "$SPECIAL" "$(xp 'string(//*[local-name()="fullReleaseNotesLink"])' "$TMP/b.xml")"
check "Enclosure-URL mit Sonderzeichen unverändert" "$SPECIAL" "$(xp 'string(//enclosure/@url)' "$TMP/b.xml")"

# Fall 3: fehlendes Argument -> Exit 2
"$SCRIPT" --version 0.1.57 --build 57 --url "$URL" --length 1 \
  --notes-url "$NOTES" > "$TMP/c.xml" 2> "$TMP/c.err"
check "Exit-Code ohne --signature" 2 $?
[ -s "$TMP/c.err" ]
check "Fehlermeldung vorhanden" 0 $?

if [ "$FAILS" -ne 0 ]; then
  echo "test-appcast: $FAILS von $CHECKS Prüfungen fehlgeschlagen"
  exit 1
fi
echo "test-appcast: alle $CHECKS Prüfungen bestanden"
