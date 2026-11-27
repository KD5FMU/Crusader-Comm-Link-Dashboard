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
    printf '%s\n' 'Usage: bash install.sh [--reconfigure | --tailscale]' \
      'First install detects the local node and prompts for settings.' \
      'An update preserves saved settings unless --reconfigure is supplied.'
    exit 0
    ;;
  ''|--reconfigure|--tailscale) ;;
  *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
esac
if (( $# > 1 )); then
  printf 'Usage: bash install.sh [--reconfigure | --tailscale]\n' >&2
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
if [[ "${1:-}" == --tailscale ]]; then
  exec bash "$source_dir/install-tailscale.sh"
fi

configure_browser_access() {
  if ! systemctl --user is-active --quiet crusader.service; then
    printf 'Browser access from another computer requires the Crusader service. Run bash install.sh again to enable it.\n'
    printf 'To start it manually on this node, run %q.\n' "$install_dir/crusader"
    return
  fi
  if ! command -v curl >/dev/null; then
    printf 'Install curl with sudo apt install curl, then rerun bash install.sh for LAN browser setup.\n' >&2
    return 1
  fi
  if [[ -s "$install_dir/https-origin" ]]; then
    local saved_origin
    read -r saved_origin < "$install_dir/https-origin"
    if [[ "$saved_origin" =~ ^https://[a-zA-Z0-9.-]+$ ]] && curl --noproxy '*' -kfsS --max-time 5 --resolve "${saved_origin#https://}:443:127.0.0.1" \
      "$saved_origin/crusader/?live=1" | grep -F '<title>Crusader Comm/Link</title>' >/dev/null; then
      printf '\nOpen %s/crusader/?live=1 in a browser on your local network.\n' "$saved_origin"
      return
    fi
  fi
  [[ -t 0 ]] || return
  if ! command -v apache2ctl >/dev/null && [[ ! -x /usr/sbin/apache2ctl ]]; then
    printf 'LAN browser access needs an existing Apache HTTPS site on the node. See the README for setup options.\n'
    return
  fi
  local host subnet
  host=$(hostname -s).local
  subnet=$(ip -j -4 address show scope global | python3 -c '
import ipaddress, json, sys
private = [ipaddress.ip_network(block) for block in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
networks = set()
for interface in json.load(sys.stdin):
    for address in interface.get("addr_info", []):
        network = ipaddress.ip_interface("{local}/{prefixlen}".format_map(address)).network
        if any(network.subnet_of(block) for block in private):
            networks.add(network)
if len(networks) == 1:
    print(networks.pop())
' 2>/dev/null) || subnet=''
  ask 'Make Crusader available in browsers on your local network? (Y/n)' Y
  [[ "${answer,,}" == y || "${answer,,}" == yes ]] || return 0
  ask 'Node hostname used in your browser' "$host"
  host=$answer
  ask 'Local network address range (example 192.168.1.0/24)' "$subnet"
  subnet=$answer
  if [[ ! "$host" =~ ^[a-zA-Z0-9.-]+$ ]]; then
    printf 'Enter a hostname such as %s.\n' "$(hostname -s).local" >&2
    return 1
  fi
  if ! curl --noproxy '*' -ksS --max-time 5 --resolve "$host:443:127.0.0.1" -o /dev/null "https://$host/"; then
    printf 'Could not reach Apache over HTTPS on this node. Crusader is running locally. See the README for LAN setup.\n' >&2
    return 1
  fi
  bash "$source_dir/install-apache.sh" "https://$host" "$subnet"
}

ask() {
  local label=$1 default=${2:-}
  if [[ -n "$default" ]]; then label+=" [$default]"; fi
  read -r -p "$label: " answer
  answer=${answer:-$default}
}

if [[ -f "$install_dir/launch.args" && $# -eq 0 ]]; then
  CRUSADER_INSTALL_WIZARD=1 bash "$source_dir/install-local.sh"
  if systemctl --user is-enabled --quiet crusader.service 2>/dev/null; then
    systemctl --user restart crusader.service
  elif [[ -t 0 ]] && { [[ -d /run/systemd/system ]] || systemctl --user show-environment >/dev/null 2>&1; }; then
    read -r -p 'Set up Crusader to start automatically at boot? [Y/n] ' service_answer
    if [[ -z "$service_answer" || "${service_answer,,}" == y || "${service_answer,,}" == yes ]]; then
      bash "$source_dir/install-service.sh"
    fi
  fi
  configure_browser_access
  exit 0
fi
if [[ ! -t 0 ]]; then
  printf 'Run this command in an interactive terminal for first-time setup.\n' >&2
  exit 1
fi

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

port=8877
advanced=false
ask 'Customize the dashboard port or SkywarnPlus paths? (y/N)' N
if [[ "${answer,,}" == y || "${answer,,}" == yes || "${1:-}" == --reconfigure ]]; then
  advanced=true
  while true; do
    ask 'Local dashboard port' 8877
    if [[ "$answer" =~ ^[0-9]{1,5}$ ]] && (( 10#$answer >= 1024 && 10#$answer <= 65535 )); then
      port=$((10#$answer))
      break
    fi
    printf 'Enter a port from 1024 to 65535.\n'
  done
fi
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
    printf 'Link control lets signed-in operators connect or disconnect other nodes.\n'
    ask 'Allow link control for no nodes (off), specific nodes (listed), or all nodes (any)' off
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

if $advanced; then
  ask 'Custom SkywarnPlus config path (blank for automatic detection)'
  if [[ -n "$answer" ]]; then args+=(--config "$answer"); fi
  ask 'Legacy SkywarnPlus warnings report path (blank for automatic detection)'
  if [[ -n "$answer" ]]; then args+=(--warnings "$answer"); fi
fi

CRUSADER_INSTALL_WIZARD=1 bash "$source_dir/install-local.sh" "${args[@]}"
if systemctl --user is-enabled --quiet crusader.service 2>/dev/null; then
  bash "$source_dir/install-service.sh"
elif [[ -d /run/systemd/system ]] || systemctl --user show-environment >/dev/null 2>&1; then
  ask 'Start Crusader automatically at boot? (Y/n)' Y
  if [[ "${answer,,}" == y || "${answer,,}" == yes ]]; then
    bash "$source_dir/install-service.sh"
  fi
fi
lan_result=0
configure_browser_access || lan_result=$?
if [[ -t 0 && ! -s "$install_dir/tailscale-origin" ]]; then
  ask 'Set up private remote browser access with Tailscale? (y/N)' N
  if [[ "${answer,,}" == y || "${answer,,}" == yes ]]; then
    bash "$source_dir/install-tailscale.sh"
  fi
fi
exit "$lan_result"
