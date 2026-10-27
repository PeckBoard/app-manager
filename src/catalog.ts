// Declarative app catalog. Every entry is plain data — adding an app is a
// pure data change, no code change. Every command here is a *static* shell
// script authored by us; nothing here is ever built from user input (see
// tools.ts, which validates any user-supplied app/target id against this
// table before touching a shell at all).
//
// `install`/`remove` carry one recipe per package manager plus an optional
// `vendor` fallback (an upstream curl|sh-style installer) for apps that
// aren't in distro repos. Every recipe that needs root prefixes with
// `sudo -A` — see src/service/askpass.rs in the core repo for the askpass
// bridge convention; a plugin-run `sudo -A` has no askpass wired today, so
// it fails cleanly with sudo's own stderr rather than hanging, and that
// message ends up in the job log tail (see jobs.ts / tools.ts appStatus).

import { PackageManager } from "./distro";
import { shQuote } from "./jobs";

export interface CatalogApp {
  id: string;
  name: string;
  description: string;
  /** "pip" marks a Python package installed via pip into the user site —
   * pip's own namespace, disjoint from the distro package database. Absent
   * means a normal system app (distro package manager / vendor script). */
  namespace?: "pip";
  /** Shell script; exit 0 means the app is installed. */
  detect: string;
  /** Shell script; best-effort, prints a version string on success. */
  version: string;
  install: Partial<Record<PackageManager, string>> & {
    vendor?: string;
    /** pip-namespace apps: the one pip recipe, used on every distro. */
    pip?: string;
  };
  remove: Partial<Record<PackageManager, string>> & {
    vendor?: string;
    pip?: string;
  };
  /** The distro package names each PM recipe installs (space-separated,
   * mirroring the recipe's arguments) — lets provenance attribute the app's
   * own package in a snapshot delta (see provenance.ts). Vendor-only apps
   * have none: their binaries never enter the package database. */
  packages?: Partial<Record<PackageManager, string>>;
  /** pip-namespace apps: the PyPI distribution name, probed through pip
   * itself (`pip list --format=freeze` / `pip show`) — never through the
   * distro package database. */
  pip_package?: string;
  /** True for a MANUALLY ADDED app (see customApps.ts): not in this table,
   * projected into this shape from a user-created record. Its recipes, when
   * present, are commands the person typed rather than authored recipes, and
   * the local install is worked out by the AI session instead. */
  custom?: true;
  /** Manual apps: the executable the detect/version probes look for. */
  binary?: string;
  /** Manual apps: the official project URL the person supplied, if any — a
   * claim the install session verifies, never a source of truth. */
  homepage?: string;
}

function aptInstall(pkg: string): string {
  return `sudo -A apt-get update && sudo -A apt-get install -y ${pkg}`;
}
function aptRemove(pkg: string): string {
  return `sudo -A apt-get remove -y ${pkg}`;
}
function dnfInstall(pkg: string): string {
  return `sudo -A dnf install -y ${pkg}`;
}
function dnfRemove(pkg: string): string {
  return `sudo -A dnf remove -y ${pkg}`;
}
function pacmanInstall(pkg: string): string {
  return `sudo -A pacman -Sy --noconfirm ${pkg}`;
}
function pacmanRemove(pkg: string): string {
  return `sudo -A pacman -R --noconfirm ${pkg}`;
}
function zypperInstall(pkg: string): string {
  return `sudo -A zypper --non-interactive install ${pkg}`;
}
function zypperRemove(pkg: string): string {
  return `sudo -A zypper --non-interactive remove ${pkg}`;
}

/** pip recipes target the user site (`--user`): nothing outside $HOME is
 * touched and no root is needed. PIP_BREAK_SYSTEM_PACKAGES=1 lifts PEP 668's
 * externally-managed refusal on modern Debian/Ubuntu/Fedora; pips old enough
 * not to know it ignore the env var (the equivalent flag would be a hard
 * error there). */
function pipInstall(pkg: string): string {
  return `PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install --user ${pkg}`;
}
function pipRemove(pkg: string): string {
  return `PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip uninstall -y ${pkg}`;
}

/** Version probe for a pip-namespace app: its `pip list --format=freeze`
 * line (`name==version`) — pip's own answer about pip's own namespace. awk
 * does the filtering because `pip show`'s first line is the package name,
 * not the version, and the probe's caller keeps only line one. */
function pipFreezeVersion(pkg: string): string {
  return (
    "python3 -m pip list --format=freeze --disable-pip-version-check 2>/dev/null" +
    ` | awk -F'==' -v p=${shQuote(pkg)} '$1 == p'`
  );
}

/** Host libraries OrcaSlicer's AppImage links against but doesn't bundle,
 * which minimal / server hosts often lack (Ubuntu 26.04 has no libGLU by
 * default) → `deb|rpm` candidate packages (first that downloads wins).
 * Unmapped libs fall back to the Debian guess `libfoo.so.N` → `libfooN`. */
const ORCA_LIB_PACKAGES: Record<string, [string, string]> = {
  "libGLU.so.1": ["libglu1-mesa", "mesa-libGLU"],
  "libGL.so.1": ["libgl1", "libglvnd-glx"],
  "libOpenGL.so.0": ["libopengl0", "libglvnd-opengl"],
  "libEGL.so.1": ["libegl1", "libglvnd-egl"],
  "libGLX.so.0": ["libglx0", "libglvnd-glx"],
  "libgtk-3.so.0": ["libgtk-3-0t64 libgtk-3-0", "gtk3"],
  "libwebkit2gtk-4.1.so.0": ["libwebkit2gtk-4.1-0", "webkit2gtk4.1"],
  "libgstreamer-1.0.so.0": ["libgstreamer1.0-0", "gstreamer1"],
  "libSM.so.6": ["libsm6", "libSM"],
  "libXxf86vm.so.1": ["libxxf86vm1", "libXxf86vm"],
};

/** After extracting: `ldd` the binary (with the dirs its launcher adds) and
 * fetch every "not found" library WITHOUT root — `apt-get download` +
 * `dpkg-deb -x`, or `dnf download` + `rpm2cpio | cpio` — into
 * ~/.local/share/orca-slicer/extra-lib, which the wrapper puts on
 * LD_LIBRARY_PATH (the binary's RUNPATH is a CI build dir). Fails, naming
 * them, when some stay missing. Mirrors print-farm's setup.ts fix_libs. */
const ORCA_FIX_LIBS = [
  "set +e",
  "pkgs_for() {",
  '  case "$1:$2" in',
  ...Object.entries(ORCA_LIB_PACKAGES).flatMap(([lib, [deb, rpm]]) => [
    `    ${lib}:deb) echo ${deb} ;;`,
    `    ${lib}:rpm) echo ${rpm} ;;`,
  ]),
  '    *:deb) b=${1%%.so*}; v=${1##*.so.}; [ "$v" = "$1" ] && v=""; g=$(printf %s "$b$v" | tr A-Z_ a-z-); echo "$g" "${g}t64" ;;',
  "    *) echo ;;",
  "  esac",
  "}",
  'O="$HOME/.local/share/orca-slicer"; X="$O/extra-lib"',
  'missing() { LD_LIBRARY_PATH="$X:$O/lib/orca-runtime:$O/lib:$O/bin" ldd "$O/bin/orca-slicer" 2>/dev/null | awk \'/not found/{print $1}\' | sort -u; }',
  'm=""; [ -x "$O/bin/orca-slicer" ] && command -v ldd >/dev/null 2>&1 && m=$(missing)',
  'if [ -n "$m" ]; then',
  '  echo "OrcaSlicer can\'t load: $(echo $m) — fetching without root"',
  "  if command -v apt-get >/dev/null 2>&1 && command -v dpkg-deb >/dev/null 2>&1; then pm=deb",
  "  elif command -v dnf >/dev/null 2>&1 && command -v rpm2cpio >/dev/null 2>&1 && command -v cpio >/dev/null 2>&1; then pm=rpm",
  '  else echo "OrcaSlicer needs $(echo $m); install it with your package manager" >&2; exit 1; fi',
  '  mkdir -p "$X"; t="$(mktemp -d)"',
  "  for lib in $m; do",
  '    for p in $(pkgs_for "$lib" "$pm"); do',
  '      rm -rf "$t/pkg" "$t/x"; mkdir -p "$t/pkg" "$t/x"',
  '      if [ "$pm" = deb ]; then (cd "$t/pkg" && apt-get download "$p" >/dev/null 2>&1) || continue; for f in "$t"/pkg/*.deb; do dpkg-deb -x "$f" "$t/x"; done',
  '      else (cd "$t/pkg" && dnf download -q "$p" >/dev/null 2>&1) || continue; for f in "$t"/pkg/*.rpm; do (cd "$t/x" && rpm2cpio "$f" | cpio -idm --quiet); done; fi',
  '      n=0; for f in $(find "$t/x" \\( -type f -o -type l \\) -name "$lib*"); do cp -P "$f" "$X/" && n=$((n + 1)); done',
  '      [ "$n" -gt 0 ] && { echo "fetched $lib from $p"; break; }',
  "    done",
  "  done",
  '  rm -rf "$t"; left=$(missing)',
  '  [ -z "$left" ] || { echo "OrcaSlicer still can\'t load $(echo $left) — install the package(s) providing them" >&2; exit 1; }',
  "fi",
].join("\n");

/** OrcaSlicer's vendor install: resolve the latest GitHub release tag via the
 * /releases/latest redirect, download that release's Ubuntu 24.04 AppImage
 * for this arch, and EXTRACT it (`--appimage-extract` needs no FUSE, which
 * headless hosts usually lack) into ~/.local/share/orca-slicer, with a tiny
 * ~/.local/bin/orca-slicer wrapper exec'ing its AppRun (with extra-lib on
 * LD_LIBRARY_PATH), then fetch any host libraries it can't load
 * (ORCA_FIX_LIBS). User-local only, no root. Preferred over Flathub because
 * it needs neither flatpak nor a configured remote on the target. */
const ORCA_SLICER_INSTALL =
  "set -e; " +
  'case "$(uname -m)" in x86_64) arch="" ;; aarch64|arm64) arch="_aarch64" ;; ' +
  '*) echo "OrcaSlicer: unsupported architecture $(uname -m)" >&2; exit 1 ;; esac; ' +
  "tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/SoftFever/OrcaSlicer/releases/latest); " +
  'tag="${tag##*/}"; ver="${tag#v}"; ' +
  'tmp="$(mktemp -d)"; ' +
  'curl -fL -o "$tmp/orca.AppImage" ' +
  '"https://github.com/SoftFever/OrcaSlicer/releases/download/$tag/OrcaSlicer_Linux_AppImage_Ubuntu2404${arch}_V$ver.AppImage"; ' +
  'chmod +x "$tmp/orca.AppImage"; ' +
  '(cd "$tmp" && ./orca.AppImage --appimage-extract >/dev/null); ' +
  'mkdir -p "$HOME/.local/share" "$HOME/.local/bin"; ' +
  'if [ -d "$HOME/.local/share/orca-slicer/extra-lib" ]; then mv "$HOME/.local/share/orca-slicer/extra-lib" "$tmp/extra-lib"; fi; ' +
  'rm -rf "$HOME/.local/share/orca-slicer"; ' +
  'mv "$tmp/squashfs-root" "$HOME/.local/share/orca-slicer"; ' +
  'if [ -d "$tmp/extra-lib" ]; then mv "$tmp/extra-lib" "$HOME/.local/share/orca-slicer/extra-lib"; fi; ' +
  'echo "$ver" > "$HOME/.local/share/orca-slicer/VERSION"; ' +
  'printf \'#!/bin/sh\\nexport LD_LIBRARY_PATH="$HOME/.local/share/orca-slicer/extra-lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\\nexec "$HOME/.local/share/orca-slicer/AppRun" "$@"\\n\' > "$HOME/.local/bin/orca-slicer"; ' +
  'chmod +x "$HOME/.local/bin/orca-slicer"; ' +
  'rm -rf "$tmp"\n' +
  ORCA_FIX_LIBS;
/** `systemctl --user` needs the user's runtime dir; a job spawned outside a
 * login session may not have XDG_RUNTIME_DIR set, so point it at the
 * standard /run/user/<uid> when that exists. */
const SYSTEMD_USER_ENV =
  'if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then ' +
  'export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi; ';

/** The print-bridge systemd user unit (mirrors print-bridge.service in the
 * print-bridge repo). Written with `printf '%s\n'` so systemd's `%h`
 * specifiers never reach printf's format string. */
const PRINT_BRIDGE_UNIT_LINES = [
  "[Unit]",
  "Description=print-bridge: local HTTP bridge for Bambu Lab printers",
  "Wants=network-online.target",
  "After=network-online.target",
  "",
  "[Service]",
  "ExecStart=%h/.local/bin/print-bridge --bind 127.0.0.1:7781 --token-file %h/.config/print-bridge/token",
  "Environment=RUST_LOG=print_bridge=info",
  "Restart=on-failure",
  "RestartSec=5",
  "NoNewPrivileges=yes",
  "PrivateTmp=yes",
  "",
  "[Install]",
  "WantedBy=default.target",
];

/** print-bridge's vendor install (github.com/PeckBoard/print-bridge, the
 * Bambu Lab LAN bridge print-farm talks to). User-local, no root: the
 * latest release's static musl binary for this arch (sha256-checked against
 * its published .sha256) into ~/.local/bin, a random bearer token in
 * ~/.config/print-bridge/token (mode 600, created only when absent so a
 * reinstall never rotates a token print-farm already holds), and a systemd
 * USER unit listening on 127.0.0.1:7781. Refuses up front — before touching
 * anything — when no systemd user manager is reachable. Linger is
 * best-effort: without it the service stops when the user logs out. */
const PRINT_BRIDGE_INSTALL =
  "set -e; " +
  SYSTEMD_USER_ENV +
  "if ! systemctl --user show-environment >/dev/null 2>&1; then " +
  'echo "print-bridge: no systemd user manager reachable (systemctl --user failed); nothing was installed. ' +
  "Run it manually instead: download the binary from https://github.com/PeckBoard/print-bridge/releases and start " +
  'print-bridge --bind 127.0.0.1:7781 --token-file ~/.config/print-bridge/token" >&2; exit 1; fi; ' +
  'case "$(uname -m)" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; ' +
  '*) echo "print-bridge: unsupported architecture $(uname -m)" >&2; exit 1 ;; esac; ' +
  'asset="print-bridge-linux-$arch"; ' +
  'tmp="$(mktemp -d)"; ' +
  'curl -fsSL -o "$tmp/$asset" "https://github.com/PeckBoard/print-bridge/releases/latest/download/$asset"; ' +
  'curl -fsSL -o "$tmp/$asset.sha256" "https://github.com/PeckBoard/print-bridge/releases/latest/download/$asset.sha256"; ' +
  'want="$(cut -d" " -f1 "$tmp/$asset.sha256")"; got="$(sha256sum "$tmp/$asset" | cut -d" " -f1)"; ' +
  'if [ "$want" != "$got" ]; then echo "print-bridge: sha256 mismatch for $asset" >&2; rm -rf "$tmp"; exit 1; fi; ' +
  'mkdir -p "$HOME/.local/bin" "$HOME/.config/print-bridge" "$HOME/.config/systemd/user"; ' +
  'install -m 755 "$tmp/$asset" "$HOME/.local/bin/print-bridge"; ' +
  'rm -rf "$tmp"; ' +
  'if [ ! -e "$HOME/.config/print-bridge/token" ]; then ' +
  "(umask 077; od -An -N32 -tx1 /dev/urandom | tr -d ' \\n' > \"$HOME/.config/print-bridge/token\"); " +
  'chmod 600 "$HOME/.config/print-bridge/token"; fi; ' +
  "printf '%s\\n' " +
  PRINT_BRIDGE_UNIT_LINES.map((l) => shQuote(l)).join(" ") +
  ' > "$HOME/.config/systemd/user/print-bridge.service"; ' +
  "systemctl --user daemon-reload; " +
  "systemctl --user enable print-bridge; " +
  // restart, not start: a reinstall must pick up the replaced binary.
  "systemctl --user restart print-bridge; " +
  'loginctl enable-linger "${USER:-$(id -un)}" 2>/dev/null || ' +
  'echo "print-bridge: warning: loginctl enable-linger failed; the service will stop when you log out" >&2; ' +
  '"$HOME/.local/bin/print-bridge" --version; ' +
  'echo "print-bridge listening on 127.0.0.1:7781; token in ~/.config/print-bridge/token"';

/** Stops + disables the unit, deletes it and the binary. The token and the
 * data dir (~/.local/share/print-bridge, printers.json) are kept on purpose
 * so a reinstall reconnects print-farm with no re-pairing. */
const PRINT_BRIDGE_REMOVE =
  SYSTEMD_USER_ENV +
  "systemctl --user disable --now print-bridge 2>/dev/null || true; " +
  'rm -f "$HOME/.config/systemd/user/print-bridge.service"; ' +
  "systemctl --user daemon-reload 2>/dev/null || true; " +
  'rm -f "$HOME/.local/bin/print-bridge"; ' +
  'echo "print-bridge removed; kept ~/.config/print-bridge/token and ~/.local/share/print-bridge (delete them by hand to wipe)"';

/** The homekit-bridge systemd user unit (mirrors homekit-bridge.service in
 * the homekit-bridge repo). Runs the wrapper, which pins the node binary. */
const HOMEKIT_BRIDGE_UNIT_LINES = [
  "[Unit]",
  "Description=homekit-bridge: local HTTP bridge that controls HomeKit IP accessories",
  "Wants=network-online.target",
  "After=network-online.target",
  "",
  "[Service]",
  "ExecStart=%h/.local/bin/homekit-bridge --bind 127.0.0.1:7782 --token-file %h/.config/homekit-bridge/token",
  "Restart=on-failure",
  "RestartSec=5",
  "NoNewPrivileges=yes",
  "PrivateTmp=yes",
  "",
  "[Install]",
  "WantedBy=default.target",
];

/** homekit-bridge's vendor install (github.com/PeckBoard/homekit-bridge, the
 * HomeKit IP controller the homekit plugin talks to). User-local, no root.
 * The release is one Node bundle (sha256-checked) in ~/.local/lib/homekit-bridge.
 * Node >= 20 is required and distro packages often lag (Ubuntu 24.04 ships
 * 18), so a too-old or missing system node gets a private official Node 22
 * build (sha256-checked against SHASUMS256.txt) next to the bundle. The
 * ~/.local/bin/homekit-bridge wrapper hard-codes the node it resolved, so
 * the systemd unit works even when node lives on an nvm-only PATH. Token in
 * ~/.config/homekit-bridge/token (mode 600, created only when absent). Refuses
 * up front — before touching anything — without a systemd user manager. */
const HOMEKIT_BRIDGE_INSTALL =
  "set -e; " +
  SYSTEMD_USER_ENV +
  "if ! systemctl --user show-environment >/dev/null 2>&1; then " +
  'echo "homekit-bridge: no systemd user manager reachable (systemctl --user failed); nothing was installed. ' +
  "Run it manually instead: download homekit-bridge.mjs from https://github.com/PeckBoard/homekit-bridge/releases and start " +
  'node homekit-bridge.mjs --bind 127.0.0.1:7782 --token-file ~/.config/homekit-bridge/token" >&2; exit 1; fi; ' +
  'lib="$HOME/.local/lib/homekit-bridge"; tmp="$(mktemp -d)"; ' +
  'node_bin=""; if command -v node >/dev/null 2>&1 && ' +
  "node -e 'process.exit(+process.versions.node.split(\".\")[0] >= 20 ? 0 : 1)'; then " +
  'node_bin="$(command -v node)"; ' +
  'else case "$(uname -m)" in x86_64|amd64) narch=x64 ;; aarch64|arm64) narch=arm64 ;; ' +
  '*) echo "homekit-bridge: unsupported architecture $(uname -m)" >&2; exit 1 ;; esac; ' +
  'base="https://nodejs.org/dist/latest-v22.x"; ' +
  'curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"; ' +
  'line="$(awk -v a="linux-$narch.tar.gz" \'index($2, a) && $2 ~ /^node-v22/ {print; exit}\' "$tmp/SHASUMS256.txt")"; ' +
  'want="${line%% *}"; tarball="${line##* }"; ' +
  'if [ -z "$tarball" ]; then echo "homekit-bridge: no Node 22 build for linux-$narch" >&2; rm -rf "$tmp"; exit 1; fi; ' +
  'echo "homekit-bridge: system Node.js is missing or older than 20; fetching private $tarball"; ' +
  'curl -fsSL -o "$tmp/$tarball" "$base/$tarball"; ' +
  'got="$(sha256sum "$tmp/$tarball" | cut -d" " -f1)"; ' +
  'if [ "$want" != "$got" ]; then echo "homekit-bridge: sha256 mismatch for $tarball" >&2; rm -rf "$tmp"; exit 1; fi; ' +
  'rm -rf "$lib/node"; mkdir -p "$lib/node"; ' +
  'tar -xzf "$tmp/$tarball" -C "$lib/node" --strip-components=1; ' +
  'node_bin="$lib/node/bin/node"; fi; ' +
  'asset="homekit-bridge.mjs"; ' +
  'curl -fsSL -o "$tmp/$asset" "https://github.com/PeckBoard/homekit-bridge/releases/latest/download/$asset"; ' +
  'curl -fsSL -o "$tmp/$asset.sha256" "https://github.com/PeckBoard/homekit-bridge/releases/latest/download/$asset.sha256"; ' +
  'want="$(cut -d" " -f1 "$tmp/$asset.sha256")"; got="$(sha256sum "$tmp/$asset" | cut -d" " -f1)"; ' +
  'if [ "$want" != "$got" ]; then echo "homekit-bridge: sha256 mismatch for $asset" >&2; rm -rf "$tmp"; exit 1; fi; ' +
  'mkdir -p "$lib" "$HOME/.local/bin" "$HOME/.config/homekit-bridge" "$HOME/.config/systemd/user"; ' +
  'install -m 644 "$tmp/$asset" "$lib/$asset"; ' +
  'rm -rf "$tmp"; ' +
  "printf '#!/bin/sh\\nexec \"%s\" \"%s\" \"$@\"\\n' \"$node_bin\" \"$lib/$asset\" > \"$HOME/.local/bin/homekit-bridge\"; " +
  'chmod 755 "$HOME/.local/bin/homekit-bridge"; ' +
  'if [ ! -e "$HOME/.config/homekit-bridge/token" ]; then ' +
  "(umask 077; od -An -N32 -tx1 /dev/urandom | tr -d ' \\n' > \"$HOME/.config/homekit-bridge/token\"); " +
  'chmod 600 "$HOME/.config/homekit-bridge/token"; fi; ' +
  "printf '%s\\n' " +
  HOMEKIT_BRIDGE_UNIT_LINES.map((l) => shQuote(l)).join(" ") +
  ' > "$HOME/.config/systemd/user/homekit-bridge.service"; ' +
  "systemctl --user daemon-reload; " +
  "systemctl --user enable homekit-bridge; " +
  // restart, not start: a reinstall must pick up the replaced bundle.
  "systemctl --user restart homekit-bridge; " +
  'loginctl enable-linger "${USER:-$(id -un)}" 2>/dev/null || ' +
  'echo "homekit-bridge: warning: loginctl enable-linger failed; the service will stop when you log out" >&2; ' +
  '"$HOME/.local/bin/homekit-bridge" --version; ' +
  'echo "homekit-bridge listening on 127.0.0.1:7782; token in ~/.config/homekit-bridge/token"';

/** Stops + disables the unit, deletes it, the wrapper, the bundle and any
 * private node. The token and the data dir (~/.local/share/homekit-bridge,
 * pairings.json — the accessory keys) are kept on purpose: losing
 * pairings.json means factory-resetting every paired accessory. */
const HOMEKIT_BRIDGE_REMOVE =
  SYSTEMD_USER_ENV +
  "systemctl --user disable --now homekit-bridge 2>/dev/null || true; " +
  'rm -f "$HOME/.config/systemd/user/homekit-bridge.service"; ' +
  "systemctl --user daemon-reload 2>/dev/null || true; " +
  'rm -f "$HOME/.local/bin/homekit-bridge"; rm -rf "$HOME/.local/lib/homekit-bridge"; ' +
  'echo "homekit-bridge removed; kept ~/.config/homekit-bridge/token and ~/.local/share/homekit-bridge (pairings — delete by hand to wipe)"';

/** mcpx's vendor install (github.com/PeckBoard/mcpx, the MCP client CLI +
 * local gateway). User-local, no root: the latest release's binary for this
 * OS + arch (static musl `mcpx-linux-<arch>` on Linux, `mcpx-macos-<arch>`
 * on macOS), sha256-checked against its published .sha256 (`shasum -a 256`
 * where macOS lacks sha256sum), into ~/.local/bin/mcpx. No service — `mcpx
 * serve` is started by whoever wants the gateway. Config and tokens
 * (~/.config/mcpx) are never touched. */
const MCPX_INSTALL =
  "set -e; " +
  'case "$(uname -s)" in Linux) os=linux ;; Darwin) os=macos ;; ' +
  '*) echo "mcpx: unsupported OS $(uname -s)" >&2; exit 1 ;; esac; ' +
  'case "$(uname -m)" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; ' +
  '*) echo "mcpx: unsupported architecture $(uname -m)" >&2; exit 1 ;; esac; ' +
  'asset="mcpx-$os-$arch"; ' +
  'tmp="$(mktemp -d)"; ' +
  'curl -fsSL -o "$tmp/$asset" "https://github.com/PeckBoard/mcpx/releases/latest/download/$asset"; ' +
  'curl -fsSL -o "$tmp/$asset.sha256" "https://github.com/PeckBoard/mcpx/releases/latest/download/$asset.sha256"; ' +
  'want="$(cut -d" " -f1 "$tmp/$asset.sha256")"; ' +
  'if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$asset" | cut -d" " -f1)"; ' +
  'else got="$(shasum -a 256 "$tmp/$asset" | cut -d" " -f1)"; fi; ' +
  'if [ "$want" != "$got" ]; then echo "mcpx: sha256 mismatch for $asset" >&2; rm -rf "$tmp"; exit 1; fi; ' +
  'mkdir -p "$HOME/.local/bin"; ' +
  'install -m 755 "$tmp/$asset" "$HOME/.local/bin/mcpx"; ' +
  'rm -rf "$tmp"; ' +
  '"$HOME/.local/bin/mcpx" --version';
  'mkdir -p "$HOME/.local/bin"; ' +
  'install -m 755 "$tmp/$asset" "$HOME/.local/bin/mcpx"; ' +
  'rm -rf "$tmp"; ' +
  '"$HOME/.local/bin/mcpx" --version';
export const APPS: CatalogApp[] = [
  {
    id: "git",
    name: "Git",
    description: "Distributed version control system.",
    detect: "command -v git",
    version: "git --version",
    packages: { apt: "git", dnf: "git", pacman: "git", zypper: "git" },
    install: {
      apt: aptInstall("git"),
      dnf: dnfInstall("git"),
      pacman: pacmanInstall("git"),
      zypper: zypperInstall("git"),
    },
    remove: {
      apt: aptRemove("git"),
      dnf: dnfRemove("git"),
      pacman: pacmanRemove("git"),
      zypper: zypperRemove("git"),
    },
  },
  {
    id: "claude",
    name: "Claude Code",
    description:
      "Anthropic's Claude Code CLI. Not packaged by any distro — installed via npm, so Node.js must already be present on the target.",
    detect: "command -v claude",
    version: "claude --version",
    install: { vendor: "npm install -g @anthropic-ai/claude-code" },
    remove: { vendor: "npm uninstall -g @anthropic-ai/claude-code" },
  },
  {
    id: "cursor-agent",
    name: "Cursor Agent",
    description:
      "Cursor's CLI coding agent. Installed via Cursor's official installer script.",
    detect: "command -v cursor-agent",
    version: "cursor-agent --version",
    install: { vendor: "curl https://cursor.com/install -fsS | bash" },
    remove: {
      vendor:
        'rm -f "$HOME/.local/bin/cursor-agent" && rm -rf "$HOME/.local/share/cursor-agent"',
    },
  },
  {
    id: "ollama",
    name: "Ollama",
    description:
      "Local LLM runner. Installed via Ollama's official installer script.",
    detect: "command -v ollama",
    version: "ollama --version",
    install: { vendor: "curl -fsSL https://ollama.com/install.sh | sh" },
    remove: {
      vendor:
        "sudo -A systemctl stop ollama; sudo -A systemctl disable ollama; " +
        "sudo -A rm -f /usr/local/bin/ollama /usr/bin/ollama; " +
        "sudo -A rm -rf /usr/share/ollama /etc/systemd/system/ollama.service; " +
        "sudo -A userdel ollama; true",
    },
  },
  {
    id: "node",
    name: "Node.js",
    description:
      "JavaScript runtime (distro-packaged version, may lag upstream releases).",
    detect: "command -v node",
    version: "node --version",
    packages: {
      apt: "nodejs npm",
      dnf: "nodejs",
      pacman: "nodejs npm",
      zypper: "nodejs npm",
    },
    install: {
      apt: aptInstall("nodejs npm"),
      dnf: dnfInstall("nodejs"),
      pacman: pacmanInstall("nodejs npm"),
      zypper: zypperInstall("nodejs npm"),
    },
    remove: {
      apt: aptRemove("nodejs npm"),
      dnf: dnfRemove("nodejs"),
      pacman: pacmanRemove("nodejs npm"),
      zypper: zypperRemove("nodejs npm"),
    },
  },
  {
    id: "docker",
    name: "Docker",
    description:
      "Container runtime (distro-packaged Docker Engine, not the upstream Docker CE repo).",
    detect: "command -v docker",
    version: "docker --version",
    packages: {
      apt: "docker.io",
      dnf: "docker",
      pacman: "docker",
      zypper: "docker",
    },
    install: {
      apt: aptInstall("docker.io"),
      dnf: dnfInstall("docker"),
      pacman: pacmanInstall("docker"),
      zypper: zypperInstall("docker"),
    },
    remove: {
      apt: aptRemove("docker.io"),
      dnf: dnfRemove("docker"),
      pacman: pacmanRemove("docker"),
      zypper: zypperRemove("docker"),
    },
  },
  {
    id: "ripgrep",
    name: "ripgrep",
    description: "Fast recursive grep replacement (binary name: rg).",
    detect: "command -v rg",
    version: "rg --version",
    packages: {
      apt: "ripgrep",
      dnf: "ripgrep",
      pacman: "ripgrep",
      zypper: "ripgrep",
    },
    install: {
      apt: aptInstall("ripgrep"),
      dnf: dnfInstall("ripgrep"),
      pacman: pacmanInstall("ripgrep"),
      zypper: zypperInstall("ripgrep"),
    },
    remove: {
      apt: aptRemove("ripgrep"),
      dnf: dnfRemove("ripgrep"),
      pacman: pacmanRemove("ripgrep"),
      zypper: zypperRemove("ripgrep"),
    },
  },
  {
    id: "python3",
    name: "Python 3",
    description:
      "The Python 3 interpreter (distro package). Prerequisite for pip and " +
      "for any pip-installed Python package, e.g. graphifyy.",
    detect: "command -v python3",
    version: "python3 --version",
    packages: {
      apt: "python3",
      dnf: "python3",
      pacman: "python",
      zypper: "python3",
    },
    install: {
      apt: aptInstall("python3"),
      dnf: dnfInstall("python3"),
      pacman: pacmanInstall("python"),
      zypper: zypperInstall("python3"),
    },
    // Deliberately no remove recipes: distro tooling (often the OS itself)
    // depends on the system Python, and removing it can dismantle the
    // machine. The row's Remove action stays blocked.
    remove: {},
  },
  {
    id: "pip",
    name: "pip",
    description:
      "Python's package installer, run as `python3 -m pip` (distro package). " +
      "Needed to install Python packages such as graphifyy; requires Python 3.",
    detect: "python3 -m pip --version",
    version: "python3 -m pip --version",
    packages: {
      apt: "python3-pip",
      dnf: "python3-pip",
      pacman: "python-pip",
      zypper: "python3-pip",
    },
    install: {
      apt: aptInstall("python3-pip"),
      dnf: dnfInstall("python3-pip"),
      pacman: pacmanInstall("python-pip"),
      zypper: zypperInstall("python3-pip"),
    },
    remove: {
      apt: aptRemove("python3-pip"),
      dnf: dnfRemove("python3-pip"),
      pacman: pacmanRemove("python-pip"),
      zypper: zypperRemove("python3-pip"),
    },
  },
  {
    id: "graphifyy",
    name: "graphifyy",
    namespace: "pip",
    description:
      "Knowledge-graph builder driven by the Peckboard graphify plugin (PyPI " +
      "distribution `graphifyy`, import name `graphify`). A Python package, not " +
      "a system package: pip installs it into the user site, it lives in pip's " +
      "namespace, and it never appears in the distro package database. Requires " +
      "Python 3 and pip. The graphify plugin's own optional self-install uses a " +
      "private venv (.graphify-venv) instead, which this plugin neither sees nor " +
      "manages.",
    detect: "python3 -m pip show graphifyy",
    version: pipFreezeVersion("graphifyy"),
    install: { pip: pipInstall("graphifyy") },
    remove: { pip: pipRemove("graphifyy") },
    pip_package: "graphifyy",
  },
  {
    id: "xvfb",
    name: "Xvfb",
    description:
      "Virtual X server with the `xvfb-run` wrapper — lets GUI-toolkit programs " +
      "(e.g. OrcaSlicer's CLI slicer) run on a headless host.",
    detect: "command -v xvfb-run",
    // xvfb-run has no --version; the server it wraps does (on stderr).
    version: "Xvfb -version 2>&1",
    packages: {
      apt: "xvfb",
      dnf: "xorg-x11-server-Xvfb",
      pacman: "xorg-server-xvfb",
      zypper: "xorg-x11-server-Xvfb xvfb-run",
    },
    install: {
      apt: aptInstall("xvfb"),
      dnf: dnfInstall("xorg-x11-server-Xvfb"),
      pacman: pacmanInstall("xorg-server-xvfb"),
      zypper: zypperInstall("xorg-x11-server-Xvfb xvfb-run"),
    },
    remove: {
      apt: aptRemove("xvfb"),
      dnf: dnfRemove("xorg-x11-server-Xvfb"),
      pacman: pacmanRemove("xorg-server-xvfb"),
      zypper: zypperRemove("xorg-x11-server-Xvfb xvfb-run"),
    },
  },
  {
    id: "orca-slicer",
    name: "OrcaSlicer",
    description:
      "3D-printer slicer (github.com/SoftFever/OrcaSlicer). Not packaged by " +
      "distros: the latest official AppImage is extracted into " +
      "~/.local/share/orca-slicer (no FUSE or root needed) behind an " +
      "~/.local/bin/orca-slicer wrapper. The AppImage targets Ubuntu 24.04 " +
      "(glibc 2.39+); headless CLI slicing needs Xvfb (`xvfb-run`). An " +
      "existing Flathub install (com.orcaslicer.OrcaSlicer) also counts.",
    detect:
      'command -v orca-slicer || test -x "$HOME/.local/bin/orca-slicer" || ' +
      "flatpak info com.orcaslicer.OrcaSlicer >/dev/null 2>&1 || " +
      "flatpak info io.github.softfever.OrcaSlicer >/dev/null 2>&1",
    version:
      'cat "$HOME/.local/share/orca-slicer/VERSION" 2>/dev/null || ' +
      "flatpak info com.orcaslicer.OrcaSlicer 2>/dev/null | awk '$1 == \"Version:\" {print $2}'",
    install: { vendor: ORCA_SLICER_INSTALL },
    remove: {
      vendor:
        'rm -f "$HOME/.local/bin/orca-slicer" && rm -rf "$HOME/.local/share/orca-slicer"',
    },
  },
  {
    id: "print-bridge",
    name: "print-bridge",
    description:
      "Local HTTP bridge for Bambu Lab printers in LAN mode " +
      "(github.com/PeckBoard/print-bridge) — the daemon the print-farm plugin " +
      "talks to. User-local, no root: the latest static release binary goes " +
      "to ~/.local/bin/print-bridge, a random bearer token to " +
      "~/.config/print-bridge/token (kept across reinstalls and removal), and " +
      "a systemd user unit serves 127.0.0.1:7781. Needs systemd --user; " +
      "enables linger when allowed so it keeps running after logout.",
    detect:
      'test -x "$HOME/.local/bin/print-bridge" || command -v print-bridge',
    version:
      '"$HOME/.local/bin/print-bridge" --version 2>/dev/null || print-bridge --version',
    install: { vendor: PRINT_BRIDGE_INSTALL },
    remove: { vendor: PRINT_BRIDGE_REMOVE },
  },
  {
    id: "homekit-bridge",
    name: "homekit-bridge",
    description:
      "Local HTTP bridge that controls HomeKit IP accessories " +
      "(github.com/PeckBoard/homekit-bridge) — the daemon the homekit plugin " +
      "talks to. User-local, no root: the latest single-file release goes to " +
      "~/.local/lib/homekit-bridge behind a ~/.local/bin/homekit-bridge " +
      "wrapper, using the system Node.js when it is 20 or newer and otherwise " +
      "a private official Node 22 build; a random bearer token goes to " +
      "~/.config/homekit-bridge/token (kept across reinstalls and removal), " +
      "and a systemd user unit serves 127.0.0.1:7782. Needs systemd --user; " +
      "enables linger when allowed so it keeps running after logout.",
    detect: 'test -x "$HOME/.local/bin/homekit-bridge"',
    version: '"$HOME/.local/bin/homekit-bridge" --version 2>/dev/null',
    install: { vendor: HOMEKIT_BRIDGE_INSTALL },
    remove: { vendor: HOMEKIT_BRIDGE_REMOVE },
  },
  {
    id: "mcpx",
    name: "mcpx",
    description:
      "MCP client CLI + local gateway (github.com/PeckBoard/mcpx): call the " +
      "tools of any server in an mcp.json (stdio or HTTP, with OAuth) from " +
      "scripts and bots, or run `mcpx serve` to expose them all on one local " +
      "MCP/REST endpoint. User-local, no root: the latest release binary for " +
      "the target's OS (Linux or macOS) and arch goes to ~/.local/bin/mcpx; " +
      "config and tokens in ~/.config/mcpx are kept on removal.",
    detect: 'test -x "$HOME/.local/bin/mcpx" || command -v mcpx',
    version: '"$HOME/.local/bin/mcpx" --version 2>/dev/null || mcpx --version',
    install: { vendor: MCPX_INSTALL },
    remove: {
      vendor:
        'rm -f "$HOME/.local/bin/mcpx"; echo "mcpx removed; kept ~/.config/mcpx (delete it by hand to wipe tokens)"',
    },
  },
];

export function findApp(id: string): CatalogApp | undefined {
  return APPS.find((a) => a.id === id);
}

/** The install recipe for a resolved package manager, falling back to the
 * app's vendor script when there's no PM-specific recipe (or no PM at all). */
export function installRecipeFor(
  app: CatalogApp,
  pm: PackageManager | null,
): string | null {
  // pip-namespace apps: the one pip recipe, whatever the distro PM is.
  if (app.install.pip) return app.install.pip;
  if (pm && app.install[pm]) return app.install[pm] as string;
  return app.install.vendor ?? null;
}

export function removeRecipeFor(
  app: CatalogApp,
  pm: PackageManager | null,
): string | null {
  if (app.remove.pip) return app.remove.pip;
  if (pm && app.remove[pm]) return app.remove[pm] as string;
  return app.remove.vendor ?? null;
}

/** The distro package names `installRecipeFor(app, pm)`'s PM recipe would
 * install; empty when the app resolves to its vendor script (or has no
 * recipe at all). Used to attribute the app's own package in an install's
 * snapshot delta — see provenance.ts. pip-namespace apps are empty too, on
 * purpose: their packages live in pip's namespace and never enter the
 * distro package database (see `pip_package`). */
export function packagesFor(
  app: CatalogApp,
  pm: PackageManager | null,
): string[] {
  if (!pm || !app.install[pm]) return [];
  return (app.packages?.[pm] ?? "").split(/\s+/).filter(Boolean);
}

/** A vendor-only app: its sole install recipe is the upstream `vendor`
 * script (no distro package-manager recipe), so it never enters the distro
 * package database and has no dependency-graph footprint on any distro —
 * unlike a normal app that simply isn't installed yet. pip-namespace apps are
 * tracked separately (see `namespace`). Drives the honest "not tracked by the
 * package manager" note in deps.ts regardless of whether app-manager itself
 * ran the install. */
export function isVendorApp(app: CatalogApp): boolean {
  return (
    app.namespace !== "pip" &&
    !!app.install.vendor &&
    Object.keys(app.install).every((k) => k === "vendor")
  );
}
