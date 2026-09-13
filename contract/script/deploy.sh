#!/usr/bin/env bash
# Deploy GaslessDelegate to each chain in the config.yaml `chains:` registry.
#
# Required env (typically loaded from gasless/contract/.env):
#   OPERATOR_MNEMONIC          BIP-39 mnemonic for the deployer wallet
#   OPERATOR_MNEMONIC_INDEX    (optional) address index, default 0
# Either of the above OR:
#   OPERATOR_PRIVATE_KEY       0x-prefixed 32-byte hex private key
#
# RPC endpoints come from each chain's `rpcUrls` in config.yaml (first usable
# entry is used); the provider key `${ANKR_API_KEY}` is expanded from the env.
#
# Optional filter:
#   CHAINS="bsc base"          (space-separated short names; deploys to all if unset)
#
# Output is written to gasless/chains/deployed.json keyed by chainId.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contract_dir="$(cd "$here/.." && pwd)"
chains_dir="$(cd "$contract_dir/../chains" && pwd)"
backend_dir="$(cd "$contract_dir/../backend" && pwd)"
config_yaml="$backend_dir/config.yaml"
deployed_json="$chains_dir/deployed.json"

if [[ ! -f "$config_yaml" ]]; then
  echo "missing $config_yaml" >&2
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
if ! command -v node >/dev/null 2>&1; then
  echo "node required; the chains bridge below parses config.yaml with js-yaml" >&2
  exit 1
fi
if ! (cd "$backend_dir" && node -e 'require("js-yaml")' >/dev/null 2>&1); then
  echo "js-yaml not found; run: (cd $backend_dir && npm install)" >&2
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

# Read the chain registry from config.yaml (single source of truth). The node
# bridge reuses backend/node_modules js-yaml and expands `${VAR}` (e.g. the RPC
# provider key) from the environment, dropping any URL whose key is unset.
chains_yaml_json="$(cd "$backend_dir" && node -e '
const { load } = require("js-yaml");
const fs = require("fs");
const cfg = load(fs.readFileSync(process.argv[1], "utf8")) || {};
const chains = (cfg.chains || []).map((c) => ({
  name: c.name,
  chainId: c.chainId,
  rpcUrls: (c.rpcUrls || []).map((u) => {
    let ok = true;
    const r = String(u).replace(/\$\{([A-Z0-9_]+)\}/g, (_, v) => {
      const val = process.env[v];
      if (!val) { ok = false; return ""; }
      return val;
    });
    return ok ? r : null;
  }).filter(Boolean),
}));
process.stdout.write(JSON.stringify({ chains }));
' "$config_yaml")"

mapfile -t chain_rows < <(echo "$chains_yaml_json" | jq -c '.chains[]')

for row in "${chain_rows[@]}"; do
  name="$(echo "$row" | jq -r '.name')"
  chain_id="$(echo "$row" | jq -r '.chainId')"

  if [[ -n "$filter_names" ]]; then
    found=0
    name_lower="${name,,}"
    for f in $filter_names; do
      f_lower="${f,,}"
      if [[ "$f_lower" == "$name_lower" ]]; then found=1; break; fi
    done
    if [[ "$found" -eq 0 ]]; then continue; fi
  fi

  rpc_url="$(echo "$row" | jq -r '.rpcUrls[0] // empty')"
  if [[ -z "$rpc_url" ]]; then
    echo "no usable rpcUrls for $name (chain $chain_id) — set ANKR_API_KEY or add a keyless RPC in config.yaml" >&2
    exit 1
  fi

  echo "============================================================"
  echo "deploying to $name (chain $chain_id) via $rpc_url"
  echo "============================================================"

  existing="$(jq -r --arg key "$chain_id" '.[$key] // empty' "$deployed_json")"
  if [[ -n "$existing" && "${FORCE_REDEPLOY:-}" != "1" ]]; then
    echo "SKIP: chain $chain_id already has a deployed delegate at $existing." >&2
    echo "      Re-deploying would break existing EIP-7702 authorizations pointing at the old address." >&2
    echo "      Set FORCE_REDEPLOY=1 to override (dangerous)." >&2
    continue
  fi

  cd "$contract_dir"
  verify_args=()
  if [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then
    verify_args=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")
  else
    echo "ETHERSCAN_API_KEY not set; deploying without source verification."
  fi
  output=$(forge script script/Deploy.s.sol:DeployGaslessDelegate \
    --rpc-url "$rpc_url" \
    --broadcast \
    --slow \
    "${verify_args[@]}" \
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
