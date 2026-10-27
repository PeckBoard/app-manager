import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OS_RELEASE_PROBE,
  detectPackageManager,
  parseOsRelease,
} from "../src/distro";

describe("OS_RELEASE_PROBE", () => {
  it("answers ID=macos on Darwin, which has no /etc/os-release", () => {
    const bin = mkdtempSync(join(tmpdir(), "lam-probe-"));
    for (const [name, body] of [
      ["cat", "exit 1"],
      ["uname", "echo Darwin"],
    ]) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const out = execFileSync("/bin/sh", ["-c", OS_RELEASE_PROBE], {
      env: { PATH: bin },
    }).toString();
    rmSync(bin, { recursive: true, force: true });
    const release = parseOsRelease(out);
    expect(release).toEqual({ id: "macos", idLike: [] });
    expect(detectPackageManager(release)).toBeNull();
  });
});

describe("parseOsRelease", () => {
  it("parses quoted and unquoted KEY=VALUE lines", () => {
    const text = 'ID=ubuntu\nID_LIKE="debian"\nNAME="Ubuntu"\n';
    expect(parseOsRelease(text)).toEqual({ id: "ubuntu", idLike: ["debian"] });
  });

  it("lowercases id and splits a multi-value ID_LIKE", () => {
    const text = 'ID="Rocky Linux"\nID_LIKE="rhel fedora"\n';
    expect(parseOsRelease(text)).toEqual({
      id: "rocky linux",
      idLike: ["rhel", "fedora"],
    });
  });

  it("returns empty fields for blank/malformed input", () => {
    expect(parseOsRelease("")).toEqual({ id: "", idLike: [] });
    expect(parseOsRelease("not a key value line\n===\n")).toEqual({
      id: "",
      idLike: [],
    });
  });
});

describe("detectPackageManager", () => {
  it("maps debian/ubuntu to apt", () => {
    expect(detectPackageManager({ id: "ubuntu", idLike: ["debian"] })).toBe(
      "apt",
    );
    expect(detectPackageManager({ id: "debian", idLike: [] })).toBe("apt");
  });

  it("maps fedora/rhel-family to dnf", () => {
    expect(detectPackageManager({ id: "fedora", idLike: [] })).toBe("dnf");
    expect(
      detectPackageManager({ id: "rocky", idLike: ["rhel", "fedora"] }),
    ).toBe("dnf");
    expect(detectPackageManager({ id: "amzn", idLike: ["fedora"] })).toBe(
      "dnf",
    );
  });

  it("maps arch/manjaro to pacman", () => {
    expect(detectPackageManager({ id: "arch", idLike: [] })).toBe("pacman");
    expect(detectPackageManager({ id: "manjaro", idLike: ["arch"] })).toBe(
      "pacman",
    );
  });

  it("maps suse family to zypper", () => {
    expect(
      detectPackageManager({
        id: "opensuse-leap",
        idLike: ["suse", "opensuse"],
      }),
    ).toBe("zypper");
    expect(detectPackageManager({ id: "sles", idLike: [] })).toBe("zypper");
  });

  it("refuses to guess for an unrecognised distro", () => {
    expect(detectPackageManager({ id: "solaris", idLike: [] })).toBeNull();
    expect(detectPackageManager({ id: "", idLike: [] })).toBeNull();
  });
});
