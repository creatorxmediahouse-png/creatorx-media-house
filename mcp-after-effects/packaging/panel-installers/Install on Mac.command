#!/bin/bash
# Installs the After Effects MCP panel for this Mac user. Double-click to run.
cd "$(dirname "$0")"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.creatorx.aemcp"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "com.creatorx.aemcp" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
# The panel isn't a signed .zxp, so let After Effects load unsigned panels.
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
echo
echo "Installed. Restart After Effects, then open Window > Extensions > After Effects MCP."
echo
read -n 1 -s -r -p "Press any key to close this window."
