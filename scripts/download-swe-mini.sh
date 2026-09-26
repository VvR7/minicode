#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_ROOT="$REPOSITORY_ROOT/.cache/swe-bench"
SOURCE_ROOT="$CACHE_ROOT/source"
VENV_ROOT="$CACHE_ROOT/venv"
SWE_BENCH_COMMIT="02e7a74ffd0b707aab73d203fe87bdc7c76afc8e"
DATASET_REVISION="b316c349947c29963fce3f4a65967c9807a4b673"

mkdir -p "$CACHE_ROOT"
if [[ ! -d "$SOURCE_ROOT/.git" ]]; then
  git clone --filter=blob:none https://github.com/SWE-bench/SWE-bench.git "$SOURCE_ROOT"
fi
git -C "$SOURCE_ROOT" fetch --depth 1 origin "$SWE_BENCH_COMMIT"
git -C "$SOURCE_ROOT" checkout --detach "$SWE_BENCH_COMMIT"

if [[ ! -x "$VENV_ROOT/bin/python" ]]; then
  python3 -m venv "$VENV_ROOT"
fi
"$VENV_ROOT/bin/python" -m pip install \
  --disable-pip-version-check \
  --index-url https://pypi.org/simple \
  -q \
  -e "$SOURCE_ROOT" \
  socksio

TEMP_ROOT="$(mktemp -d -t minicode-swe-mini.XXXXXX)"
cleanup() {
  if [[ "$TEMP_ROOT" == /tmp/minicode-swe-mini.* ]]; then
    rm -rf -- "$TEMP_ROOT"
  fi
}
trap cleanup EXIT

"$VENV_ROOT/bin/python" - "$TEMP_ROOT/dataset.jsonl" "$DATASET_REVISION" <<'PY'
import sys
from datasets import load_dataset

output, revision = sys.argv[1:]
dataset = load_dataset(
    "MariusHobbhahn/swe-bench-verified-mini",
    split="test",
    revision=revision,
)
if len(dataset) != 50:
    raise RuntimeError(f"expected 50 tasks, received {len(dataset)}")
dataset.to_json(output)
PY

cd "$REPOSITORY_ROOT"
bun run scripts/import-swe-mini.ts "$TEMP_ROOT/dataset.jsonl"
