#!/usr/bin/env bash
# Schreibt den Sparkle-Appcast (RSS 2.0) für ein Release nach stdout.
# Aufruf: appcast.sh --version 0.1.57 --build 57 --url <dmg-url> --length <bytes> \
#                    --signature <ed-sig> --notes-url <release-url> > appcast.xml
# Läuft mit bash 3.2 (macOS) und auf Linux.
set -euo pipefail

VERSION="" BUILD="" URL="" LENGTH="" SIGNATURE="" NOTES_URL=""

fehler() {
  echo "appcast.sh: $1" >&2
  echo "Aufruf: appcast.sh --version V --build N --url URL --length BYTES --signature SIG --notes-url URL" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version|--build|--url|--length|--signature|--notes-url)
      [ $# -ge 2 ] || fehler "Wert für $1 fehlt"
      case "$1" in
        --version) VERSION="$2" ;;
        --build) BUILD="$2" ;;
        --url) URL="$2" ;;
        --length) LENGTH="$2" ;;
        --signature) SIGNATURE="$2" ;;
        --notes-url) NOTES_URL="$2" ;;
      esac
      shift 2
      ;;
    *) fehler "Unbekanntes Argument: $1" ;;
  esac
done

[ -n "$VERSION" ] || fehler "--version fehlt"
[ -n "$BUILD" ] || fehler "--build fehlt"
[ -n "$URL" ] || fehler "--url fehlt"
[ -n "$LENGTH" ] || fehler "--length fehlt"
[ -n "$SIGNATURE" ] || fehler "--signature fehlt"
[ -n "$NOTES_URL" ] || fehler "--notes-url fehlt"

# XML-Escaping per sed (& zuerst, damit die Entitäten nicht doppelt ersetzt werden).
# Bewusst kein ${s//&/...}: ab bash 5.2 steht & in der Ersetzung für den Treffer.
xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

PUB_DATE="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"

cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Freiraum für Mac</title>
    <item>
      <title>Freiraum $(xml "$VERSION")</title>
      <sparkle:version>$(xml "$BUILD")</sparkle:version>
      <sparkle:shortVersionString>$(xml "$VERSION")</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>
      <sparkle:fullReleaseNotesLink>$(xml "$NOTES_URL")</sparkle:fullReleaseNotesLink>
      <pubDate>$PUB_DATE</pubDate>
      <enclosure url="$(xml "$URL")" length="$(xml "$LENGTH")" type="application/octet-stream" sparkle:edSignature="$(xml "$SIGNATURE")"/>
    </item>
  </channel>
</rss>
XML
