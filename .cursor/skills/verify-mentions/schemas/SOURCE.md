# Vendored marketplace references

These files are copied from the official Cursor plugin marketplace repository so the goals gate runs offline and gives the same answer on every machine.

| File | Source | Revision |
| --- | --- | --- |
| `plugin.schema.json` | `cursor/plugins` `schemas/plugin.schema.json` | `118e73b` (2026-10-12) |
| `marketplace.schema.json` | `cursor/plugins` `schemas/marketplace.schema.json` | `118e73b` (2026-10-12) |
| `marketplace-names.txt` | `jq -r '.plugins[].name' .cursor-plugin/marketplace.json \| sort` | `118e73b` (2026-10-12) |

Listing conventions checked by gate `d2-listing-fields` were measured on the same revision: all 100 listed plugins set `displayName`, `description`, `version`, `author`, `license`, `keywords`, `tags`, `category`, `repository`, and `homepage`. 97 of 100 set `logo` (79 PNG, 18 SVG). Categories in use: `integrations` (72), `developer-tools` (16), `productivity` (11), `utilities` (1).

Refresh from a newer checkout:

```bash
src=/path/to/cursor-plugins
dst=.cursor/skills/verify-mentions/schemas
cp "$src/schemas/plugin.schema.json" "$src/schemas/marketplace.schema.json" "$dst/"
jq -r '.plugins[].name' "$src/.cursor-plugin/marketplace.json" | sort > "$dst/marketplace-names.txt"
git -C "$src" log -1 --format='%h %cs'   # update the Revision column above
```

Set `CURSOR_PLUGINS_DIR=/path/to/cursor-plugins` to make the gate read that checkout instead of these copies. `control-mentions doctor` reports when the two differ.
