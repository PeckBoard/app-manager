import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPS,
  findApp,
  isVendorApp,
  installRecipeFor,
  packagesFor,
  removeRecipeFor,
} from "../src/catalog";

const PMS = ["apt", "dnf", "pacman", "zypper"] as const;
const VENDOR_ONLY = [
  "claude",
  "cursor-agent",
  "ollama",
  "orca-slicer",
  "print-bridge",
  "homekit-bridge",
  "mcpx",
  "voicestudio",
];
const PM_APPS = ["git", "node", "docker", "ripgrep", "xvfb"];

describe("catalog", () => {
  it("includes at least the required apps", () => {
    const ids = APPS.map((a) => a.id);
    for (const id of [...PM_APPS, ...VENDOR_ONLY]) {
      expect(ids).toContain(id);
    }
  });

  it("findApp is case-sensitive and returns undefined for unknown ids", () => {
    expect(findApp("git")?.id).toBe("git");
    expect(findApp("GIT")).toBeUndefined();
    expect(findApp("nonexistent")).toBeUndefined();
  });

  it("every distro-packaged app has an install and remove recipe for all four package managers", () => {
    for (const id of PM_APPS) {
      const app = findApp(id)!;
      for (const pm of PMS) {
        expect(app.install[pm], `${id} install.${pm}`).toBeTruthy();
        expect(app.install[pm]).toContain("sudo -A");
        expect(app.remove[pm], `${id} remove.${pm}`).toBeTruthy();
        expect(app.remove[pm]).toContain("sudo -A");
      }
    }
  });

  it("vendor-only apps have a vendor install+remove script and no package-manager recipes", () => {
    for (const id of VENDOR_ONLY) {
      const app = findApp(id)!;
      expect(app.install.vendor, `${id} install.vendor`).toBeTruthy();
      expect(app.remove.vendor, `${id} remove.vendor`).toBeTruthy();
      for (const pm of PMS) {
        expect(
          app.install[pm],
          `${id} install.${pm} should be absent`,
        ).toBeUndefined();
      }
    }
  });

  it("every catalog app has a detect and version probe", () => {
    for (const app of APPS) {
      expect(app.detect.length).toBeGreaterThan(0);
      expect(app.version.length).toBeGreaterThan(0);
    }
  });

  it("installRecipeFor prefers the package-manager recipe over vendor", () => {
    const git = findApp("git")!;
    expect(installRecipeFor(git, "apt")).toBe(git.install.apt);
  });

  it("installRecipeFor falls back to vendor when there's no recipe for the detected pm", () => {
    const ollama = findApp("ollama")!;
    expect(installRecipeFor(ollama, "apt")).toBe(ollama.install.vendor);
    expect(installRecipeFor(ollama, null)).toBe(ollama.install.vendor);
  });

  it("installRecipeFor/removeRecipeFor return null when neither a pm recipe nor vendor exists", () => {
    const fake = {
      id: "x",
      name: "x",
      description: "",
      detect: "",
      version: "",
      install: {},
      remove: {},
    };
    expect(installRecipeFor(fake, "apt")).toBeNull();
    expect(removeRecipeFor(fake, null)).toBeNull();
  });
  describe("print-farm prerequisites", () => {
    it("xvfb follows each distro's package name and is detected via xvfb-run", () => {
      const app = findApp("xvfb")!;
      expect(app.detect).toBe("command -v xvfb-run");
      expect(packagesFor(app, "apt")).toEqual(["xvfb"]);
      expect(packagesFor(app, "dnf")).toEqual(["xorg-x11-server-Xvfb"]);
      expect(packagesFor(app, "pacman")).toEqual(["xorg-server-xvfb"]);
      expect(packagesFor(app, "zypper")).toEqual([
        "xorg-x11-server-Xvfb",
        "xvfb-run",
      ]);
      expect(isVendorApp(app)).toBe(false);
    });

    it("orca-slicer is a user-local vendor install with no package-db footprint", () => {
      const app = findApp("orca-slicer")!;
      expect(isVendorApp(app)).toBe(true);
      for (const pm of [...PMS, null] as const) {
        expect(installRecipeFor(app, pm)).toBe(app.install.vendor);
        expect(removeRecipeFor(app, pm)).toBe(app.remove.vendor);
        if (pm) expect(packagesFor(app, pm)).toEqual([]);
      }
      const install = app.install.vendor!;
      // Official release asset, extracted (no FUSE), wrapped into ~/.local/bin.
      expect(install).toContain(
        "https://github.com/SoftFever/OrcaSlicer/releases/latest",
      );
      expect(install).toContain("--appimage-extract");
      expect(install).toContain('"$HOME/.local/bin/orca-slicer"');
      expect(install).not.toContain("sudo");
      // Missing host libs (e.g. libGLU on Ubuntu 26.04) are fetched rootless
      // into extra-lib, which the wrapper puts on LD_LIBRARY_PATH.
      expect(install).toContain("apt-get download");
      expect(install).toContain("dpkg-deb -x");
      expect(install).toContain("libGLU.so.1:deb) echo libglu1-mesa ;;");
      expect(install).toContain(
        'export LD_LIBRARY_PATH="$HOME/.local/share/orca-slicer/extra-lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\\nexec "$HOME/.local/share/orca-slicer/AppRun" "$@"',
      );
      expect(spawnSync("sh", ["-n", "-c", install]).status).toBe(0);
      expect(app.remove.vendor).toContain("$HOME/.local/share/orca-slicer");
      // A pre-existing Flathub install counts as present.
      expect(app.detect).toContain("command -v orca-slicer");
      expect(app.detect).toContain("flatpak info com.orcaslicer.OrcaSlicer");
    });
  });

  it("print-bridge installs a user-local binary, token and systemd user unit", () => {
    const app = findApp("print-bridge")!;
    expect(isVendorApp(app)).toBe(true);
    const install = app.install.vendor!;
    const remove = app.remove.vendor!;
    for (const script of [install, remove]) {
      expect(script).not.toContain("sudo");
      // Valid POSIX sh.
      execFileSync("sh", ["-n", "-c", script]);
    }
    expect(install).toContain(
      "https://github.com/PeckBoard/print-bridge/releases/latest/download/$asset",
    );
    expect(install).toContain("sha256sum");
    // Refuses before touching anything without a systemd user manager.
    expect(install.indexOf("systemctl --user show-environment")).toBeLessThan(
      install.indexOf("curl"),
    );
    // Token only minted when absent, never rotated by a reinstall.
    expect(install).toContain('if [ ! -e "$HOME/.config/print-bridge/token" ]');
    expect(install).toContain(
      "'ExecStart=%h/.local/bin/print-bridge --bind 127.0.0.1:7781 --token-file %h/.config/print-bridge/token'",
    );
    expect(install).toContain("systemctl --user enable print-bridge");
    expect(install).toContain("loginctl enable-linger");
    expect(remove).toContain("systemctl --user disable --now print-bridge");
    expect(remove).toContain('rm -f "$HOME/.local/bin/print-bridge"');
    expect(remove).not.toContain('token"');
    expect(remove).not.toContain("rm -rf");
    expect(app.version).toContain("--version");
  });
  it("homekit-bridge installs a bundle behind a node-pinning wrapper, token and user unit", () => {
    const app = findApp("homekit-bridge")!;
    expect(isVendorApp(app)).toBe(true);
    const install = app.install.vendor!;
    const remove = app.remove.vendor!;
    for (const script of [install, remove]) {
      expect(script).not.toContain("sudo");
      execFileSync("sh", ["-n", "-c", script]);
    }
    expect(install.indexOf("systemctl --user show-environment")).toBeLessThan(
      install.indexOf("curl"),
    );
    // Too-old distro node falls back to a sha256-checked private Node 22.
    expect(install).toContain("process.versions.node");
    expect(install).toContain("https://nodejs.org/dist/latest-v22.x");
    expect(install).toContain(
      "https://github.com/PeckBoard/homekit-bridge/releases/latest/download/$asset",
    );
    expect(install.split("sha256sum").length - 1).toBe(2);
    expect(install).toContain(
      'if [ ! -e "$HOME/.config/homekit-bridge/token" ]',
    );
    expect(install).toContain(
      "'ExecStart=%h/.local/bin/homekit-bridge --bind 127.0.0.1:7782 --token-file %h/.config/homekit-bridge/token'",
    );
    expect(remove).toContain("systemctl --user disable --now homekit-bridge");
    // Pairings (accessory keys) and the token survive removal.
    expect(remove).not.toContain(".local/share/homekit-bridge\"");
    expect(remove).not.toContain('token"');
  });

  it("homekit-bridge's wrapper pins the resolved node and forwards args", () => {
    const install = findApp("homekit-bridge")!.install.vendor!;
    const m = install.match(/printf '#!\/bin\/sh[^']*' [^>]+/);
    expect(m).not.toBeNull();
    const out = execFileSync("sh", [
      "-c",
      `node_bin=/opt/n/bin/node; lib=/l; asset=a.mjs; ${m![0]}`,
    ]).toString();
    expect(out).toBe('#!/bin/sh\nexec "/opt/n/bin/node" "/l/a.mjs" "$@"\n');
  });
  it("mcpx installs a sha256-checked user-local binary and keeps its config", () => {
    const app = findApp("mcpx")!;
    const install = installRecipeFor(app, "apt")!;
    expect(install).toContain(
      "https://github.com/PeckBoard/mcpx/releases/latest/download/$asset",
    );
    expect(install).toContain("sha256 mismatch");
    expect(install).toContain(
      'install -m 755 "$tmp/$asset" "$HOME/.local/bin/mcpx"',
    );
    expect(install).not.toContain("systemctl");
    expect(app.remove.vendor).toContain('rm -f "$HOME/.local/bin/mcpx"');
    expect(app.remove.vendor).not.toContain('.config/mcpx"');
  });
  it("mcpx picks the macOS asset on Darwin and checks it with shasum", () => {
    // Runs the real script with a macOS-shaped PATH: uname says Darwin/arm64,
    // curl serves a fake release from disk, and there is no sha256sum.
    const root = mkdtempSync(join(tmpdir(), "lam-mcpx-"));
    const bin = join(root, "bin");
    const home = join(root, "home");
    mkdirSync(bin);
    mkdirSync(home);
    for (const tool of ["mktemp", "cut", "mkdir", "install", "rm", "cat"]) {
      const real = execFileSync("sh", ["-c", `command -v ${tool}`])
        .toString()
        .trim();
      symlinkSync(real, join(bin, tool));
    }
    const sha = execFileSync("sh", ["-c", "command -v sha256sum"])
      .toString()
      .trim();
    const shim = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    shim("uname", '[ "$1" = -s ] && echo Darwin || echo arm64');
    shim("shasum", `[ "$1" = -a ] && shift 2; exec ${sha} "$@"`);
    const release = join(root, "release");
    mkdirSync(release);
    const asset = join(release, "mcpx-macos-aarch64");
    writeFileSync(asset, "#!/bin/sh\necho mcpx 9.9.9\n");
    const hash = execFileSync(sha, [asset]).toString().split(" ")[0];
    writeFileSync(`${asset}.sha256`, `${hash}  mcpx-macos-aarch64\n`);
    shim(
      "curl",
      `while [ $# -gt 1 ]; do [ "$1" = -o ] && out="$2"; shift; done\n` +
        `echo "$1" >> ${join(root, "urls")}\n` +
        `exec cat "${release}/\${1##*/}" > "$out"`,
    );
    const app = findApp("mcpx")!;
    const res = spawnSync("/bin/sh", ["-c", installRecipeFor(app, null)!], {
      env: { PATH: bin, HOME: home },
    });
    expect(res.stderr.toString()).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout.toString()).toBe("mcpx 9.9.9\n");
    expect(readFileSync(join(root, "urls"), "utf8")).toContain(
      "/releases/latest/download/mcpx-macos-aarch64.sha256",
    );
    // A tampered checksum is refused.
    writeFileSync(`${asset}.sha256`, `${"0".repeat(64)}  mcpx-macos-aarch64\n`);
    const bad = spawnSync("/bin/sh", ["-c", installRecipeFor(app, null)!], {
      env: { PATH: bin, HOME: home },
    });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr.toString()).toContain("sha256 mismatch");
    rmSync(root, { recursive: true, force: true });
  });
  it("voicestudio runs a pinned Docker image with a key that is minted once and never shown", () => {
    const app = findApp("voicestudio")!;
    expect(isVendorApp(app)).toBe(true);
    const install = app.install.vendor!;
    const remove = app.remove.vendor!;
    for (const script of [install, remove, app.version, app.detect]) {
      expect(script).not.toContain("sudo");
      execFileSync("sh", ["-n", "-c", script]);
    }
    // Refuses before touching anything without a usable Docker daemon.
    const firstWrite = install.indexOf("mkdir -p");
    expect(install.indexOf("command -v docker")).toBeLessThan(firstWrite);
    expect(install.indexOf("docker info >/dev/null")).toBeLessThan(firstWrite);
    expect(install).toContain("docker group");
    // One pinned tag; the GPU variants are suffixes of it.
    expect(install).toContain("base='ghcr.io/debpalash/voicestudio:0.5.6'");
    expect(install).toContain('image="$base-rocm"');
    expect(install).toContain('image="$base-cuda-arm64"');
    expect(install).toContain('gpu="--gpus all"');
    // Key only minted when absent, handed over via the environment, never echoed.
    expect(install).toContain(
      'if [ ! -e "$HOME/.config/voicestudio/api-key" ]; then (umask 077;',
    );
    expect(install).toContain('OMNIVOICE_API_KEY="$key" docker run');
    expect(install).toContain("-e OMNIVOICE_API_KEY -e");
    expect(install).not.toMatch(/echo[^;]*\$key/);
    // The only read of the key file captures it into $key.
    expect(install.split('cat "$HOME/.config/voicestudio/api-key"').length - 1).toBe(1);
    expect(install).toContain('key="$(cat "$HOME/.config/voicestudio/api-key")"');
    // Recreated on every (re)install, then waited on.
    expect(install.indexOf("docker rm -f voicestudio")).toBeLessThan(
      install.indexOf("docker run"),
    );
    expect(install).toContain("http://127.0.0.1:3900/health");
    expect(install).toContain("docker logs --tail 50 voicestudio");
    // Model pre-download is best-effort.
    expect(install).toContain("/models/install");
    expect(install).toContain("if ! docker exec voicestudio python3 -c");
    expect(install).toContain("VoiceStudio listening on http://$addr:3900");
    // Remove deletes the container only; volume and key survive.
    expect(remove).toContain("docker rm -f voicestudio");
    const told = remove.indexOf('echo "VoiceStudio removed');
    expect(remove.indexOf("docker rm -f voicestudio")).toBeLessThan(told);
    // The wipe commands appear only inside the closing message.
    expect(remove.indexOf("docker volume rm voicestudio-data")).toBeGreaterThan(told);
    expect(remove.indexOf("rm -r ~/.config/voicestudio")).toBeGreaterThan(told);
    expect(app.detect).toContain("docker inspect --type container voicestudio");
  });
  describe("python / pip namespace entries", () => {
    it("python3 and pip are normal distro-packaged apps", () => {
      for (const id of ["python3", "pip"]) {
        const app = findApp(id)!;
        expect(app.namespace, `${id} is a system app`).toBeUndefined();
        for (const pm of PMS) {
          expect(app.install[pm], `${id} install.${pm}`).toContain("sudo -A");
        }
      }
      // The package NAMES differ per distro — the recipes must follow.
      expect(findApp("pip")!.install.apt).toContain("python3-pip");
      expect(findApp("pip")!.install.pacman).toContain("python-pip");
      expect(findApp("python3")!.install.pacman).toContain(
        "pacman -Sy --noconfirm python",
      );
      expect(findApp("python3")!.install.apt).toContain(
        "apt-get install -y python3",
      );
    });

    it("python3 deliberately has no remove recipe on any distro", () => {
      const app = findApp("python3")!;
      for (const pm of PMS)
        expect(app.remove[pm], `remove.${pm}`).toBeUndefined();
      expect(removeRecipeFor(app, "apt")).toBeNull();
      expect(removeRecipeFor(app, null)).toBeNull();
    });

    it("graphifyy is a pip-namespace entry: one pip recipe on every distro, no distro packages", () => {
      const app = findApp("graphifyy")!;
      expect(app.namespace).toBe("pip");
      expect(app.pip_package).toBe("graphifyy");
      expect(app.install.pip).toContain(
        "python3 -m pip install --user graphifyy",
      );
      expect(app.remove.pip).toContain("python3 -m pip uninstall -y graphifyy");
      for (const pm of [...PMS, null] as const) {
        expect(installRecipeFor(app, pm)).toBe(app.install.pip);
        expect(removeRecipeFor(app, pm)).toBe(app.remove.pip);
      }
      for (const pm of PMS) {
        expect(
          app.install[pm],
          `install.${pm} should be absent`,
        ).toBeUndefined();
        // Invisible to the snapshot bracket: pip packages never enter the
        // distro package DB.
        expect(packagesFor(app, pm)).toEqual([]);
      }
      // pip probes, not distro probes: presence via pip show, version via
      // pip's freeze format.
      expect(app.detect).toContain("pip show graphifyy");
      expect(app.version).toContain("pip list --format=freeze");
      // User-site installs, with PEP 668's refusal lifted via the env var.
      expect(app.install.pip).toContain("PIP_BREAK_SYSTEM_PACKAGES=1");
      expect(app.install.pip).not.toContain("sudo");
    });
  });
});
