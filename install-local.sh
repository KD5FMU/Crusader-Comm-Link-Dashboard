#!/usr/bin/env bash
set -euo pipefail
umask 077

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/crusader-comm-link"

if ! command -v python3 >/dev/null || ! python3 -c 'import yaml' 2>/dev/null; then
  echo 'Python 3 and python3-yaml are required. On Debian, install python3-yaml with apt.' >&2
  exit 1
fi
if [[ ! -f "$source_dir/local_console.py" || ! -f "$source_dir/dist/index.html" || ! -f "$source_dir/crusader-launch" ]]; then
  echo 'This is an incomplete Crusader bundle.' >&2
  exit 1
fi
if [[ ! -f "$install_dir/launch.args" && $# -eq 0 ]]; then
  echo 'For a first install, pass the same launch options you use with local_console.py.' >&2
  exit 1
fi

# Credentials are entered at runtime. Only these known launch options are saved.
args=("$@")
while (( $# )); do
  case "$1" in
    --node|--port|--ami-user|--control-peer|--config|--warnings|--max-age)
      if [[ $# -lt 2 || "$2" == -* ]]; then
        printf 'Missing value for %s\n' "$1" >&2
        exit 1
      fi
      shift 2
      ;;
    --sudo-lstats|--control-any-peer) shift ;;
    *) printf 'Unknown launch option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

mkdir -p -- "$install_dir/releases"
release=$(mktemp -d "$install_dir/releases/release.XXXXXX")
staging=$(mktemp -d "$install_dir/update.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
cp -R -- "$source_dir/local_console.py" "$source_dir/dist" "$release/"
python3 "$release/local_console.py" --help >/dev/null
install -m 700 -- "$source_dir/crusader-launch" "$staging/crusader"
if (( ${#args[@]} )); then
  printf '%s\0' "${args[@]}" > "$staging/launch.args"
fi
if [[ -L "$install_dir/current" ]]; then
  ln -s -- "$(readlink -- "$install_dir/current")" "$staging/previous"
  cp -- "$install_dir/launch.args" "$staging/previous.args"
  mv -Tf -- "$staging/previous" "$install_dir/previous"
  mv -Tf -- "$staging/previous.args" "$install_dir/previous.args"
fi
ln -s -- "$release" "$staging/current"
if [[ -f "$staging/launch.args" ]]; then
  mv -T -- "$staging/launch.args" "$install_dir/launch.args"
fi
mv -Tf -- "$staging/current" "$install_dir/current"
mv -Tf -- "$staging/crusader" "$install_dir/crusader"
printf 'Installed Crusader Comm/Link. Start it with:\n  %q\n' "$install_dir/crusader"
