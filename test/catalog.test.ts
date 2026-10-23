import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
