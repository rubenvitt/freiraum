#!/usr/bin/env bash
# Test für check-rpaths.sh mit nachgebildeter otool-Ausgabe (otool gibt es nur am Mac).
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/check-rpaths.sh"
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

# App-Bundle mit eingebettetem Sparkle.framework
APP="$TMP/Freiraum.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
touch "$APP/Contents/MacOS/Freiraum" "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle"

# Falsches otool: gibt je nach RPATH-Variable die Ausgabe von `otool -l` bzw. `otool -L` aus.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/otool" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-l" ]; then
  for rp in $FAKE_RPATHS; do
    printf 'Load command 30\n          cmd LC_RPATH\n      cmdsize 32\n         path %s (offset 12)\n' "$rp"
  done
else
  echo "$2 (architecture arm64):"
  printf '\t@rpath/Sparkle.framework/Versions/B/Sparkle (compatibility version 1.6.0, current version 2.10.1)\n'
  printf '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)\n'
fi
EOF
chmod +x "$TMP/bin/otool"

run() { FAKE_RPATHS="$1" PATH="$TMP/bin:$PATH" bash "$SCRIPT" "$APP" > "$TMP/stdout" 2> "$TMP/stderr"; }

# Fehlerfall aus Release 0.1.5: iOS-Suchpfad, Framework wird nicht gefunden
run "/usr/lib/swift @executable_path/Frameworks"
check "iOS-Suchpfad: Exit 1" 1 "$?"
check "iOS-Suchpfad: ::error:: nennt Sparkle" 1 "$(grep -c '^::error::@rpath/Sparkle.framework/Versions/B/Sparkle' "$TMP/stdout")"

# Richtiger Mac-Suchpfad
run "/usr/lib/swift @executable_path/../Frameworks"
check "Mac-Suchpfad: Exit 0" 0 "$?"
check "Mac-Suchpfad: keine Ausgabe" "" "$(cat "$TMP/stdout")"

# Gar kein LC_RPATH
run ""
check "ohne LC_RPATH: Exit 1" 1 "$?"

# Fehlendes Bundle
FAKE_RPATHS="@executable_path/../Frameworks" PATH="$TMP/bin:$PATH" bash "$SCRIPT" "$TMP/fehlt.app" > /dev/null 2>&1
check "fehlendes Bundle: Exit 2" 2 "$?"

if [ "$FAILS" -gt 0 ]; then
  echo "test-check-rpaths: $FAILS von $CHECKS Prüfungen fehlgeschlagen"
  exit 1
fi
echo "test-check-rpaths: alle $CHECKS Prüfungen bestanden"
