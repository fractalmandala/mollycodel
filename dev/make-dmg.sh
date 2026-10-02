#!/usr/bin/env bash
# Package the built macOS app into a drag-to-Applications .dmg, using only macOS tools.
#
# VSCodium's own DMG step needs a paid Apple Developer ID. This one does not: it seals the
# app with an ad-hoc signature (valid, but not notarized), then builds the disk image.
# On the Mac that built it the app opens normally. A copy that arrives by download or
# AirDrop is quarantined by macOS: right-click the app, choose Open once, or run
#   xattr -cr /Applications/mollycodel.app
#
# Usage: dev/make-dmg.sh            (run from the repo root after ./dev/build.sh)
set -euo pipefail

cd "$(dirname "$0")/.."
ARCH="${VSCODE_ARCH:-$( [[ "$(uname -m)" == "arm64" ]] && echo arm64 || echo x64 )}"
APP_DIR="VSCode-darwin-${ARCH}"
NAME="$( node -p "require('./vscode/product.json').nameLong" )"
APP="${APP_DIR}/${NAME}.app"
VERSION="$( node -p "require('./vscode/package.json').version" )"
ICON="src/stable/resources/darwin/code.icns"
OUT="assets/${NAME}-${VERSION}-darwin-${ARCH}.dmg"

[[ -d "${APP}" ]] || { echo "error: ${APP} not found; run ./dev/build.sh first" >&2; exit 1; }
mkdir -p assets

echo "+ sealing ${APP} (ad-hoc)"
codesign --force --deep --sign - "${APP}"
codesign --verify --deep --strict "${APP}"

WORK="$(mktemp -d "${PWD}/assets/.dmg-XXXXXX")"
trap 'hdiutil detach "${WORK}/mnt" >/dev/null 2>&1 || true; rm -rf "${WORK}"' EXIT
STAGE="${WORK}/stage"; mkdir -p "${STAGE}" "${WORK}/mnt"
cp -R "${APP}" "${STAGE}/"
ln -s /Applications "${STAGE}/Applications"
cp "${ICON}" "${STAGE}/.VolumeIcon.icns"

rm -f "${OUT}"
echo "+ creating ${OUT}"
# Build writable first so the custom-volume-icon flag can be set on the volume itself.
hdiutil create -volname "${NAME}" -srcfolder "${STAGE}" -fs HFS+ -format UDRW -ov "${WORK}/rw.dmg" >/dev/null
hdiutil attach "${WORK}/rw.dmg" -nobrowse -mountpoint "${WORK}/mnt" >/dev/null
SetFile -a C "${WORK}/mnt"
sync
hdiutil detach "${WORK}/mnt" >/dev/null
hdiutil convert "${WORK}/rw.dmg" -format UDZO -imagekey zlib-level=9 -ov -o "${OUT}" >/dev/null

echo "+ verifying"
hdiutil verify "${OUT}" >/dev/null
ls -la "${OUT}" | awk '{printf "%s  %.0f MB\n", $9, $5/1048576}'
