#!/usr/bin/env bash
# Assemble the public sites from this repository's sources.
#   docs    -> /var/www/gasless-doc   (site/docs shell + docs/ + contract/docs/)
#   landing -> /var/www/gasless       (site/landing)
# site/assets (logo, favicon, cover) is copied into both.
# Vendor assets for the docs come from a docsify install passed as $1.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
vendor_src="${1:-}"

docs_out=/var/www/gasless-doc
landing_out=/var/www/gasless

# ---- docs
rm -rf "$docs_out"; mkdir -p "$docs_out/contract" "$docs_out/vendor"
cp "$here/docs/index.html" "$here/docs/_sidebar.md" "$here/docs/README.md" "$here/docs/docs.css" "$docs_out/"
for f in architecture integration-guide api-reference error-codes state-machine-and-scheduler secrets-and-config-convention; do
  cp "$repo/docs/$f.md" "$docs_out/$f.md"
done
for f in architecture execution-model eip712-batch-hashing; do
  cp "$repo/contract/docs/$f.md" "$docs_out/contract/$f.md"
done
# Repo-relative source links do not exist on the site; point them at GitHub.
python3 - "$docs_out" <<'PYEOF'
import pathlib, re, sys
out = pathlib.Path(sys.argv[1]); gh = "https://github.com/akashmirpar/evm-gasless"
for f in out.glob("*.md"):
    t = f.read_text()
    t = re.sub(r"\]\(\.\./(contract|backend|chains)/([^)]*)\)", lambda m: f"]({gh}/tree/main/{m.group(1)}/{m.group(2)})", t)
    f.write_text(t)
for f in (out / "contract").glob("*.md"):
    t = f.read_text()
    t = re.sub(r"\]\(\.\./(src|test)/([^)]*)\)", lambda m: f"]({gh}/blob/main/contract/{m.group(1)}/{m.group(2)})", t)
    f.write_text(t)
PYEOF
if [[ -n "$vendor_src" ]]; then
  cp "$vendor_src/node_modules/docsify/lib/docsify.min.js" "$docs_out/vendor/"
  cp "$vendor_src/node_modules/docsify/lib/plugins/search.min.js" "$docs_out/vendor/"
  cp "$vendor_src/node_modules/docsify/lib/themes/vue.css" "$docs_out/vendor/"
  for l in bash json yaml typescript solidity; do
    cp "$vendor_src/node_modules/prismjs/components/prism-$l.min.js" "$docs_out/vendor/"
  done
fi

# ---- landing
rm -rf "$landing_out"; mkdir -p "$landing_out"
cp -r "$here/landing/." "$landing_out/"

# ---- shared assets
cp "$here/assets/"* "$docs_out/"
cp "$here/assets/"* "$landing_out/"

# ---- cache-bust: the CDN caches static files by path, so give every asset
# referenced from index.html a content-hashed filename and rewrite the reference.
# cover.png is referenced by absolute URL for link previews and keeps its name.
python3 - "$docs_out" "$landing_out" <<'PYEOF'
import hashlib, pathlib, re, sys
for root in map(pathlib.Path, sys.argv[1:]):
    index = root / "index.html"; html = index.read_text()
    for m in sorted(set(re.findall(r'''["']((?:vendor/)?[\w.-]+\.(?:js|css|png))["']''', html))):
        f = root / m
        if not f.exists(): continue
        h = hashlib.sha256(f.read_bytes()).hexdigest()[:10]
        new = f.with_name(f"{f.stem}.{h}{f.suffix}")
        f.rename(new)
        hashed = f"{m[:-len(f.name)]}{new.name}"
        for q in ('"', "'"):
            html = html.replace(f"{q}{m}{q}", f"{q}{hashed}{q}")
    index.write_text(html)
PYEOF

echo "deployed: $docs_out, $landing_out"
