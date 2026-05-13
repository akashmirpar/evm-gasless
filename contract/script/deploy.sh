#!/usr/bin/env bash
# Deploy GaslessDelegate to each chain listed in gasless/chains/chains.json.
#
# Required env (typically loaded from gasless/contract/.env):
#   OPERATOR_MNEMONIC          BIP-39 mnemonic for the deployer wallet
#   OPERATOR_MNEMONIC_INDEX    (optional) address index, default 0
# Either of the above OR:
#   OPERATOR_PRIVATE_KEY       0x-prefixed 32-byte hex private key
#
# Per-chain RPC overrides (comma-separated lists). First entry is used:
#   BSC_RPC_URLS
#   BASE_RPC_URLS
#   ARBITRUM_RPC_URLS
# If unset, the first entry in chains.json -> defaultRpcs is used.
#
# Optional filter:
#   CHAINS="bsc base"          (space-separated short names; deploys to all if unset)
#
# Output is written to gasless/chains/deployed.json keyed by chainId.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contract_dir="$(cd "$here/.." && pwd)"
chains_dir="$(cd "$contract_dir/../chains" && pwd)"
chains_json="$chains_dir/chains.json"
deployed_json="$chains_dir/deployed.json"

if [[ ! -f "$chains_json" ]]; then
  echo "missing $chains_json" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq required; install with: apt-get install -y jq" >&2
  exit 1
fi
if ! command -v forge >/dev/null 2>&1; then
  echo "forge required; install foundry from https://book.getfoundry.sh/" >&2
  exit 1
fi

# Load .env if present
if [[ -f "$contract_dir/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$contract_dir/.env"
  set +a
fi

if [[ -z "${OPERATOR_PRIVATE_KEY:-}" && -z "${OPERATOR_MNEMONIC:-}" ]]; then
  echo "set OPERATOR_PRIVATE_KEY or OPERATOR_MNEMONIC (see .env.example)" >&2
  exit 1
fi

if [[ ! -f "$deployed_json" ]]; then
  echo "{}" > "$deployed_json"
fi

filter_names="${CHAINS:-}"

mapfile -t chain_rows < <(jq -c '.chains[]' "$chains_json")

for row in "${chain_rows[@]}"; do
  name="$(echo "$row" | jq -r '.name')"
  chain_id="$(echo "$row" | jq -r '.chainId')"
  env_rpc_var="$(echo "$row" | jq -r '.envRpcVar')"

  if [[ -n "$filter_names" ]]; then
    found=0
    for f in $filter_names; do
      if [[ "$f" == "$name" ]]; then found=1; break; fi
    done
    if [[ "$found" -eq 0 ]]; then continue; fi
  fi

  override="${!env_rpc_var:-}"
  if [[ -n "$override" ]]; then
    rpc_url="$(echo "$override" | cut -d, -f1)"
  else
    rpc_url="$(echo "$row" | jq -r '.defaultRpcs[0]')"
  fi

  echo "============================================================"
  echo "deploying to $name (chain $chain_id) via $rpc_url"
  echo "============================================================"

  cd "$contract_dir"
  output=$(forge script script/Deploy.s.sol:DeployGaslessDelegate \
    --rpc-url "$rpc_url" \
    --broadcast \
    --slow \
    -vvv 2>&1)
  echo "$output"

  addr="$(echo "$output" | grep -E '^[[:space:]]*DEPLOYED_ADDRESS=' | tail -n1 | sed -E 's/.*DEPLOYED_ADDRESS=//')"
  if [[ -z "$addr" ]]; then
    echo "could not parse deployed address from forge output" >&2
    exit 1
  fi

  tmp=$(mktemp)
  jq --arg key "$chain_id" --arg val "$addr" '. + {($key): $val}' "$deployed_json" > "$tmp"
  mv "$tmp" "$deployed_json"
  echo "wrote $deployed_json"
done

echo
echo "all done. current deployed.json:"
cat "$deployed_json"
