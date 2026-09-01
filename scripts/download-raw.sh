#!/usr/bin/env bash
# Download the TIGER/Line cartographic boundary files the pipeline needs.
set -euo pipefail
YEAR=2024
STATE=17 # Illinois
DIR="$(dirname "$0")/../data/raw"
mkdir -p "$DIR"
for LAYER in bg place; do
  URL="https://www2.census.gov/geo/tiger/GENZ${YEAR}/shp/cb_${YEAR}_${STATE}_${LAYER}_500k.zip"
  echo "Downloading $LAYER ..."
  curl -sL --fail --max-time 300 -o "$DIR/${LAYER}.zip" "$URL"
  unzip -oq "$DIR/${LAYER}.zip" -d "$DIR"
done
echo "Raw shapefiles ready in $DIR"
