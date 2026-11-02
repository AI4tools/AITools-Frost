#!/usr/bin/env bash
# External OpenCode caller (CLI path). Aliases/tiers are read from models.json.
#
#   ./run.sh -m deepseek "Explain this repository"
#   ./run.sh -m tier2 -t review "Review src/"
#   ./run.sh -m glm -c "Now handle the edge case"
#   ./run.sh -m opencode/longcat-2.5-preview-free --json "List TODOs"
#   ./run.sh -d /path/to/proj -s ses_abc123 "continue"
#   ./run.sh -m deepseek -f prompt.txt          # read prompt from a UTF-8 file
#   cat prompt.txt | ./run.sh -m deepseek --prompt-stdin
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$HERE")"
CATALOG="$SKILL_DIR/models.json"
BIN="${OPENCODE_BIN:-opencode}"

MODEL=""; TIER=""; VARIANT=""; AGENT=""; SESSION=""; CONT=0; TITLE=""; FMT=""; DIR=""; PROMPT=""; PROMPT_FILE=""; PROMPT_STDIN=0

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)   MODEL="$2"; shift 2;;
    --tier)       TIER="$2"; shift 2;;
    -v|--variant) VARIANT="$2"; shift 2;;
    -a|--agent)   AGENT="$2"; shift 2;;
    -s|--session) SESSION="$2"; shift 2;;
    -c|--continue) CONT=1; shift;;
    -t|--title)   TITLE="$2"; shift 2;;
    -d|--dir)     DIR="$2"; shift 2;;
    -f|--file|--prompt-file) PROMPT_FILE="$2"; shift 2;;
    --prompt-stdin) PROMPT_STDIN=1; shift;;
    --json)       FMT="json"; shift;;
    -h|--help)    usage; exit 0;;
    *)            PROMPT="${PROMPT:+$PROMPT }$1"; shift;;
  esac
done

# Prompt from a UTF-8 file or stdin (bash reads raw bytes, so the file's UTF-8
# survives intact - unlike PowerShell 5.1's Get-Content, which would GBK-decode).
if [[ -n "$PROMPT_FILE" ]]; then
  PROMPT="$(cat "$PROMPT_FILE")"
elif [[ "$PROMPT_STDIN" -eq 1 ]]; then
  PROMPT="$(cat)"
fi

pick_field() { # stdin line, field name -> value (empty if the field is absent)
  sed -nE 's/.*"'"$1"'": *"([^"]*)".*/\1/p'
}

tier_first_model() { # tier id -> first model line of that tier (string match, safe for "/" in ids)
  awk -v key="$1" 'index($0,"\"id\": \"" key "\",") && $0 !~ /"alias"/ {t=1} t && /"alias"/{print; exit}' "$CATALOG"
}

line=""
if [[ -n "$TIER" ]]; then
  line="$(tier_first_model "$TIER")"
fi
if [[ -z "$line" && -n "$MODEL" ]]; then
  line="$(grep -m1 -F "\"alias\": \"$MODEL\"" "$CATALOG" || true)"   # alias
  [[ -z "$line" ]] && line="$(tier_first_model "$MODEL")"            # tier id -> its first model
  [[ -z "$line" ]] && line="$(grep -m1 -F "\"id\": \"$MODEL\"" "$CATALOG" || true)"   # full id
fi
if [[ -z "$line" ]]; then
  def="$(grep -m1 -o '"default": "[^"]*"' "$CATALOG" | pick_field default)"
  line="$(grep -m1 -F "\"id\": \"$def\"" "$CATALOG")"
fi
[[ -z "$line" ]] && { echo "ERROR: cannot resolve model (model='$MODEL' tier='$TIER')" >&2; exit 1; }

mid="$(printf '%s' "$line" | pick_field id)"
mvariant="$(printf '%s' "$line" | pick_field variant)"
explicit_variant="$VARIANT"
[[ -n "$VARIANT" ]] && mvariant="$VARIANT"

ver="$("$BIN" --version 2>/dev/null || true)"
model_arg="$mid"
if [[ "$ver" == *v2.* && -n "$mvariant" ]]; then
  model_arg="${mid}#${mvariant}"
fi

args=(run --agent "${AGENT:-$(grep -m1 -o '"defaultAgent": "[^"]*"' "$CATALOG" | pick_field defaultAgent)}" --model "$model_arg")
# V1: only pass --variant when explicitly requested (some upstreams reject it).
if [[ "$ver" != *v2.* && -n "$explicit_variant" ]]; then args+=(--variant "$explicit_variant"); fi
[[ -n "$TITLE"   ]] && args+=(--title "$TITLE")
[[ -n "$SESSION" ]] && args+=(--session "$SESSION")
[[ "$CONT" -eq 1 ]] && args+=(--continue)
[[ "$FMT" == json ]] && args+=(--format json)
[[ -n "$PROMPT"  ]] && args+=("$PROMPT")
[[ -n "$DIR"     ]] && cd "$DIR"

exec "$BIN" "${args[@]}"
