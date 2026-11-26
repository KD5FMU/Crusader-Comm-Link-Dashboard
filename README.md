# Crusader Comm/Link Dashboard

Crusader is an AllStarLink 3 dashboard for monitoring and operating a local station. It includes a link map and receive indicators, a Live Caller pop-out, SkywarnPlus, weather radar, a news ticker, favorites, and configurable layouts and themes.

## Install the beta

Beta testers need read access to this repository, SSH access to their own Debian-based ASL3 node, Git, Python 3, and PyYAML. Run the following on the ASL3 node as your normal login user.

```sh
sudo apt install git python3 python3-yaml
git clone --branch v0.1.0-beta.1 https://github.com/KD5FMU/Crusader-Comm-Link-Dashboard.git
cd Crusader-Comm-Link-Dashboard
bash install.sh
```

The installer checks `rpt localnodes` and offers the detected node as the default when there is one. If the live query is unavailable, it checks numeric sections in readable `/etc/asterisk/rpt.conf`. You can enter the node manually. Setup also asks for the dashboard port, an optional local Asterisk Manager Interface (AMI) username, peer permissions for link control, and optional SkywarnPlus paths. AMI is needed for per-link receive activity and TX/RX/COS telemetry.

The installer writes to `${XDG_DATA_HOME:-$HOME/.local/share}/crusader-comm-link`. Asterisk and SkywarnPlus configuration and host permissions are managed separately. The dashboard works with one selected local control node per instance.

## Start and open the dashboard

On the node, start the launcher:

```sh
"${XDG_DATA_HOME:-$HOME/.local/share}/crusader-comm-link/crusader"
```

Enter the AMI secret if you enabled it. At first launch, choose a Crusader administrator username and a password of at least 12 characters. The AMI secret is entered at runtime and is kept out of the installer’s saved options.

From your workstation, open a second terminal and forward the selected port. This example uses the default port 8877.

```sh
ssh -N -o ExitOnForwardFailure=yes -L 8877:127.0.0.1:8877 YOUR_NODE_USER@YOUR_NODE_HOST
```

Leave both terminals open and visit [the live dashboard](http://127.0.0.1:8877/?live=1). The server listens on loopback.

## Update, reconfigure, or roll back

Stop the running Crusader launcher with **Ctrl+C** before changing the installed release. Check out the new beta tag and run `bash install.sh` again. By default the installer reuses the saved launch settings. Run `bash install.sh --reconfigure` to choose new launch settings. Use the launcher with `--previous` to run the preceding installed build and its saved options. Accounts and branding are stored in the Crusader data directory, while layouts, themes, and favorites are saved in the browser.

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
