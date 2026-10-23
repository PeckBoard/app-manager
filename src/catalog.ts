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

/** OrcaSlicer's vendor install: resolve the latest GitHub release tag via the
 * /releases/latest redirect, download that release's Ubuntu 24.04 AppImage
 * for this arch, and EXTRACT it (`--appimage-extract` needs no FUSE, which
 * headless hosts usually lack) into ~/.local/share/orca-slicer, with a tiny
 * ~/.local/bin/orca-slicer wrapper exec'ing its AppRun. User-local only, no
 * root. Preferred over Flathub because it needs neither flatpak nor a
 * configured remote on the target. */
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
  'rm -rf "$HOME/.local/share/orca-slicer"; ' +
  'mv "$tmp/squashfs-root" "$HOME/.local/share/orca-slicer"; ' +
  'echo "$ver" > "$HOME/.local/share/orca-slicer/VERSION"; ' +
  'printf \'#!/bin/sh\\nexec "$HOME/.local/share/orca-slicer/AppRun" "$@"\\n\' > "$HOME/.local/bin/orca-slicer"; ' +
  'chmod +x "$HOME/.local/bin/orca-slicer"; ' +
  'rm -rf "$tmp"';
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
