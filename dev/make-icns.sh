#!/usr/bin/env bash
# Build a macOS .icns from a square PNG (>= 1024x1024) using only macOS tools.
# Usage: dev/make-icns.sh mollycodel.png output.icns
set -euo pipefail
src="${1:?source png}"; out="${2:?output icns}"
tmp="$(mktemp -d)"; set="${tmp}/icon.iconset"; mkdir -p "${set}"
while read -r size name; do
  sips -z "${size}" "${size}" "${src}" --out "${set}/${name}.png" >/dev/null
done <<'SIZES'
16 icon_16x16
32 icon_16x16@2x
32 icon_32x32
64 icon_32x32@2x
128 icon_128x128
256 icon_128x128@2x
256 icon_256x256
512 icon_256x256@2x
512 icon_512x512
1024 icon_512x512@2x
SIZES
iconutil -c icns "${set}" -o "${out}"
rm -rf "${tmp}"
echo "wrote ${out}"
