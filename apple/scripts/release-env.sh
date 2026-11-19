#!/usr/bin/env bash
# Hilfsfunktionen für den Mac-Release-Job.
#   release-env.sh check
#       Prüft Signatur-Secrets und Variablen aus der Umgebung und schreibt
#       enabled=true|false nach $GITHUB_OUTPUT (ohne GITHUB_OUTPUT: nach stdout).
#       Keine Secrets: Warnung, enabled=false, Exit 0. Alle: enabled=true.
#       Teilweise oder Variablen fehlen: Fehler, Exit 1. Werte werden nie ausgegeben.
#   release-env.sh version <project.yml> <run_number>
#       Gibt <Major>.<Minor>.<run_number> aus (MARKETING_VERSION aus project.yml).
# Läuft mit bash 3.2 (macOS) und auf Linux.
set -euo pipefail

SECRETS="MACOS_CERTIFICATE_P12 MACOS_CERTIFICATE_PASSWORD MACOS_PROVISIONING_PROFILE ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 SPARKLE_PRIVATE_KEY"
VARS="APPLE_TEAM_ID FREIRAUM_BUNDLE_PREFIX FREIRAUM_DOMAIN SPARKLE_PUBLIC_KEY"

ausgabe() { # enabled-Wert ausgeben
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "enabled=$1" >> "$GITHUB_OUTPUT"
  else
    echo "enabled=$1"
  fi
}

fehlende() { # Namen aus der Liste $1, die leer oder ungesetzt sind, kommagetrennt
  local name out=""
  for name in $1; do
    if [ -z "${!name:-}" ]; then
      out="${out:+$out, }$name"
    fi
  done
  printf '%s' "$out"
}

befehl_check() {
  local fehlt_s fehlt_v
  fehlt_s="$(fehlende "$SECRETS")"
  fehlt_v="$(fehlende "$VARS")"

  if [ "$fehlt_s" = "${SECRETS// /, }" ]; then
    echo "::warning::Signatur-Secrets nicht konfiguriert: Es wird kein Release erstellt."
    ausgabe false
    return 0
  fi

  local alle="$fehlt_s"
  if [ -n "$fehlt_v" ]; then
    alle="${alle:+$alle, }$fehlt_v"
  fi
  if [ -n "$alle" ]; then
    echo "::error::Es fehlen: $alle"
    return 1
  fi
  ausgabe true
}

befehl_version() {
  [ $# -eq 2 ] || { echo "Aufruf: release-env.sh version <project.yml> <run_number>" >&2; exit 2; }
  local datei="$1" lauf="$2" zeile ver
  [ -f "$datei" ] || { echo "release-env.sh: Datei nicht gefunden: $datei" >&2; exit 1; }
  case "$lauf" in
    ''|*[!0-9]*) echo "release-env.sh: run_number muss eine Zahl sein: $lauf" >&2; exit 1 ;;
  esac
  zeile="$(grep -E '^[[:space:]]*MARKETING_VERSION:' "$datei" | head -n 1 || true)"
  [ -n "$zeile" ] || { echo "release-env.sh: MARKETING_VERSION fehlt in $datei" >&2; exit 1; }
  ver="$(printf '%s' "$zeile" | sed -E 's/^[[:space:]]*MARKETING_VERSION:[[:space:]]*//; s/[[:space:]]+#.*$//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
  case "$ver" in
    [0-9]*.[0-9]*)
      case "$ver" in
        *[!0-9.]*|*.*.*|.*|*.) ver="" ;;
      esac
      ;;
    *) ver="" ;;
  esac
  [ -n "$ver" ] || { echo "release-env.sh: MARKETING_VERSION muss die Form <Zahl>.<Zahl> haben (Zeile: $zeile)" >&2; exit 1; }
  echo "$ver.$lauf"
}

case "${1:-}" in
  check) befehl_check ;;
  version) shift; befehl_version "$@" ;;
  *) echo "Aufruf: release-env.sh check | version <project.yml> <run_number>" >&2; exit 2 ;;
esac
