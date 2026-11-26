#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/crusader-comm-link"

if [[ -S "/run/user/$UID/bus" ]] && ! systemctl --user show-environment >/dev/null 2>&1; then
  export XDG_RUNTIME_DIR="/run/user/$UID"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

case "${1:-}" in
  -h|--help)
    printf '%s\n' 'Usage: bash install.sh [--reconfigure]' \
      'First install detects the local node and prompts for settings.' \
      'An update preserves saved settings unless --reconfigure is supplied.'
    exit 0
    ;;
  ''|--reconfigure) ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
esac
if (( $# > 1 )); then
  printf 'Usage: bash install.sh [--reconfigure]\n' >&2
  exit 2
fi
if (( EUID == 0 )); then
  printf 'Run the installer as your normal node login account.\n' >&2
  exit 1
fi
if ! command -v python3 >/dev/null || ! python3 -c 'import yaml' 2>/dev/null; then
  printf 'Install Python and PyYAML first on Debian or ASL3 with: sudo apt install python3 python3-yaml\n' >&2
  exit 1
fi
if [[ -f "$install_dir/launch.args" && $# -eq 0 ]]; then
  bash "$source_dir/install-local.sh"
  if systemctl --user is-enabled --quiet crusader.service 2>/dev/null; then
    systemctl --user restart crusader.service
  elif [[ -t 0 ]] && { [[ -d /run/systemd/system ]] || systemctl --user show-environment >/dev/null 2>&1; }; then
    read -r -p 'Set up Crusader to start automatically at boot? [Y/n] ' service_answer
    if [[ -z "$service_answer" || "${service_answer,,}" == y || "${service_answer,,}" == yes ]]; then
      bash "$source_dir/install-service.sh"
    fi
  fi
  exit 0
fi
if [[ ! -t 0 ]]; then
  printf 'Run this command in an interactive terminal for first-time setup.\n' >&2
  exit 1
fi

ask() {
  local label=$1 default=${2:-}
  if [[ -n "$default" ]]; then label+=" [$default]"; fi
  read -r -p "$label: " answer
  answer=${answer:-$default}
}

asterisk=$(command -v asterisk || true)
if [[ -z "$asterisk" && -x /usr/sbin/asterisk ]]; then asterisk=/usr/sbin/asterisk; fi
local_nodes=()
if [[ -n "$asterisk" ]]; then
  mapfile -t local_nodes < <(
    timeout 3 "$asterisk" -rx 'rpt localnodes' 2>/dev/null |
      awk '$0 ~ /^[[:space:]]*[0-9]+[[:space:]]*$/ {gsub(/[[:space:]]/,""); if (length($0)>=3 && length($0)<=10 && !seen[$0]++) print}'
  )
fi
if (( ${#local_nodes[@]} )); then
  printf 'Asterisk reports these local nodes: %s\n' "${local_nodes[*]}"
elif [[ -r /etc/asterisk/rpt.conf ]]; then
  mapfile -t local_nodes < <(
    sed -nE 's/^[[:space:]]*\[([0-9]{3,10})\][[:space:]]*(;.*)?$/\1/p' /etc/asterisk/rpt.conf | sort -u
  )
  if (( ${#local_nodes[@]} )); then
    printf 'Possible nodes in rpt.conf: %s\n' "${local_nodes[*]}"
  fi
fi
node_default=''
if (( ${#local_nodes[@]} == 1 )); then node_default=${local_nodes[0]}; fi
while true; do
  ask 'Local AllStarLink node number' "$node_default"
  [[ "$answer" =~ ^[0-9]{3,10}$ ]] && break
  printf 'Enter a node number with 3 to 10 digits.\n'
done
node=$answer

while true; do
  ask 'Local dashboard port' 8877
  if [[ "$answer" =~ ^[0-9]{1,5}$ ]] && (( 10#$answer >= 1024 && 10#$answer <= 65535 )); then
    port=$((10#$answer))
    break
  fi
  printf 'Enter a port from 1024 to 65535.\n'
done
args=(--node "$node" --port "$port")

if [[ -z "$asterisk" ]] || ! timeout 3 "$asterisk" -rx "rpt lstats $node" 2>/dev/null | grep -qE '^[[:space:]]*NODE[[:space:]]+PEER'; then
  if timeout 3 /usr/bin/sudo -n /usr/sbin/asterisk -rx "rpt lstats $node" 2>/dev/null | grep -qE '^[[:space:]]*NODE[[:space:]]+PEER'; then
    printf 'Using your existing sudo permission for this node status command.\n'
    args+=(--sudo-lstats)
  else
    printf 'Asterisk link status could not be verified. Check local Asterisk access if link status is unavailable after startup.\n'
  fi
fi

ask 'Local AMI username for radio activity (blank to skip)'
if [[ -n "$answer" ]]; then
  while [[ ! "$answer" =~ ^[A-Za-z0-9_.@-]+$ || "$answer" == -* ]]; do
    ask 'Enter the configured AMI username (blank to skip)'
    [[ -z "$answer" ]] && break
  done
fi
if [[ -n "$answer" ]]; then
  args+=(--ami-user "$answer")
  while true; do
    ask 'Link commands for Sysops and Administrators (off, listed, any)' off
    case "$answer" in
      off) break ;;
      any) args+=(--control-any-peer); break ;;
      listed)
        ask 'Allowed peer node numbers separated by spaces'
        read -r -a peers <<< "$answer"
        valid=true
        for peer in "${peers[@]}"; do
          if [[ ! "$peer" =~ ^[1-9][0-9]{2,9}$ || "$peer" == "$node" ]]; then valid=false; fi
        done
        if $valid && (( ${#peers[@]} )); then
          for peer in "${peers[@]}"; do args+=(--control-peer "$peer"); done
          break
        fi
        printf 'Enter at least one valid peer number different from the local node.\n'
        ;;
      *) printf 'Choose off, listed, or any.\n' ;;
    esac
  done
fi

ask 'Custom SkywarnPlus config path (blank for automatic detection)'
if [[ -n "$answer" ]]; then args+=(--config "$answer"); fi
ask 'Legacy SkywarnPlus warnings report path (blank for automatic detection)'
if [[ -n "$answer" ]]; then args+=(--warnings "$answer"); fi

bash "$source_dir/install-local.sh" "${args[@]}"
if systemctl --user is-enabled --quiet crusader.service 2>/dev/null; then
  bash "$source_dir/install-service.sh"
elif [[ -d /run/systemd/system ]] || systemctl --user show-environment >/dev/null 2>&1; then
  ask 'Start Crusader automatically at boot? (Y/n)' Y
  if [[ "${answer,,}" == y || "${answer,,}" == yes ]]; then
    bash "$source_dir/install-service.sh"
  fi
fi
printf '\nOn your workstation, forward the dashboard port over SSH:\n'
printf '  ssh -N -L %s:127.0.0.1:%s YOUR_NODE_USER@YOUR_NODE_HOST\n' "$port" "$port"
printf 'Then open http://127.0.0.1:%s/?live=1\n' "$port"
printf 'For manual startup, the launcher prompts for the AMI secret if enabled and creates the first Administrator account on first launch.\n'
