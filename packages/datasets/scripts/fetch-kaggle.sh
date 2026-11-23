#!/usr/bin/env bash
# Downloads the Kaggle datasets the platform is calibrated on.
# Requires the Kaggle CLI (`pip install kaggle`) and ~/.kaggle/kaggle.json
# (or KAGGLE_USERNAME / KAGGLE_KEY). Without them the services fall back to
# schema-compatible synthetic data.
set -euo pipefail

OUT="${1:-data}"
mkdir -p "$OUT"

datasets=(
  "ziya07/healthcare-iot-data"               # wearable vitals + battery (CC0)
  "shayanfazeli/heartbeat"                   # MIT-BIH ECG beats, 125 Hz
  "colabsss/green-iot-edge-resource-dataset" # edge latency / QoS / resources (CC0)
)

for d in "${datasets[@]}"; do
  echo "> $d"
  kaggle datasets download -d "$d" -p "$OUT" --unzip --quiet
done

ls -lh "$OUT"
