#!/usr/bin/env bash
# Prüft, dass jede @rpath-Bibliothek der App über einen LC_RPATH im Bundle gefunden wird.
# Sonst bricht dyld beim Start ab („kann nicht geöffnet werden“), etwa wenn die Mac-App mit
# dem iOS-Suchpfad @executable_path/Frameworks gebaut wurde.
# Aufruf: check-rpaths.sh <Pfad/Freiraum.app>   Exit 0 = alles gefunden, 1 = Fehler, 2 = Aufruf.
set -euo pipefail

app="${1:-}"
binaer="$app/Contents/MacOS/Freiraum"
if [ -z "$app" ] || [ ! -f "$binaer" ]; then
  echo "Aufruf: check-rpaths.sh <Pfad/Freiraum.app>" >&2
  exit 2
fi

rpaths="$(otool -l "$binaer" | awk '/cmd LC_RPATH/ { getline; getline; print $2 }' | sort -u)"
libs="$(otool -L "$binaer" | awk '$1 ~ /^@rpath\// { print $1 }' | sort -u)"

fehler=0
for lib in $libs; do
  gefunden=no
  for rp in $rpaths; do
    ziel="${rp/@executable_path/$app/Contents/MacOS}/${lib#@rpath/}"
    if [ -e "$ziel" ]; then gefunden=yes; fi
  done
  if [ "$gefunden" != yes ]; then
    echo "::error::$lib wird über keinen LC_RPATH gefunden (Suchpfade: ${rpaths//$'\n'/ })"
    fehler=1
  fi
done
exit "$fehler"
