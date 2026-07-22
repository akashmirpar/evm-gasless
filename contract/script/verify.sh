#!/usr/bin/env bash
# Standalone verification for already-deployed GaslessDelegate addresses.
# Reads chains/deployed.json and submits the source for each entry to Etherscan v2.
# Requires ETHERSCAN_API_KEY in .env.
#
# Run after a deploy that was missing the API key, or after editing source
# and re-deploying.
#
# Optional filter:
#   CHAINS="bsc base"   (space-separated short names; verifies all if unset)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contract_dir="$(cd "$here/.." && pwd)"
chains_dir="$(cd "$contract_dir/../chains" && pwd)"
backend_dir="$(cd "$contract_dir/../backend" && pwd)"
config_yaml="$backend_dir/config.yaml"
deployed_json="$chains_dir/deployed.json"

# chainId -> name map from the config.yaml registry (single source of truth).
chain_names_json="$(cd "$backend_dir" && node -e '
const { load } = require("js-yaml");
const fs = require("fs");
const cfg = load(fs.readFileSync(process.argv[1], "utf8")) || {};
const map = {};
for (const c of cfg.chains || []) map[String(c.chainId)] = c.name;
process.stdout.write(JSON.stringify(map));
' "$config_yaml")"

if [[ -f "$contract_dir/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$contract_dir/.env"
  set +a
fi

if [[ -z "${ETHERSCAN_API_KEY:-}" ]]; then
  echo "ETHERSCAN_API_KEY required (get one at https://etherscan.io/myapikey)" >&2
  exit 1
fi
if [[ ! -f "$deployed_json" ]] || [[ "$(jq 'length' "$deployed_json")" -eq 0 ]]; then
  echo "no addresses to verify in $deployed_json" >&2
  exit 1
fi

filter_names="${CHAINS:-}"

for entry in $(jq -r 'to_entries[] | "\(.key)=\(.value)"' "$deployed_json"); do
  chain_id="${entry%%=*}"
  address="${entry#*=}"

  name="$(echo "$chain_names_json" | jq -r --arg id "$chain_id" '.[$id] // empty')"
  if [[ -z "$name" ]]; then
    echo "chain id $chain_id not in config.yaml; skipping"
    continue
  fi

  if [[ -n "$filter_names" ]]; then
    found=0
    name_lower="${name,,}"
    for f in $filter_names; do
      f_lower="${f,,}"
      if [[ "$f_lower" == "$name_lower" ]]; then found=1; break; fi
    done
    if [[ "$found" -eq 0 ]]; then continue; fi
  fi

  echo "============================================================"
  echo "verifying $name (chain $chain_id) at $address"
  echo "============================================================"

  cd "$contract_dir"
  forge verify-contract "$address" \
    src/GaslessDelegate.sol:GaslessDelegate \
    --chain "$chain_id" \
    --etherscan-api-key "$ETHERSCAN_API_KEY" \
    --watch
done
