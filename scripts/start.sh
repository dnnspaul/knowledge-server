#!/usr/bin/env bash
set -euo pipefail

# Start the knowledge server (source install).
# Searches for .env in priority order, loads it, then runs the server via Bun.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Ensure bun is in PATH
export PATH="$HOME/.bun/bin:$PATH"

cd "$PROJECT_DIR"

# Check that setup has been run (dependencies installed)
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "Error: dependencies not installed. Run setup first:"
  echo "  bun run setup"
  exit 1
fi

# Resolve .env path — same priority order as resolveEnvFilePath() in src/config.ts:
#   1. $KNOWLEDGE_CONFIG_HOME/.env
#   2. $XDG_CONFIG_HOME/knowledge-server/.env  (or ~/.config/knowledge-server/.env)
#   3. ~/.local/share/knowledge-server/.env    (legacy)
#   4. .env in the project root                (source-install default)
_xdg_config="${XDG_CONFIG_HOME:-$HOME/.config}"
_env_file=""
if [ -n "${KNOWLEDGE_CONFIG_HOME:-}" ] && [ -f "$KNOWLEDGE_CONFIG_HOME/.env" ]; then
  _env_file="$KNOWLEDGE_CONFIG_HOME/.env"
elif [ -f "$_xdg_config/knowledge-server/.env" ]; then
  _env_file="$_xdg_config/knowledge-server/.env"
elif [ -f "$HOME/.local/share/knowledge-server/.env" ]; then
  _env_file="$HOME/.local/share/knowledge-server/.env"
  echo "Note: config loaded from legacy location $_env_file"
  echo "      Consider moving it to $_xdg_config/knowledge-server/.env"
elif [ -f "$PROJECT_DIR/.env" ]; then
  _env_file="$PROJECT_DIR/.env"
fi

if [ -n "$_env_file" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$_env_file" 2>/dev/null || true
  set +a
fi

exec bun run "$PROJECT_DIR/src/index.ts"
