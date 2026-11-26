# Crusader Comm/Link Dashboard

> [!WARNING]
> **Public beta — proceed with caution.** Features and behavior may change. Test on a non-critical ASL3 node first and back up your Asterisk configuration before using the editor or station controls. Service stop, restart, and reboot can interrupt an active station.

Crusader is an AllStarLink 3 dashboard for monitoring and operating a local station. It includes a link map and receive indicators, a Live Caller pop-out, SkywarnPlus, weather radar, a news ticker, favorites, and configurable layouts and themes.

## Install the beta

Run these commands in a terminal **on the ASL3 node** as your normal login user. A new install uses the node’s existing Apache HTTPS site for browser access.

```sh
sudo apt install git curl python3 python3-yaml &&
git clone --branch v0.1.0-beta.6 https://github.com/KD5FMU/Crusader-Comm-Link-Dashboard.git &&
cd Crusader-Comm-Link-Dashboard &&
bash install.sh
```

If you already cloned the repository, use the update commands below.

1. Confirm your AllStarLink node number. The installer suggests it when it finds one. Press Enter at the advanced settings prompt to use port 8877 and automatic SkywarnPlus detection.
2. Enter an existing Asterisk Manager Interface (AMI) username if you want radio activity indicators and dashboard link control. You can leave it blank for basic monitoring. If you enable link control, you can allow specific nodes or all nodes.
3. Accept **Start Crusader automatically at boot** and create your Crusader administrator account when prompted. The installer asks for your AMI secret if you entered an AMI username.
4. Accept **Make Crusader available in browsers on your local network**. Confirm the suggested hostname and network range if they match your setup. Enter your sudo password if prompted.

## Open Crusader

Copy the address printed at the end of setup into a browser on another computer on the same network. For example, use `https://node576332.local/crusader/?live=1`. Sign in with the Crusader administrator account you created. If your browser warns about the HTTPS certificate, verify and trust the node’s certificate before signing in.

Crusader runs as a background service and starts again after a node reboot. You can close the installation terminal and bookmark the dashboard address.

### Manual network setup

The browser setup uses an existing Apache HTTPS site and its certificate. If the node lacks an HTTPS site, configure one with a certificate valid for the node’s hostname, then rerun `bash install.sh`. For a custom HTTPS hostname or network range, you can also run the helper directly on the node.

```sh
bash install-apache.sh https://node.example.local 192.168.1.0/24
```

If you choose to keep Crusader on loopback only, you can still use an SSH tunnel from your workstation. Adjust both ports if you chose a different dashboard port.

```sh
ssh -N -o ExitOnForwardFailure=yes -L 8877:127.0.0.1:8877 YOUR_NODE_USER@YOUR_NODE_HOST
```

Then open `http://127.0.0.1:8877/?live=1`. To start Crusader manually on the node, run `"${XDG_DATA_HOME:-$HOME/.local/share}/crusader-comm-link/crusader"`. To refresh service credentials, run `bash install-service.sh`.

## Update, reconfigure, or roll back

Run this from your normal login account on the node.

```sh
cd "$HOME/Crusader-Comm-Link-Dashboard" &&
git fetch --tags &&
git checkout v0.1.0-beta.6 &&
bash install.sh
```

The installer reuses your saved settings and restarts the enabled service. Stop a manually launched dashboard before updating. Run `bash install.sh --reconfigure` to choose new settings. Use the launcher with `--previous` for a manual rollback after stopping the running dashboard.

Use `systemctl --user status crusader.service` to check the service and `journalctl --user -u crusader.service -n 50` to see recent logs. To turn off automatic startup, run `systemctl --user disable --now crusader.service`.

Accounts and branding are stored in the Crusader data directory. Layouts, themes, and favorites are saved in the browser.

## Uninstall Crusader

Run these steps on the node as the account that installed Crusader.

1. If you enabled automatic startup, stop and disable the service. Remove its unit only after the first command succeeds.

   ```sh
   systemctl --user disable --now crusader.service &&
     rm -- "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/crusader.service" &&
     systemctl --user daemon-reload
   ```

   If you started Crusader manually, press **Ctrl+C** in the terminal running it instead. Skip the service commands if you never installed the service.

2. To remove the installed program and keep your data for a later reinstall, run:

   ```sh
   crusader_dir="${XDG_DATA_HOME:-$HOME/.local/share}/crusader-comm-link"
   rm -f -- "$crusader_dir/crusader" "$crusader_dir/current" "$crusader_dir/previous"
   rm -rf -- "$crusader_dir/releases"
   ```

   The remaining directory contains launch settings, accounts, branding, and any stored AMI credential. For a **complete removal**, back up anything you want to keep and delete the `crusader-comm-link` directory instead. The repository checkout can be deleted separately.

3. If you enabled LAN access, remove the Crusader Apache route with `sudo a2disconf crusader-lan && sudo apache2ctl configtest && sudo systemctl reload apache2 && sudo rm /etc/apache2/conf-available/crusader-lan.conf`.

4. Close any SSH tunnel you opened for Crusader. If you want to remove browser-only preferences, clear site data for the dashboard address.

These steps are limited to Crusader. User lingering is an account-wide systemd setting, so leave it enabled if other user services rely on it.

## Accounts and local integrations

Administrators manage users, branding, and local station tools. Sysops can operate links permitted by setup. Observers can monitor the dashboard. Station tools depend on the permissions of the existing OS and AMI accounts. Manage those separately from Crusader.

The default header logo ships with the dashboard. Administrators can upload a replacement under **Administration** or restore the bundled artwork. Configure map locations, layouts, and ticker preferences from **Configuration**.

SkywarnPlus uses the standard config at `/usr/local/bin/SkywarnPlus/config.yaml` unless overridden during setup. It reads the saved alert state or the legacy report at `/tmp/AUTOSKY/warnings.txt`. Enable weather alerts in ticker settings to include local warnings.

## Live Caller country flags

Flags indicate the location published for the linked AllStarLink node. Crusader matches the directory coordinates against its bundled Natural Earth country boundaries (via PublicaMundi). Missing or unmatched locations omit the flag. The linked node may be a hub or relay. Flag artwork is from [flag-icons](https://github.com/lipis/flag-icons) 7.6.0 under the MIT license in `dist/flags/LICENSE`. The Live Caller flag display was inspired by WPSD's Live Caller.


## Station tools

In live mode, use **Station tools** for public node lookup and bubble charts, local repeater reports, and host diagnostics. Administrators and Sysops can send local DTMF and request station announcements. Configuration, Asterisk service operations, reboot, logs, and database output require the Administrator role. Asterisk CLI actions require the existing local AMI account with command permission. Start, stop, restart, and reboot use systemd with the Crusader account's existing operating-system authorization. Configuration edits require read access, file ownership, and permission to replace files within the Asterisk config directory. Saving creates a private backup in that directory and requires a separate reload to apply changes. Log availability depends on the host's journald, Asterisk and Apache configuration.

## Live map weather and ticker news

The Link map offers U.S. radar from the Iowa Environmental Mesonet and global radar where RainViewer has coverage. Select a source for the latest available still, or play the recent frame loop. The dashboard checks for new frames every minute. Frame age and coverage depend on the source. County boundaries use U.S. Census geometry distributed by [us-atlas](https://github.com/topojson/us-atlas). The NWS watches and warnings overlay uses the National Weather Service's active watch, warning and advisory map service.

In **Configuration → Status ticker**, select separate sources for national, local, and breaking headlines. The default national and breaking source is ABC News. KJRH Tulsa is the default local source. The locally installed dashboard reads the selected publishers' RSS feeds through its signed-in news endpoint. A headline gets red styling when its publisher tags it as breaking or explicitly labels it as breaking at the start of the headline.
