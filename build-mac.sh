#!/bin/bash
# Build "DeepSeek Harness Remote.app" from an installed "DeepSeek Harness.app".
#
# The official app is copied, never modified. The copy keeps DeepSeek's Electron runtime and
# icon, drops the bundled local Host (runtime/, app.asar.unpacked/), and receives this
# repository's app/ as its app.asar. The copy gets its own bundle id, so it runs beside the
# official app with separate settings and storage. It is ad-hoc signed for this Mac only.
#
# Usage: ./build-mac.sh [path/to/DeepSeek Harness.app] [output dir]
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

HERE="$(cd "$(dirname "$0")" && pwd)"
# Source: an installed official app, or a `ditto -c -k --keepParent` zip of one (kept so the
# official app does not have to stay installed next to this client).
SRC_APP="${1:-}"
if [ -z "$SRC_APP" ]; then
  if [ -d "/Applications/DeepSeek Harness.app" ]; then SRC_APP="/Applications/DeepSeek Harness.app"
  else SRC_APP="$(ls -t "$HOME"/dsh-remote-work/DeepSeek-Harness-*.app.zip 2>/dev/null | head -n 1 || true)"; fi
fi
OUT_DIR="${2:-$HOME/Applications}"
NAME="DeepSeek Harness Remote"
BUNDLE_ID="${DSH_REMOTE_BUNDLE_ID:-io.github.dsh-remote-client}"
OUT_APP="$OUT_DIR/$NAME.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ "$(uname)" = Darwin ] || { echo "build-mac.sh: run this on macOS" >&2; exit 1; }
[ -n "$SRC_APP" ] || { echo "no official DeepSeek Harness.app or saved .app.zip found; pass one as the first argument" >&2; exit 1; }
if [ "${SRC_APP%.zip}" != "$SRC_APP" ]; then
  echo "== unpack $SRC_APP"
  ditto -x -k "$SRC_APP" "$WORK/src"
  SRC_APP="$WORK/src/DeepSeek Harness.app"
fi
[ -d "$SRC_APP/Contents/Frameworks/Electron Framework.framework" ] || { echo "not an Electron app: $SRC_APP" >&2; exit 1; }
command -v npx >/dev/null || { echo "npx (Node.js) is required" >&2; exit 1; }

echo "== copy $SRC_APP"
mkdir -p "$OUT_DIR"
ditto "$SRC_APP" "$WORK/$NAME.app"
APP="$WORK/$NAME.app"
RES="$APP/Contents/Resources"

echo "== drop the local Host payload"
rm -rf "$RES/runtime" "$RES/app.asar.unpacked" "$RES/app-update.yml"

echo "== pack the dsh-remote-servers bundle (uploaded by Settings → Remote servers → Set up server)"
[ -f "$HERE/plugin/lib/client.js" ] || { echo "plugin/lib/client.js missing: run 'npm run build' in plugin/ first" >&2; exit 1; }
STAGE="$WORK/app"
cp -R "$HERE/app" "$STAGE"
(cd "$HERE/plugin" && npm pack --silent --pack-destination "$WORK" >/dev/null)
mv "$WORK"/dsh-remote-servers-*.tgz "$STAGE/dsh-remote-servers.tgz"

echo "== pack app.asar"
rm -f "$RES/app.asar"
npx --yes @electron/asar@3 pack "$STAGE" "$RES/app.asar"

echo "== rename bundle"
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST"
# CFBundleName stays: Electron derives the "<CFBundleName> Helper.app" lookup from it.
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
for helper in "$APP"/Contents/Frameworks/*Helper*.app; do
  hp="$helper/Contents/Info.plist"
  old="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$hp")"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${old/com.deepseek.dsh/$BUNDLE_ID}" "$hp"
done

echo "== ad-hoc sign"
xattr -cr "$APP"
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"

# Replace the previous build only after this one is complete and verified. The previous app is
# moved aside under a unique name and put back if the new one cannot be moved in.
mkdir -p "$OUT_DIR"
PREVIOUS=""
if [ -e "$OUT_APP" ]; then
  PREVIOUS="$(mktemp -d "$OUT_DIR/.$NAME.previous.XXXXXX")"
  mv "$OUT_APP" "$PREVIOUS/"
fi
if ! mv "$APP" "$OUT_APP"; then
  [ -z "$PREVIOUS" ] || mv "$PREVIOUS/$NAME.app" "$OUT_APP"
  echo "build-mac.sh: could not install $OUT_APP; the previous build was kept" >&2
  exit 1
fi
[ -z "$PREVIOUS" ] || rm -rf "$PREVIOUS"
echo "built: $OUT_APP"
echo "settings: ~/Library/Application Support/$NAME/remote.json (created on first launch)"
