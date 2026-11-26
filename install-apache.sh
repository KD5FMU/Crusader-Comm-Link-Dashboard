#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( EUID == 0 )) || (( $# != 2 )); then
  printf 'As your node login user, run: bash install-apache.sh https://NODE_HOST LAN_CIDR\n' >&2
  exit 2
fi
origin=$1
lan=$2
if [[ ! "$origin" =~ ^https://[a-zA-Z0-9.-]+$ ]]; then
  printf 'Supply an HTTPS hostname without a trailing slash or path.\n' >&2
  exit 2
fi
lan=$(python3 - "$lan" <<'PY'
from ipaddress import ip_network
import sys
network = ip_network(sys.argv[1], strict=True)
if not any(network.subnet_of(ip_network(block)) for block in (
    ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16") if network.version == 4 else ("fc00::/7",)
)):
    sys.exit("Use a private LAN subnet.")
print(network)
PY
)
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/crusader-comm-link"
mapfile -d '' -t args < "$data_dir/launch.args"
port=8080
for (( i=0; i<${#args[@]}; i++ )); do
  if [[ "${args[i]}" == --port ]]; then port=${args[i+1]}; fi
done
[[ "$port" =~ ^[0-9]{1,5}$ ]] || { printf 'Invalid dashboard port.\n' >&2; exit 1; }

export XDG_RUNTIME_DIR="/run/user/$UID"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user is-active --quiet crusader.service || {
  printf 'Start the Crusader systemd service before configuring Apache.\n' >&2
  exit 1
}
sudo apache2ctl configtest
sudo a2enmod proxy_http
sudo apache2ctl -M | awk '/ssl_module/ { found=1 } END {exit !found}' || {
  printf 'Enable an HTTPS virtual host on Apache first.\n' >&2
  exit 1
}

config=$(mktemp)
trap 'rm -f -- "$config"' EXIT
cat > "$config" <<APACHE
# Managed by Crusader Comm/Link install-apache.sh
<Location "/crusader/">
    SSLRequireSSL
    <RequireAll>
        Require ip $lan 127.0.0.1 ::1
        Require expr "%{HTTP_HOST} == '${origin#https://}'"
    </RequireAll>
    ProxyPass "http://127.0.0.1:$port/crusader/"
    ProxyPassReverse "http://127.0.0.1:$port/crusader/"
</Location>
APACHE
target=/etc/apache2/conf-available/crusader-lan.conf
if sudo test -e "$target"; then
  if ! sudo cmp -s "$target" "$config"; then
    printf 'Existing Apache configuration differs at %s. Review it before rerunning.\n' "$target" >&2
    exit 1
  fi
else
  sudo install -m 644 "$config" "$target"
fi
sudo a2enconf crusader-lan
if ! sudo apache2ctl configtest; then
  sudo a2disconf crusader-lan
  exit 1
fi
printf '%s\n' "$origin" > "$data_dir/https-origin"
systemctl --user restart crusader.service
sudo systemctl reload apache2
if ! curl --noproxy '*' -kfsS --retry 3 --retry-connrefused --max-time 5 \
    --resolve "${origin#https://}:443:127.0.0.1" "$origin/crusader/?live=1" |
    grep -F '<title>Crusader Comm/Link</title>' >/dev/null; then
  printf 'The Apache route was configured but the dashboard page could not be verified. See the README.\n' >&2
  exit 1
fi
printf '\nOpen %s/crusader/?live=1 in a browser on your local network.\n' "$origin"
printf 'If your browser reports a certificate warning, verify and trust the node certificate before signing in.\n'
