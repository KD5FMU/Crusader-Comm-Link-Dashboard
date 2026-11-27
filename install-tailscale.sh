#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( EUID == 0 )) || [[ ! -t 0 ]]; then
  printf 'Run this in a terminal on the node as your normal login user.\n' >&2
  exit 1
fi

data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/crusader-comm-link"
if [[ -S "/run/user/$UID/bus" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$UID"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
if [[ ! -f "$data_dir/launch.args" ]] || ! systemctl --user is-active --quiet crusader.service; then
  printf 'Start the Crusader boot service with bash install.sh before setting up remote access.\n' >&2
  exit 1
fi

if ! command -v tailscale >/dev/null; then
  read -r -p 'Download and run the official Tailscale installer? [y/N] ' answer
  [[ "${answer,,}" == y || "${answer,,}" == yes ]] || exit 0
  installer=$(mktemp)
  trap 'rm -f -- "$installer"' EXIT
  curl --proto '=https' -fsSL https://tailscale.com/install.sh -o "$installer"
  sh "$installer"
fi

# Existing connections keep their current preferences.
if ! tailscale status --json | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin).get("BackendState") != "Running")'; then
  printf 'Open the link Tailscale prints to sign in or create your Tailscale account.\n'
  sudo tailscale up
fi
host=$(tailscale status --json | python3 -c '
import json,re,sys
status=json.load(sys.stdin)
host=(status.get("Self") or {}).get("DNSName","").rstrip(".").lower()
if status.get("BackendState") != "Running" or not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net",host):
    sys.exit("Tailscale must be connected with MagicDNS enabled.")
print(host)
')
mapfile -d '' -t args < "$data_dir/launch.args"
port=8080
for (( i=0; i<${#args[@]}; i++ )); do
  if [[ "${args[i]}" == --port ]]; then port=${args[i+1]}; fi
done
[[ "$port" =~ ^[0-9]{1,5}$ ]] || exit 1
target="http://127.0.0.1:$port"

# Reserve 8443 for Crusader only if it is free, or already serves this dashboard privately.
serve_config=$(sudo tailscale serve status --json)
route_state=$(python3 -c '
import json, sys
config=json.loads(sys.argv[1]) or {}
key=sys.argv[2]+":8443"
tcp=(config.get("TCP") or {}).get("8443")
web=config.get("Web") or {}
public=config.get("AllowFunnel") or {}
other=any(k.endswith(":8443") and k != key for k in web)
if other or any(k.endswith(":8443") and enabled for k,enabled in public.items()):
    sys.exit("Tailscale port 8443 is already in use. Existing sharing has been preserved.")
slot=web.get(key)
if slot == {"Handlers":{"/":{"Proxy":sys.argv[3]}}} and tcp == {"HTTPS":True}:
    print("existing")
elif slot is None and tcp is None:
    print("free")
else:
    sys.exit("Tailscale port 8443 is already in use. Existing sharing has been preserved.")
' "$serve_config" "$host" "$target")

if [[ "$route_state" == free ]]; then
  printf 'Follow any Tailscale prompt to enable HTTPS for your private network.\n'
  sudo tailscale serve --bg --https=8443 "$target"
fi
origin="https://$host:8443"
origin_file=$(mktemp "$data_dir/.tailscale-origin.XXXXXX")
printf '%s\n' "$origin" > "$origin_file"
mv -f -- "$origin_file" "$data_dir/tailscale-origin"
rm -f -- "$data_dir/tailscale-disabled"
systemctl --user restart crusader.service
for attempt in {1..10}; do
  if curl --noproxy '*' -fsS --max-time 4 "$origin/crusader/?live=1" 2>/dev/null |
      grep -F '<title>Crusader Comm/Link</title>' >/dev/null; then
    printf '\nOpen %s/crusader/ from a device signed into your Tailscale network.\n' "$origin"
    exit 0
  fi
  sleep 1
done
printf 'Tailscale Serve was configured, but the HTTPS page could not be verified on this node.\nTry %s/crusader/ from another authorized Tailscale device.\n' "$origin" >&2
exit 1
