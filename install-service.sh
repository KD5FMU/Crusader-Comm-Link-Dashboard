#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( EUID == 0 )); then
  printf 'Run this as your normal node login account.\n' >&2
  exit 1
fi
data_home=${XDG_DATA_HOME:-$HOME/.local/share}
launcher="$data_home/crusader-comm-link/crusader"
if [[ ! -x "$launcher" ]]; then
  printf 'Run bash install.sh before configuring the service.\n' >&2
  exit 1
fi
if ! systemctl --user show-environment >/dev/null 2>&1; then
  printf 'A systemd user session is required. Sign in directly to the node with SSH and try again.\n' >&2
  exit 1
fi

"$launcher" --setup-service
user=$(id -un)
if [[ $(loginctl show-user "$user" -p Linger --value) != yes ]]; then
  printf 'Enabling this account’s user services to start at boot. Sudo may ask for your password.\n'
  sudo loginctl enable-linger "$user"
fi

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p -- "$unit_dir"
python3 - "$unit_dir/crusader.service" "$launcher" "$data_home" <<'PY'
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile

def quote(value):
    if any(ord(char) < 32 for char in value):
        raise ValueError("Service paths cannot contain control characters")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'

path, launcher, data_home = sys.argv[1:]
unit = f"""[Unit]
Description=Crusader Comm/Link Dashboard

[Service]
Type=simple
Environment={quote("XDG_DATA_HOME=" + data_home)}
ExecStart={quote(launcher.replace("$", "$$"))} --service
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"""
path = Path(path)
with NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
    stream.write(unit)
Path(stream.name).replace(path)
PY
systemctl --user daemon-reload
systemctl --user enable crusader.service
systemctl --user restart crusader.service
printf 'Crusader is enabled at boot. Check status with: systemctl --user status crusader.service\n'
