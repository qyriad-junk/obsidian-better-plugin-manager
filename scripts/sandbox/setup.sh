#!/usr/bin/env bash
# Prepare an isolated Obsidian install and test vault for driving BPM headlessly.
#
#   scripts/sandbox/setup.sh [--fresh]
#
# Everything lives under $BPM_SANDBOX (default: <repo>/.sandbox, gitignored):
#   obsidian-<version>/   the unpacked Linux build
#   home/                 HOME and XDG_CONFIG_HOME for Obsidian (never touches your real config)
#   vault/                the test vault; BPM's main.js/manifest.json/styles.css are symlinked in
# --fresh deletes the vault and Obsidian's config (keeps the download).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SANDBOX="${BPM_SANDBOX:-$REPO/.sandbox}"
VERSION="${OBSIDIAN_VERSION:-1.13.7}"
APP="$SANDBOX/obsidian-$VERSION"
VAULT="$SANDBOX/vault"
CONFIG="$SANDBOX/home/.config/obsidian"
VAULT_ID="b9f1e5a0c0ffee00"

if [[ "${1:-}" == "--fresh" ]]; then
	rm -rf "$VAULT" "$SANDBOX/home"
fi

mkdir -p "$SANDBOX"
if [[ ! -x "$APP/obsidian" ]]; then
	echo "Downloading Obsidian $VERSION…"
	curl -sSfL -o "$SANDBOX/obsidian-$VERSION.tar.gz" \
		"https://github.com/obsidianmd/obsidian-releases/releases/download/v$VERSION/obsidian-$VERSION.tar.gz"
	tar -xzf "$SANDBOX/obsidian-$VERSION.tar.gz" -C "$SANDBOX"
	rm "$SANDBOX/obsidian-$VERSION.tar.gz"
fi

PLUGIN_DIR="$VAULT/.obsidian/plugins/better-plugins-manager"
mkdir -p "$PLUGIN_DIR" "$CONFIG"
for file in main.js manifest.json styles.css; do
	ln -sf "$REPO/$file" "$PLUGIN_DIR/$file"
done
[[ -f "$VAULT/Welcome.md" ]] || echo "# BPM sandbox vault" > "$VAULT/Welcome.md"
[[ -f "$VAULT/.obsidian/community-plugins.json" ]] || echo '["better-plugins-manager"]' > "$VAULT/.obsidian/community-plugins.json"

# Register the vault as the one to open, and turn off Obsidian's self-updater.
cat > "$CONFIG/obsidian.json" <<JSON
{"vaults":{"$VAULT_ID":{"path":"$VAULT","ts":$(date +%s000),"open":true}},"updateDisabled":true}
JSON

[[ -f "$REPO/main.js" ]] || echo "note: $REPO/main.js doesn't exist yet; run npm run build (or npm run dev)."
echo "Sandbox ready: $SANDBOX (Obsidian $VERSION, vault id $VAULT_ID)"
