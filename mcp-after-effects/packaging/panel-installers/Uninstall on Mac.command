#!/bin/bash
# Removes the After Effects MCP panel. Double-click to run.
rm -rf "$HOME/Library/Application Support/Adobe/CEP/extensions/com.creatorx.aemcp"
echo
echo "Removed. Restart After Effects to finish."
echo
read -n 1 -s -r -p "Press any key to close this window."
