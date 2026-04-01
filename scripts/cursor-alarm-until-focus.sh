#!/usr/bin/env bash
# 1) Toca sempre um som (mesmo com Cursor em foco — para ouvires que a tarefa acabou).
# 2) Se outra app estiver em primeiro plano, repete após CURSOR_ALARM_INTERVAL até voltares ao Cursor.
# Uso: nohup bash scripts/cursor-alarm-until-focus.sh >>/tmp/cursor-alarm.log 2>&1 &
# Env: CURSOR_ALARM_INTERVAL (segundos entre repetições, default 4)

INTERVAL="${CURSOR_ALARM_INTERVAL:-4}"

frontmost() {
  osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null || echo ""
}

is_cursor_focused() {
  local f
  f="$(frontmost | tr '[:upper:]' '[:lower:]')"
  [[ "$f" == "cursor" ]]
}

ding() {
  if [[ -f /System/Library/Sounds/Tink.aiff ]]; then
    afplay /System/Library/Sounds/Tink.aiff 2>/dev/null
  else
    printf '\a'
  fi
}

ding

while true; do
  if is_cursor_focused; then
    exit 0
  fi
  sleep "$INTERVAL"
  ding
done
