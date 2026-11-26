"""Serve Crusader Comm/Link and a read-only SkywarnPlus status endpoint."""
import argparse
import errno
import base64
import hashlib
import secrets
import sqlite3
import struct
from http.cookies import SimpleCookie, CookieError
from os import cpu_count, environ, fchmod, fsync, geteuid, replace
import html
import getpass
import hmac
from threading import Lock
import socket
import json
import re
import time
import subprocess
from shutil import which
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from os import fstat
from pathlib import Path
from stat import S_ISREG
from tempfile import NamedTemporaryFile
from urllib.parse import parse_qs, urljoin, urlsplit
from urllib.request import urlopen
from xml.etree import ElementTree

import yaml


SKYWARN_CONFIG = Path("/usr/local/bin/SkywarnPlus/config.yaml")
SKYWARN_REPORT = Path("/tmp/AUTOSKY/warnings.txt")


def skywarn_saved_alerts(path):
    with path.open(encoding="utf-8") as stream:
        modified = fstat(stream.fileno()).st_mtime_ns
        raw = stream.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024 or fstat(stream.fileno()).st_mtime_ns != modified:
            raise ValueError("SkywarnPlus state changed while being read")
    now = datetime.now(timezone.utc)
    alerts = []
    for title, counties in json.loads(raw)["last_alerts"]:
        active = [county for county in counties
                  if datetime.fromisoformat(county["end_time_utc"].replace("Z", "+00:00")) > now]
        if active:
            test = all(county.get("description") == "This alert was manually injected as a test."
                       for county in active)
            codes = ", ".join(sorted({county["county_code"] for county in active}))
            alerts.append(f"{'TEST · ' if test else ''}{title} [{codes}]")
    timestamp = datetime.fromtimestamp(modified / 1e9, timezone.utc).isoformat(timespec="seconds")
    return dict(status="active" if alerts else "clear", alerts="\n".join(alerts),
                updatedAt=timestamp, source="state")


def skywarn_status(config, warnings, max_age):
    config = config or SKYWARN_CONFIG
    try:
        settings = yaml.safe_load(config.read_text(encoding="utf-8"))
        enabled = settings["SKYWARNPLUS"]["Enable"]
    except FileNotFoundError:
        return dict(status="missing", detail="The configured SkywarnPlus file was not found.")
    except (OSError, ValueError, KeyError, TypeError, yaml.YAMLError):
        return dict(status="unavailable", detail="The SkywarnPlus configuration could not be read.")
    if enabled is False:
        return dict(status="disabled", detail="The SkywarnPlus master setting is disabled.")
    if enabled is not True:
        return dict(status="unavailable", detail="The SkywarnPlus master setting could not be interpreted.")
    if warnings is None:
        try:
            state_dir = Path(settings.get("DEV", {}).get("TmpDir", "/tmp/SkywarnPlus"))
            return skywarn_saved_alerts(state_dir / "data.json")
        except FileNotFoundError:
            warnings = SKYWARN_REPORT
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return dict(status="stale", detail="Could not read SkywarnPlus saved alert state. Check that the Crusader account can read data.json.")
    try:
        with warnings.open(encoding="utf-8") as stream:
            modified = fstat(stream.fileno()).st_mtime
            report = stream.read(16385)
            if fstat(stream.fileno()).st_mtime != modified or len(report) > 16384:
                return dict(status="stale", detail="The SkywarnPlus alert report could not be read consistently.")
    except (OSError, ValueError):
        return dict(status="stale", detail="The SkywarnPlus alert report is unavailable.")
    if not 0 <= time.time() - modified <= max_age:
        return dict(status="stale", detail="The SkywarnPlus alert report is outside the configured freshness window.")
    alerts = html.unescape(re.sub(r"<br\s*/?>", "\n", report, flags=re.IGNORECASE)).strip()
    timestamp = datetime.fromtimestamp(modified, timezone.utc).isoformat(timespec="seconds")
    return dict(status="active" if alerts else "clear", alerts=alerts, updatedAt=timestamp)


def parse_links(output):
    lines = output.strip().splitlines()
    if len(lines) < 2 or lines[0].split() != [
        "NODE", "PEER", "RECONNECTS", "DIRECTION", "CONNECT", "TIME", "CONNECT", "STATE"
    ] or any(set(column) != {"-"} for column in lines[1].split()):
        raise ValueError("Unexpected link table")
    links = []
    for line in lines[2:]:
        match = re.fullmatch(r"(\S+)\s+(.+?)\s+(\d+)\s+(IN|OUT)\s+(\d+:\d{2}:\d{2}:\d+)\s+(ESTABLISHED|CONNECTING)", line.strip())
        if not match:
            raise ValueError("Unexpected link row")
        node, _, reconnects, direction, duration, status = match.groups()
        links.append(dict(node=node, reconnects=int(reconnects), direction=direction, duration=duration, status=status))
    return links


def node_status(node, sudo_lstats=False):
    if node is None:
        return dict(status="disabled")
    try:
        binary = which("asterisk") or "/usr/sbin/asterisk"
        command = [binary, "-rx", f"rpt lstats {node}"]
        if sudo_lstats:
            command = ["/usr/bin/sudo", "-n", "/usr/sbin/asterisk", *command[1:]]
        result = subprocess.run(command, capture_output=True, text=True, timeout=3, check=True)
        return dict(status="online", node=node, links=parse_links(result.stdout))
    except (OSError, subprocess.SubprocessError, ValueError):
        return dict(status="unavailable", node=node)


def ami_request(username, secret, fields):
    def request(connection, reader, fields):
        message = "".join(f"{key}: {value}\r\n" for key, value in fields.items()) + "\r\n"
        connection.sendall(message.encode("utf-8"))
        response = []
        for _ in range(4096):
            line = reader.readline(4096)
            if not line or len(line) == 4096:
                raise ValueError("Incomplete AMI response")
            if line == b"\r\n":
                if "Response: Success" not in response:
                    raise ValueError("AMI request failed")
                return response
            response.append(line.decode("utf-8").rstrip("\r\n"))
        raise ValueError("AMI response too large")

    with socket.create_connection(("127.0.0.1", 5038), timeout=1) as connection:
        with connection.makefile("rb") as reader:
            if not reader.readline(4096).startswith(b"Asterisk Call Manager/"):
                raise ValueError("Unexpected AMI banner")
            request(connection, reader, {"Action":"Login","Username":username,"Secret":secret,"Events":"off"})
            return request(connection, reader, fields)


def receive_activity(node, username, secret):
    response = ami_request(username, secret, {"Action":"RptStatus","Command":"SawStat","Node":node})
    if f"Node: {node}" not in response:
        raise ValueError("Unexpected AMI node")
    active = []
    for line in response:
        if line.startswith("Conn: "):
            peer, keyed, _, _ = line[6:].split()
            if keyed == "1":
                active.append(peer)
    return active


def radio_keying(node, username, secret):
    response = ami_request(username, secret, {"Action":"RptStatus","Command":"XStat","Node":node})
    if f"Node: {node}" not in response:
        raise ValueError("Unexpected AMI node")
    variables = {}
    for line in response:
        if line.startswith("Var: "):
            name, _, value = line[5:].partition("=")
            variables[name] = value
    keyed = {"0": False, "1": True}
    return dict(tx=keyed.get(variables.get("RPT_TXKEYED")),
                cos=keyed.get(variables.get("RPT_RXKEYED")))


LINK_COMMANDS = {"disconnect": 1, "monitor": 2, "transceive": 3, "local-monitor": 8, "permanent-monitor": 12,
                 "permanent-transceive": 13, "permanent-local-monitor": 18, "disconnect-permanent": 11}


def change_link(options, peer, action):
    def current_links():
        snapshot = node_status(options.node, options.sudo_lstats)
        if snapshot["status"] != "online":
            raise ValueError("Link status unavailable")
        return {link["node"]: link["status"] for link in snapshot["links"]}

    before = current_links()
    if action == "disconnect" and peer not in before:
        return {"status": "confirmed", "message": "Node is already disconnected."}
    if not action.startswith("disconnect") and peer in before:
        return {"status": "conflict", "message": "Disconnect the existing link before choosing a connection mode."}
    command = f"rpt cmd {options.node} ilink {LINK_COMMANDS[action]} {peer}"
    ami_request(options.ami_user, options.ami_secret, {"Action": "Command", "Command": command})
    for _ in range(8):
        time.sleep(0.5)
        try:
            links = current_links()
        except ValueError:
            continue
        confirmed = peer not in links if action.startswith("disconnect") else links.get(peer) == "ESTABLISHED"
        if confirmed:
            return {"status": "confirmed", "message": f"Node {peer} is " + ("disconnected." if action.startswith("disconnect") else "established.")}
    return {"status": "pending", "message": "Command sent. Asterisk has not confirmed the requested link state yet."}


NEWS_FEEDS = {
    "abc": ("ABC News", "https://abcnews.com/abcnews/topstories"),
    "abc-us": ("ABC News U.S.", "https://abcnews.com/abcnews/usheadlines"),
    "kjrh": ("KJRH Tulsa", "https://www.kjrh.com/news/local-news.rss"),
    "kwgs": ("Public Radio Tulsa", "https://www.publicradiotulsa.org/index.rss"),
    "kosu": ("KOSU Oklahoma", "https://www.kosu.org/index.rss"),
}


class NewsFeeds:
    def __init__(self):
        self.cache = {}
        self.lock = Lock()

    def headlines(self, source):
        name, url = NEWS_FEEDS[source]
        with self.lock:
            expiry, result = self.cache.get(source, (0, {}))
            if expiry > time.monotonic():
                return result
            try:
                with urlopen(url, timeout=5) as response:
                    body = response.read(1024 * 1024 + 1)
                if len(body) > 1024 * 1024 or re.search(rb"<!DOCTYPE|<!ENTITY", body, re.I):
                    raise ValueError("Unexpected news feed")
                root = ElementTree.fromstring(body)
                if root.tag != "rss":
                    raise ValueError("Expected RSS")
                headlines = []
                for item in root.findall("./channel/item")[:20]:
                    title = " ".join(html.unescape(item.findtext("title", "")).split())[:240]
                    tags = [tag.text or "" for tag in item.findall("category")]
                    breaking = bool(re.match(r"^breaking(?: news)?\s*[:—–-]", title, re.I)) or any(
                        tag.strip().lower() in {"breaking", "breaking news"} for tag in tags
                    )
                    if title:
                        href = ""
                        link = item.findtext("link", "").strip()
                        if link:
                            try:
                                candidate = urljoin(url, link)
                                parsed = urlsplit(candidate)
                                if parsed.scheme in {"https", "http"} and parsed.hostname and not parsed.username:
                                    href = candidate
                            except ValueError:
                                pass
                        headlines.append({"title":title, "breaking":breaking, "url":href})
                result = dict(status="online", source=name, headlines=headlines)
            except (OSError, ValueError, ElementTree.ParseError):
                result = dict(status="unavailable", source=name, headlines=[])
            self.cache[source] = (time.monotonic() + (180 if result["status"] == "online" else 45), result)
            return result


MAP_FEED = "https://stats.allstarlink.org/api/stats/mapData"


def inside_ring(longitude, latitude, ring):
    inside = False
    previous_x, previous_y = ring[-1]
    for x, y in ring:
        if (y > latitude) != (previous_y > latitude):
            crossing = x + (previous_x - x) * (latitude - y) / (previous_y - y)
            if longitude < crossing:
                inside = not inside
        previous_x, previous_y = x, y
    return inside


def country_at(latitude, longitude, countries, codes):
    for feature in countries:
        code = codes.get(feature.get("id"))
        if not code:
            continue
        geometry = feature["geometry"]
        polygons = geometry["coordinates"]
        if geometry["type"] == "Polygon":
            polygons = [polygons]
        for outline, *holes in polygons:
            if inside_ring(longitude, latitude, outline) and not any(
                inside_ring(longitude, latitude, ring) for ring in holes
            ):
                return code
    return None


class StationDirectory:
    def __init__(self):
        self.locations = {}
        self.stations = {}
        assets = Path(__file__).resolve().parent / "dist"
        self.countries = json.loads((assets / "countries.json").read_text(encoding="utf-8"))["features"]
        self.country_codes = json.loads((assets / "country-codes.json").read_text(encoding="utf-8"))
        self.refresh_at = 0
        self.status = "unavailable"
        self.lock = Lock()

    def lookup(self, nodes):
        with self.lock:
            if time.monotonic() >= self.refresh_at:
                try:
                    with urlopen(MAP_FEED, timeout=5) as response:
                        limit = 8 * 1024 * 1024
                        body = response.read(limit + 1)
                    if len(body) > limit:
                        raise ValueError("Map feed too large")
                    locations = {}
                    stations = {}
                    for line in body.decode("utf-8-sig", errors="replace").splitlines():
                        fields = line.split("\t")
                        if len(fields) < 4 or not re.fullmatch(r"[0-9]{3,10}", fields[0].strip()):
                            continue
                        node = fields[0].strip()
                        stations[node] = dict(callsign=fields[1].strip()[:40],
                                              location=fields[4].strip()[:160] if len(fields) > 4 else "",
                                              description=fields[5].strip()[:160] if len(fields) > 5 else "")
                        try:
                            lat, lon = map(float, fields[2:4])
                        except ValueError:
                            continue
                        if -85 <= lat <= 85 and -180 <= lon <= 180 and (lat, lon) != (0, 0):
                            locations[fields[0].strip()] = [lat, lon]
                    if not locations:
                        raise ValueError("No usable map locations")
                    self.locations = locations
                    self.stations = stations
                    self.status = "online"
                    self.refresh_at = time.monotonic() + 900
                except (OSError, ValueError):
                    self.status = "cached" if self.locations else "unavailable"
                    self.refresh_at = time.monotonic() + 60
            for node in nodes:
                station = self.stations.get(node)
                if station is not None and "country" not in station:
                    coordinates = self.locations.get(node)
                    station["country"] = country_at(*coordinates, self.countries, self.country_codes) if coordinates else None
            return {"status":self.status,
                    "locations":{node:self.locations[node] for node in nodes if node in self.locations},
                    "stations":{node:self.stations[node] for node in nodes if node in self.stations}}


SYSTEM_ACTIONS = {
    "start": ["/usr/bin/systemctl", "--no-ask-password", "start", "asterisk.service"],
    "stop": ["/usr/bin/systemctl", "--no-ask-password", "stop", "asterisk.service"],
    "restart": ["/usr/bin/systemctl", "--no-ask-password", "restart", "asterisk.service"],
    "reboot": ["/usr/bin/systemctl", "--no-ask-password", "reboot"],
}
LOCAL_REPORTS = {
    "cpu": ["/usr/bin/uptime"],
    "linux": ["/usr/bin/journalctl", "-n", "80", "--no-pager"],
    "connection-log": ["/usr/bin/tail", "-n", "80", "/var/log/asterisk/connectlog"],
    "asterisk": ["/usr/bin/journalctl", "-u", "asterisk.service", "-n", "80", "--no-pager"],
    "web-access": ["/usr/bin/tail", "-n", "80", "/var/log/apache2/access.log"],
    "web-error": ["/usr/bin/tail", "-n", "80", "/var/log/apache2/error.log"],
}
REPEATER_REPORTS = {"rpt-stats": "stats", "connections": "lstats", "topology": "nodes"}
STATION_COMMANDS = {"identify": "status 11", "time": "status 12"}


CONFIG_FILES = {name: Path("/etc/asterisk") / name for name in ("rpt.conf", "iax.conf", "extensions.conf")}
CONFIG_LIMIT = 128 * 1024


def read_config_file(path):
    if path.is_symlink() or not S_ISREG(path.stat().st_mode):
        raise ValueError("Select an installed regular configuration file.")
    with path.open("rb") as stream:
        content = stream.read(CONFIG_LIMIT + 1)
        metadata = fstat(stream.fileno())
    if len(content) > CONFIG_LIMIT:
        raise ValueError("Configuration file exceeds the editor size limit.")
    return content, metadata


def save_config_file(path, text, revision):
    content = text.encode("utf-8")
    if not content or len(content) > CONFIG_LIMIT or "\0" in text:
        raise ValueError("Enter a nonempty configuration within the editor size limit.")
    original, metadata = read_config_file(path)
    if hashlib.sha256(original).hexdigest() != revision:
        raise ValueError("The file changed since it was opened. Reopen it before saving.")
    if metadata.st_uid != geteuid():
        raise ValueError("The Crusader service account must own this file to save it.")
    with NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.backup-", delete=False) as backup:
        backup.write(original)
        backup.flush()
        fsync(backup.fileno())
    pending = None
    try:
        with NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as stream:
            pending = Path(stream.name)
            if fstat(stream.fileno()).st_gid != metadata.st_gid:
                raise ValueError("Saving would change the file's group.")
            stream.write(content)
            fchmod(stream.fileno(), metadata.st_mode & 0o777)
            stream.flush()
            fsync(stream.fileno())
        if path.is_symlink() or path.stat().st_mtime_ns != metadata.st_mtime_ns:
            raise ValueError("The file changed while saving. Reopen it before retrying.")
        replace(pending, path)
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)
    return dict(message=f"Saved. Backup: {Path(backup.name).name}", revision=hashlib.sha256(content).hexdigest())


def run_local_report(command):
    result = subprocess.run(command, capture_output=True, text=True, errors="replace", timeout=8, check=True)
    return result.stdout[-24000:]


def station_action(options, action, digits):
    if action in SYSTEM_ACTIONS:
        run_local_report(SYSTEM_ACTIONS[action])
        return "System command accepted."
    if not options.ami_user or not options.node:
        raise ValueError("Configure the local node and AMI account first.")
    if action == "reload":
        commands = ["iax2 reload", "module reload app_rpt.so", "dialplan reload"]
    elif action == "dtmf":
        commands = [f"rpt fun {options.node} {digits}"]
    else:
        commands = [f"rpt cmd {options.node} {STATION_COMMANDS[action]}"]
    for command in commands:
        lines = ami_request(options.ami_user, options.ami_secret, {"Action":"Command","Command":command})
        if any(re.search(r"No such command|Command failed|Unable to", line, re.I) for line in lines):
            raise ValueError("Asterisk rejected a command.")
    return "Command sent to Asterisk."


ROLES = {"Administrator", "Sysop", "Observer"}
SESSION_SECONDS = 28800


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 600_000)


class Accounts:
    def __init__(self, path):
        self.path = path
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.touch(mode=0o600, exist_ok=True)
        self.lock = Lock()
        self.sessions = {}
        self.login_after = 0
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, role TEXT, salt BLOB, digest BLOB)")
            db.execute("CREATE TABLE IF NOT EXISTS logo (id INTEGER PRIMARY KEY, image BLOB)")
            db.execute("CREATE TABLE IF NOT EXISTS landing (key TEXT PRIMARY KEY, value BLOB)")

    def connect(self):
        return sqlite3.connect(self.path)

    def users(self):
        with self.connect() as db:
            return [dict(name=name, role=role) for name, role in db.execute("SELECT name, role FROM users ORDER BY name")]

    def save(self, name, password, role):
        if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", name)
                or not isinstance(password, str) or not 12 <= len(password) <= 128
                or not isinstance(role, str) or role not in ROLES):
            raise ValueError("Use a valid username, role, and password of 12–128 characters.")
        salt = secrets.token_bytes(16)
        digest = password_hash(password, salt)
        with self.lock, self.connect() as db:
            db.execute("INSERT OR REPLACE INTO users VALUES (?, ?, ?, ?)", (name, role, salt, digest))
            self.sessions = {token: session for token, session in self.sessions.items() if session[0] != name}

    def login(self, name, password):
        if not isinstance(name, str) or not isinstance(password, str) or len(name) > 40 or len(password) > 128:
            return None
        with self.lock, self.connect() as db:
            now = time.monotonic()
            if now < self.login_after:
                return None
            row = db.execute("SELECT role, salt, digest FROM users WHERE name=?", (name,)).fetchone()
            role, salt, digest = row or (None, bytes(16), bytes(32))
            if not hmac.compare_digest(password_hash(password, salt), digest) or not role:
                self.login_after = now + 1
                return None
            self.sessions = {token: session for token, session in self.sessions.items() if session[2] > now}
            token = secrets.token_urlsafe(32)
            self.sessions[token] = (name, role, now + SESSION_SECONDS)
            return token, dict(name=name, role=role)

    def session(self, token):
        with self.lock:
            row = self.sessions.get(token)
            if row and row[2] > time.monotonic():
                return dict(name=row[0], role=row[1])
            self.sessions.pop(token, None)
            return None

    def logout(self, token):
        with self.lock:
            self.sessions.pop(token, None)

    def landing(self):
        with self.connect() as db:
            metadata = db.execute("SELECT value FROM landing WHERE key='settings'").fetchone()
            assets = [key for key, in db.execute("SELECT key FROM landing WHERE key<>'settings'")]
        return {**(json.loads(metadata[0]) if metadata else {"text": "", "font": "oxanium"}), "assets": assets}

    def landing_asset(self, key):
        with self.connect() as db:
            row = db.execute("SELECT value FROM landing WHERE key=?", (key,)).fetchone()
            return row[0] if row else None

    def save_landing(self, request):
        welcome, font = request["text"], request["font"]
        if not isinstance(welcome, str) or len(welcome) > 1200 or font not in ("oxanium", "system", "serif", "mono", "custom"):
            raise ValueError("Invalid landing page text or font.")
        assets = {}
        for key, limit in (("foreground", 2_000_000), ("background", 2_000_000), ("font", 2_000_000)):
            field = "fontFile" if key == "font" else key
            if field not in request:
                continue
            encoded = request[field]
            if encoded is None:
                assets[key] = None
                continue
            data = base64.b64decode(encoded, validate=True)
            if not 16 <= len(data) <= limit:
                raise ValueError(f"Invalid landing {key} file size.")
            if key == "foreground":
                valid = (len(data) >= 24 and data[:16] == b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"
                         and struct.unpack(">II", data[16:24]) == (640, 640))
            elif key == "background":
                valid = data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9")
            else:
                valid = data[:4] in (b"wOFF", b"wOF2", b"OTTO", b"\x00\x01\x00\x00")
            if not valid:
                raise ValueError(f"Invalid landing {key} file format.")
            assets[key] = data
        with self.connect() as db:
            for key, data in assets.items():
                if data is None:
                    db.execute("DELETE FROM landing WHERE key=?", (key,))
                else:
                    db.execute("INSERT OR REPLACE INTO landing VALUES (?, ?)", (key, data))
            if font == "custom" and not db.execute("SELECT 1 FROM landing WHERE key='font'").fetchone():
                raise ValueError("Upload a custom font or select a built-in font.")
            db.execute("INSERT OR REPLACE INTO landing VALUES ('settings', ?)", (json.dumps({"text":welcome, "font":font}),))

    def logo(self):
        with self.connect() as db:
            row = db.execute("SELECT image FROM logo WHERE id=1").fetchone()
            return row[0] if row else None

    def save_logo(self, encoded):
        with self.connect() as db:
            if encoded is None:
                db.execute("DELETE FROM logo WHERE id=1")
                return
            data = base64.b64decode(encoded, validate=True)
            if (not 24 <= len(data) <= 300000 or data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"
                    or struct.unpack(">II", data[16:24]) != (256, 256)):
                raise ValueError("Logo must be a 256 × 256 PNG no larger than 300 KB.")
            db.execute("INSERT OR REPLACE INTO logo VALUES (1, ?)", (data,))


def link_modes(lines):
    modes = {"T":"Transceive", "R":"Monitor", "C":"Connecting"}
    return {item[1:]: modes[item[0]] for line in lines if line.startswith("LinkedNodes:")
            for item in line.partition(":")[2].replace(",", " ").split() if len(item) > 1 and item[0] in modes}


class ConsoleHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, options, **kwargs):
        self.options = options
        super().__init__(*args, **kwargs)

    def prepare_route(self):
        self.mount = ""
        if self.path.startswith("/crusader/") and self.options.https_origin:
            self.mount = "/crusader"
            self.path = self.path[len(self.mount):]
        return not self.path.startswith("/crusader/")

    def session_cookie(self, value, max_age):
        secure = "; Secure" if self.mount else ""
        return (f"crusader_session={value}; Path={self.mount}/; HttpOnly; "
                f"SameSite=Strict; Max-Age={max_age}{secure}")

    def token(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            return cookie["crusader_session"].value if "crusader_session" in cookie else ""
        except CookieError:
            return ""

    def read_json(self, limit):
        length = int(self.headers.get("Content-Length", "0"))
        if self.headers.get_content_type() != "application/json" or not 0 < length <= limit:
            raise ValueError("Invalid request body.")
        self.connection.settimeout(3)
        data = json.loads(self.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError("Invalid request body.")
        return data

    def do_GET(self):
        if not self.prepare_route():
            self.send_error(404)
            return
        url = urlsplit(self.path)
        path = url.path
        account = self.options.accounts.session(self.token())
        if path in {"/", "/index.html"} and self.options.node and "live" not in parse_qs(url.query):
            self.send_response(303)
            self.send_header("Location", self.mount + "/?live=1")
            self.end_headers()
            return
        if path == "/api/session":
            self.send_json({"account":account, "logo":bool(self.options.accounts.logo()), "landing":self.options.accounts.landing()})
            return
        landing_types = {"/api/landing/foreground":"image/png", "/api/landing/background":"image/jpeg",
                         "/api/landing/font":"application/octet-stream"}
        if path in landing_types:
            asset = self.options.accounts.landing_asset(path.rsplit("/", 1)[1])
            if asset is None:
                self.send_error(404)
                return
            self.send_asset(asset, landing_types[path])
            return
        if path == "/api/logo":
            logo = self.options.accounts.logo()
            if logo is None:
                self.send_error(404)
                return
            self.send_asset(logo, "image/png")
            return
        if path.startswith("/api/") and not account:
            self.send_json({"message":"Sign in to continue."}, 401)
            return
        if path == "/api/users":
            self.send_json({"users":self.options.accounts.users()} if account["role"] == "Administrator" else {"message":"Administrator access required."}, 200 if account["role"] == "Administrator" else 403)
            return
        if path == "/api/news":
            source = parse_qs(url.query).get("source", ["abc"])[0]
            if source not in NEWS_FEEDS:
                self.send_json({"message":"Unknown news source."}, 400)
                return
            self.send_json(self.options.news_feeds.headlines(source))
            return
        if path == "/api/asterisk-config":
            if account["role"] != "Administrator":
                self.send_json({"message":"Administrator access required."}, 403)
                return
            try:
                path = CONFIG_FILES[parse_qs(url.query).get("file", [""])[0]]
                content, _ = read_config_file(path)
                self.send_json({"text":content.decode("utf-8"), "revision":hashlib.sha256(content).hexdigest()})
            except (OSError, ValueError, KeyError):
                self.send_json({"message":"Configuration file unavailable to the Crusader service account."}, 400)
            return
        if path == "/api/local-report":
            report = parse_qs(url.query).get("report", [""])[0]
            if (report in LOCAL_REPORTS.keys() - {"cpu"} or report == "database") and account["role"] != "Administrator":
                self.send_json({"message":"Administrator access required."}, 403)
                return
            try:
                if report in LOCAL_REPORTS:
                    output = run_local_report(LOCAL_REPORTS[report])
                    if report == "cpu":
                        output += "Logical CPUs: " + str(cpu_count() or "Unknown")
                        try:
                            temperature = int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000
                            output += f"\nThermal zone 0: {temperature:.1f} °C / {temperature * 1.8 + 32:.1f} °F"
                        except (OSError, ValueError):
                            pass
                elif report == "database" or (report in REPEATER_REPORTS and self.options.node):
                    cli = "database show" if report == "database" else f"rpt {REPEATER_REPORTS[report]} {self.options.node}"
                    command = ["/usr/sbin/asterisk", "-rx", cli]
                    if report == "connections" and self.options.sudo_lstats:
                        command = ["/usr/bin/sudo", "-n", *command]
                    elif self.options.ami_user:
                        lines = ami_request(self.options.ami_user, self.options.ami_secret,
                                            {"Action":"Command", "Command":command[-1]})
                        self.send_json({"output":"\n".join(line.removeprefix("Output: ") for line in lines if line.startswith("Output: ")) or "No report returned."})
                        return
                    output = run_local_report(command)
                else:
                    self.send_json({"message":"Report unavailable."}, 404)
                    return
                self.send_json({"output":output})
            except (OSError, ValueError, subprocess.SubprocessError):
                self.send_json({"message":"Report unavailable to the Crusader service account."}, 502)
            return
        if path == "/api/node":
            result = node_status(self.options.node, self.options.sudo_lstats)
            can_control = account["role"] in {"Administrator", "Sysop"}
            result["controlPeers"] = self.options.control_peer if can_control else []
            result["freeEntry"] = can_control and self.options.control_any_peer
            if result["status"] == "online" and result["links"] and self.options.ami_user:
                try:
                    lines = ami_request(self.options.ami_user, self.options.ami_secret,
                                        {"Action":"RptStatus", "Command":"XStat", "Node":self.options.node})
                    modes = link_modes(lines)
                    for link in result["links"]:
                        link["mode"] = modes.get(link["node"])
                except (OSError, ValueError):
                    pass
        elif path == "/api/station-locations":
            query = parse_qs(url.query).get("nodes", [""])[0]
            nodes = query.split(",")
            if len(nodes) > 512 or any(not re.fullmatch(r"[0-9]{3,10}", node) for node in nodes):
                self.send_json({"message":"Invalid node list."}, 400)
                return
            result = self.options.station_directory.lookup(nodes)
        elif path == "/api/activity":
            result = dict(status="disabled")
            if self.options.ami_user:
                try:
                    active = receive_activity(self.options.node, self.options.ami_user, self.options.ami_secret)
                    result = dict(status="online", active=active, node=self.options.node)
                except (OSError, ValueError):
                    result = dict(status="unavailable")
            if self.options.ami_user:
                try:
                    result.update(radio_keying(self.options.node, self.options.ami_user, self.options.ami_secret))
                except (OSError, ValueError):
                    pass
        elif path == "/api/skywarn":
            result = skywarn_status(self.options.config, self.options.warnings, self.options.max_age)
        else:
            super().do_GET()
            return
        self.send_json(result)

    def do_POST(self):
        if not self.prepare_route():
            self.send_error(404)
            return
        options = self.options
        origin = self.headers.get("Origin")
        allowed_origins = {options.https_origin} if self.mount else {
            f"http://127.0.0.1:{options.port}", f"http://localhost:{options.port}"
        }
        if origin not in allowed_origins:
            self.send_json({"message": "Open the dashboard using its configured address."}, 403)
            return
        if self.path == "/api/login":
            try:
                request = self.read_json(2048)
                session = options.accounts.login(request.get("name"), request.get("password"))
            except (OSError, ValueError):
                session = None
            if session is None:
                self.send_json({"message":"Sign-in failed. Check your credentials and try again."}, 401)
            else:
                token, account = session
                self.send_json({"account":account}, cookie=self.session_cookie(token, SESSION_SECONDS))
            return
        account = options.accounts.session(self.token())
        if not account:
            self.send_json({"message":"Sign in to continue."}, 401)
            return
        if self.path == "/api/logout":
            options.accounts.logout(self.token())
            self.send_json({}, cookie=self.session_cookie("", 0))
            return
        if self.path in {"/api/users", "/api/logo", "/api/landing"}:
            if account["role"] != "Administrator":
                self.send_json({"message":"Administrator access required."}, 403)
                return
            try:
                request = self.read_json({"/api/logo":410000, "/api/landing":8_010_000}.get(self.path,2048))
                if self.path == "/api/logo":
                    options.accounts.save_logo(request["image"])
                elif self.path == "/api/landing":
                    options.accounts.save_landing(request)
                else:
                    if request["name"] == account["name"] and request["role"] != "Administrator":
                        raise ValueError("You cannot demote your own administrator account.")
                    options.accounts.save(request["name"], request["password"], request["role"])
                self.send_json({"message":"Saved."})
            except (OSError, KeyError, TypeError, ValueError) as error:
                self.send_json({"message":str(error) if isinstance(error, ValueError) else "Invalid request."}, 400)
            return
        if self.path == "/api/asterisk-config":
            if account["role"] != "Administrator":
                self.send_json({"message":"Administrator access required."}, 403)
                return
            try:
                payload = self.read_json(CONFIG_LIMIT * 6 + 1024)
                if not isinstance(payload["text"], str) or not isinstance(payload["revision"], str):
                    raise ValueError("Invalid configuration request.")
                with options.control_lock:
                    result = save_config_file(CONFIG_FILES[payload["file"]], payload["text"], payload["revision"])
                self.send_json(result)
            except (OSError, KeyError, TypeError):
                self.send_json({"message":"The file could not be saved with the current filesystem permissions."}, 400)
            except ValueError as error:
                self.send_json({"message":str(error)}, 400)
            return
        if self.path == "/api/station-action":
            try:
                payload = self.read_json(512)
                action = payload["action"]
                digits = payload.get("digits", "")
                if not isinstance(action, str) or action not in {*SYSTEM_ACTIONS, *STATION_COMMANDS, "reload", "dtmf"}:
                    raise ValueError
                if action == "dtmf" and (not isinstance(digits, str) or not re.fullmatch(r"[0-9*#A-D]{1,16}", digits)):
                    raise ValueError
            except (OSError, ValueError, KeyError, TypeError):
                self.send_json({"message":"Invalid station command."}, 400)
                return
            roles = {"Administrator", "Sysop"} if action in {*STATION_COMMANDS, "dtmf"} else {"Administrator"}
            if account["role"] not in roles:
                self.send_json({"message":"This action requires a higher access level."}, 403)
                return
            if not options.control_lock.acquire(blocking=False):
                self.send_json({"message":"Another station action is running."}, 409)
                return
            try:
                self.send_json({"message":station_action(options, action, digits)})
            except (OSError, subprocess.SubprocessError, ValueError):
                self.send_json({"message":"Command could not be confirmed. Check Asterisk or the service account permissions before retrying."}, 502)
            finally:
                options.control_lock.release()
            return
        if self.path != "/api/link" or not (options.control_peer or options.control_any_peer):
            self.send_json({"message": "Link controls are disabled."}, 404)
            return
        if account["role"] not in {"Administrator", "Sysop"}:
            self.send_json({"message": "Operator access required."}, 403)
            return
        try:
            request = self.read_json(512)
            peer = request["peer"]
            action = request["action"]
            if (not isinstance(peer, str) or not re.fullmatch(r"[1-9][0-9]{2,9}", peer)
                    or peer == options.node or (not options.control_any_peer and peer not in options.control_peer)
                    or not isinstance(action, str) or action not in LINK_COMMANDS):
                raise ValueError
        except (OSError, ValueError, KeyError, TypeError):
            self.send_json({"message": "Invalid link request."}, 400)
            return
        if not options.control_lock.acquire(blocking=False):
            self.send_json({"message": "Another link command is in progress."}, 409)
            return
        try:
            result = change_link(options, peer, action)
            self.send_json(result, 409 if result["status"] == "conflict" else 200)
        except (OSError, ValueError):
            self.send_json({"message": "Could not confirm the command. Check Station Links before retrying."}, 502)
        finally:
            options.control_lock.release()

    def log_request(self, code="-", size="-"):
        path = urlsplit(self.path).path
        if self.command == "GET" and path.startswith("/api/") and str(code) == "200":
            return
        super().log_request(code, size)

    def send_asset(self, payload, mime):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, result, status=200, cookie=None):
        payload = json.dumps(result).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="Path to the installed SkywarnPlus config.yaml")
    parser.add_argument("--warnings", type=Path, help="Override the SkywarnPlus alert source with a legacy warnings.txt file")
    parser.add_argument("--max-age", type=int, default=900, help="Maximum alert report age in seconds")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--node", help="Enable read-only ASL3 status for this local node number")
    parser.add_argument("--sudo-lstats", action="store_true", help="Use an existing sudo rule for the exact local status command")
    parser.add_argument("--ami-user", help="Enable per-link receive telemetry with a local AMI account")
    parser.add_argument("--control-peer", action="append", default=[], help="Allow link commands for this specific peer; repeat for more peers")
    parser.add_argument("--control-any-peer", action="store_true", help="Allow operators to enter a numeric peer directly")
    launch_mode = parser.add_mutually_exclusive_group()
    launch_mode.add_argument("--setup-service", action="store_true", help="Initialize the account and save optional AMI credentials for systemd")
    launch_mode.add_argument("--service", action="store_true", help="Start without interactive prompts")
    options = parser.parse_args()
    if options.control_peer or options.control_any_peer:
        if not options.ami_user or not options.node:
            parser.error("Link controls require --node and --ami-user")
        if any(not re.fullmatch(r"[0-9]{3,10}", peer) or peer == options.node for peer in options.control_peer):
            parser.error("--control-peer must be a numeric peer ID different from --node")
    if options.node is not None and not re.fullmatch(r"[0-9]{3,10}", options.node):
        parser.error("--node must be a numeric node ID")
    data = Path(environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "crusader-comm-link"
    credential = data / "ami-credential.json"
    if options.ami_user:
        if not options.node:
            parser.error("AMI requires --node")
        if options.service:
            try:
                with credential.open(encoding="utf-8") as stream:
                    details = fstat(stream.fileno())
                    if details.st_uid != geteuid() or details.st_mode & 0o077:
                        raise ValueError("Credential file must be private")
                    stored = json.load(stream)
                if stored["username"] != options.ami_user:
                    raise ValueError("AMI username changed")
                options.ami_secret = stored["secret"]
            except (OSError, ValueError, KeyError, TypeError):
                parser.error("Run the service setup again to configure the AMI credential.")
        else:
            options.ami_secret = getpass.getpass("Local Asterisk AMI secret: ")
        if (not isinstance(options.ami_secret, str) or not options.ami_secret
                or any(c in options.ami_user + options.ami_secret for c in "\r\n")):
            parser.error("Invalid AMI credentials")
        if options.setup_service:
            try:
                receive_activity(options.node, options.ami_user, options.ami_secret)
            except (OSError, ValueError):
                parser.error("Could not verify the AMI account and node. Check the credentials and local Asterisk before retrying.")
    origin_file = data / "https-origin"
    options.https_origin = origin_file.read_text(encoding="utf-8").strip() if origin_file.is_file() else ""
    if options.https_origin and not re.fullmatch(r"https://[a-zA-Z0-9.-]+", options.https_origin):
        parser.error("Invalid HTTPS origin in the Crusader configuration directory.")
    options.accounts = Accounts(data / "accounts.sqlite3")
    if options.node and not options.accounts.users():
        if options.service:
            parser.error("Initialize the administrator account with the service setup first.")
        print("Create your first Crusader Administrator account.")
        name = input("Administrator username: ").strip()
        password = getpass.getpass("Administrator password (12+ characters): ")
        if password != getpass.getpass("Confirm administrator password: "):
            parser.error("Passwords did not match")
        try:
            options.accounts.save(name, password, "Administrator")
        except ValueError as error:
            parser.error(str(error))
    if options.setup_service:
        if options.ami_user:
            with NamedTemporaryFile(mode="w", encoding="utf-8", dir=data, delete=False) as stream:
                json.dump({"username":options.ami_user, "secret":options.ami_secret}, stream)
            pending = Path(stream.name)
            try:
                replace(pending, credential)
            finally:
                pending.unlink(missing_ok=True)
        else:
            credential.unlink(missing_ok=True)
        return
    options.station_directory = StationDirectory()
    options.news_feeds = NewsFeeds()
    options.control_lock = Lock()
    handler = partial(ConsoleHandler, options=options, directory=Path(__file__).resolve().parent / "dist")
    try:
        server = ThreadingHTTPServer(("127.0.0.1", options.port), handler)
    except OSError as error:
        if error.errno == errno.EADDRINUSE:
            parser.exit(1, f"Port {options.port} is already in use. Stop the earlier Crusader server before restarting.\n")
        raise
    with server:
        print(f"Crusader Comm/Link is listening on 127.0.0.1:{options.port}. Press Ctrl+C to stop.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("Crusader Comm/Link stopped.", flush=True)


if __name__ == "__main__":
    main()
