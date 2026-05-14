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
chains_json="$chains_dir/chains.json"
deployed_json="$chains_dir/deployed.json"

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

  name="$(jq -r --argjson id "$chain_id" '.chains[] | select(.chainId == $id) | .name' "$chains_json")"
  if [[ -z "$name" ]]; then
    echo "chain id $chain_id not in chains.json; skipping"
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
