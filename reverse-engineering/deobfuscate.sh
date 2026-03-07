#!/bin/bash
# Deobfuscate webvisu.js — format and replace minified symbol names
# with meaningful names identified during reverse engineering.
#
# Uses js-beautify for formatting and jscodeshift (AST-aware) for
# symbol renaming — only renames top-level bindings and their
# references, not unrelated property accesses.
#
# Prerequisites: Node.js with npx (js-beautify and jscodeshift)
#
# Usage: ./deobfuscate.sh [input.js] [output.js]
#   Default input:  webvisu.js
#   Default output: webvisu-deobfuscated.js

set -euo pipefail
cd "$(dirname "$0")"

INPUT="${1:-webvisu.js}"
OUTPUT="${2:-webvisu-deobfuscated.js}"

if [ ! -f "$INPUT" ]; then
    echo "Error: $INPUT not found" >&2
    exit 1
fi

echo "Step 1: Formatting with js-beautify..."
cp "$INPUT" "$OUTPUT"
npx js-beautify -f "$OUTPUT" -o "$OUTPUT" \
    --indent-size 4 \
    --end-with-newline \
    --preserve-newlines \
    --max-preserve-newlines 2

echo "Step 2: Renaming symbols with jscodeshift (AST-aware)..."
npx jscodeshift -t deobfuscate-transform.js "$OUTPUT" --parser babel

LINES=$(wc -l < "$OUTPUT")
echo ""
echo "Done: $OUTPUT ($LINES lines)"
echo ""
echo "Symbol mapping is defined in deobfuscate-transform.js"
echo "To add new symbol mappings, edit the RENAMES object in that file."
