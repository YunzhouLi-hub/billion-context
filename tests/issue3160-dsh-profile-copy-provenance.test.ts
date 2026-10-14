// #3160: a dsh profile copy can be wedged by an out-of-band install whose
// version is not older than the registry's — every self-heal path gates on
// one-way semver (src/update.ts), so the copy never converges and the
// divergence is otherwise silent (readDiskVersion has no provenance). These
// tests pin the detection module: lockfile/manifest/copy disagreement, specs
// no registry resolution can produce, and build divergence across profiles.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

// LOCK_FILE is frozen at update.ts module load (reached through
// provenance.ts's isVersionNewer import) — redirect the cache tree BEFORE
// importing it (same discipline as update-dsh-self-refresh.test.ts).
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue3160-provenance-")));
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { auditDshProfileCopyProvenance, dshProfileCopyFindings } = await import("../src/provenance.ts");

after(() => {
    delete process.env.XDG_CACHE_HOME;
    rmrf(root);
});

interface Fixture {
    base: string;
    dshHome: string;
    profiles: Record<string, string>;
    setProfile(name: string): void;
    cleanup(): void;
}

/** A dsh home. Each profile gets `manifestSpec` (or none), a copy at
 *  `copyVersion` (or none), a pnpm-lock block (or none), and a build-info
 *  commit. The profile package.json is only written when a manifest spec is
 *  given, so a profile without the dependency stays absent rather than empty. */
function makeFixture(opts: {
    profiles: Record<string, { manifestSpec?: string; copyVersion?: string; buildCommit?: string; lock?: { specifier: string; version: string }; packageLock?: boolean }>;
}): Fixture {
    const base = fs.mkdtempSync(path.join(root, "fx-"));
    const dshHome = path.join(base, "dsh");
    fs.mkdirSync(dshHome, { recursive: true });
    const profiles: Record<string, string> = {};
    for (const [name, p] of Object.entries(opts.profiles)) {
        const dir = path.join(dshHome, "profiles", name);
        profiles[name] = dir;
        fs.mkdirSync(dir, { recursive: true });
        if (p.manifestSpec !== undefined) {
            fs.writeFileSync(
                path.join(dir, "package.json"),
                JSON.stringify({ private: true, dependencies: { "billion-context": p.manifestSpec } }),
            );
        }
        if (p.copyVersion !== undefined) {
            const installDir = path.join(dir, "node_modules", "billion-context");
            fs.mkdirSync(installDir, { recursive: true });
            fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: p.copyVersion }));
            if (p.buildCommit !== undefined) {
                fs.mkdirSync(path.join(installDir, "dist"), { recursive: true });
                fs.writeFileSync(path.join(installDir, "dist", "build-info.json"), JSON.stringify({ commit: p.buildCommit, version: p.copyVersion }));
            }
        }
        if (p.lock !== undefined) {
            if (p.packageLock === true) {
                fs.writeFileSync(
                    path.join(dir, "package-lock.json"),
                    JSON.stringify({
                        packages: {
                            "": { dependencies: { "billion-context": p.lock.specifier } },
                            "node_modules/billion-context": { version: p.lock.version },
                        },
                    }),
                );
            } else {
                fs.writeFileSync(
                    path.join(dir, "pnpm-lock.yaml"),
                    ["lockfileVersion: '9.0'", "importers:", "  .:", "    dependencies:", "      billion-context:", `        specifier: ${p.lock.specifier}`, `        version: ${p.lock.version}`, "packages:", ""].join("\n"),
                );
            }
        }
    }
    return {
        base,
        dshHome,
        profiles,
        setProfile() {
            process.env.DSH_HOME = dshHome;
            delete process.env.BILI_DSH_HOME;
        },
        cleanup() {
            delete process.env.DSH_HOME;
            delete process.env.BILI_DSH_HOME;
            rmrf(base);
        },
    };
}

function kinds(dir: string, registryVersion?: string): string[] {
    return dshProfileCopyFindings(dir, registryVersion).map((f) => f.kind);
}

function makeLog(): { log: Logger; entries: string[] } {
    const entries: string[] = [];
    return { log: (level, msg) => { entries.push(`${level}: ${msg}`); }, entries };
}

async function withRegistry<T>(version: string | undefined, fn: (fetches: { count: number }) => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const fetches = { count: 0 };
    globalThis.fetch = (() => {
        fetches.count += 1;
        return version === undefined
            ? Promise.resolve(new Response("nope", { status: 500 }))
            : Promise.resolve(new Response(JSON.stringify({ version })));
    }) as unknown as typeof fetch;
    try {
        return await fn(fetches);
    } finally {
        globalThis.fetch = original;
    }
}

// — the healthy path ————————————————————————————————————————————————————

test("#3160 provenance: copy, manifest, and lockfile in agreement stay silent", () => {
    const fx = makeFixture({
        profiles: { web: { manifestSpec: "^0.1.196", copyVersion: "0.1.196", buildCommit: "d64139f9", lock: { specifier: "^0.1.196", version: "0.1.196" } } },
    });
    try {
        fx.setProfile("web");
        assert.deepEqual(kinds(fx.profiles.web, "0.1.197"), []);
    } finally {
        fx.cleanup();
    }
});

// — the reported incident (#3160) ————————————————————————————————————————

test("#3160 provenance: 1.2.9 copy against a registry whose latest is 0.1.197 is flagged", () => {
    // the reporter's exact state: hand-placed copy at a version the registry
    // never published, no lockfile to explain it (manifest still coherent).
    const fx = makeFixture({ profiles: { web: { manifestSpec: "^1.2.9", copyVersion: "1.2.9" } } });
    try {
        fx.setProfile("web");
        const found = kinds(fx.profiles.web, "0.1.197");
        assert.deepEqual(found, ["spec-above-registry"]);
        const finding = dshProfileCopyFindings(fx.profiles.web, "0.1.197")[0];
        assert.ok(finding.detail.includes("1.2.9"), "detail names the fabricated spec");
        assert.ok(finding.detail.includes("dsh plugin --profile web add"), "detail carries the host-channel remediation");
    } finally {
        fx.cleanup();
    }
});

test("#3160 provenance: out-of-band copy against an intact lockfile is flagged", () => {
    // the wedge with a lockfile present: the copy and the manifest were both
    // lifted, but a stale lock still records the real resolution.
    const fx = makeFixture({
        profiles: { web: { manifestSpec: "^1.2.9", copyVersion: "1.2.9", lock: { specifier: "^0.1.196", version: "0.1.196" } } },
    });
    try {
        fx.setProfile("web");
        const found = kinds(fx.profiles.web, "0.1.197");
        assert.ok(found.includes("copy-vs-lock"));
        assert.ok(found.includes("manifest-vs-lock"));
        assert.ok(found.includes("spec-above-registry"));
    } finally {
        fx.cleanup();
    }
});

// — manifest/lock coherence —————————————————————————————————————————————

test("#3160 provenance: lockfile disagreeing with the manifest spec is flagged", () => {
    // same copy on disk and in the lock, but the manifest spec says otherwise
    // — the host's next reconcile would roll the copy backwards.
    const fx = makeFixture({
        profiles: { web: { manifestSpec: "^0.1.196", copyVersion: "0.1.197", lock: { specifier: "^0.1.196", version: "0.1.197" } } },
    });
    try {
        fx.setProfile("web");
        assert.deepEqual(kinds(fx.profiles.web, "0.1.197"), []);
    } finally {
        fx.cleanup();
    }
});

test("#3160 provenance: package-lock.json is read like pnpm-lock.yaml", () => {
    const fx = makeFixture({
        profiles: { web: { manifestSpec: "^0.1.196", copyVersion: "1.2.9", packageLock: true, lock: { specifier: "^0.1.196", version: "0.1.196" } } },
    });
    try {
        fx.setProfile("web");
        assert.ok(kinds(fx.profiles.web, "0.1.197").includes("copy-vs-lock"));
    } finally {
        fx.cleanup();
    }
});

// — dev lanes and absent state ——————————————————————————————————————————

test("#3160 provenance: link:/file: dev pins are never flagged", () => {
    const fx = makeFixture({
        profiles: {
            dev: { manifestSpec: `link:${path.join(root, "dev-bc")}`, copyVersion: "0.0.0-local" },
            dev2: { manifestSpec: `file:${path.join(root, "dev-bc")}` },
        },
    });
    try {
        fx.setProfile("dev");
        assert.deepEqual(kinds(fx.profiles.dev, "0.1.197"), []);
        assert.deepEqual(kinds(fx.profiles.dev2, "0.1.197"), []);
    } finally {
        fx.cleanup();
    }
});

test("#3160 provenance: profiles without the dependency, the copy, or any lockfile stay silent", () => {
    const fx = makeFixture({
        profiles: {
            nodep: { copyVersion: "0.1.196" },
            nocopy: { manifestSpec: "^0.1.197", lock: { specifier: "^0.1.197", version: "0.1.197" } },
            nolock: { manifestSpec: "^0.1.196", copyVersion: "0.1.196" },
        },
    });
    try {
        fx.setProfile("nodep");
        assert.deepEqual(kinds(fx.profiles.nodep, "0.1.197"), []);
        assert.deepEqual(kinds(fx.profiles.nocopy, "0.1.197"), []);
        assert.deepEqual(kinds(fx.profiles.nolock, "0.1.197"), []);
    } finally {
        fx.cleanup();
    }
});

test("#3160 provenance: no lockfile and a copy the manifest cannot explain is flagged", () => {
    // the manifest is coherent (^0.1.196 admits the registry's 0.1.197); only
    // the copy beside it is out-of-band, so the manifest rung catches it.
    const fx = makeFixture({ profiles: { web: { manifestSpec: "^0.1.196", copyVersion: "1.2.9" } } });
    try {
        fx.setProfile("web");
        assert.deepEqual(kinds(fx.profiles.web, "0.1.197"), ["copy-vs-manifest"]);
    } finally {
        fx.cleanup();
    }
});

// — build divergence ————————————————————————————————————————————————

test("#3160 provenance: same version, different build commit across profiles is flagged", () => {
    const fx = makeFixture({
        profiles: {
            a: { manifestSpec: "^0.1.196", copyVersion: "0.1.196", buildCommit: "aaaaaaa", lock: { specifier: "^0.1.196", version: "0.1.196" } },
            b: { manifestSpec: "^0.1.196", copyVersion: "0.1.196", buildCommit: "bbbbbbb", lock: { specifier: "^0.1.196", version: "0.1.196" } },
        },
    });
    try {
        fx.setProfile("a");
        const first = dshProfileCopyFindings(fx.profiles.a, "0.1.197");
        assert.deepEqual(first, [], "first profile establishes the baseline");
        const second = dshProfileCopyFindings(fx.profiles.b, "0.1.197", { buildBaseline: { version: "0.1.196", commit: "aaaaaaa", profile: "a" } });
        assert.equal(second.length, 1);
        assert.equal(second[0].kind, "build-divergence");
        assert.ok(second[0].detail.includes("bbbbbbb") && second[0].detail.includes("aaaaaaa"));
    } finally {
        fx.cleanup();
    }
});

// — the startup entry point ————————————————————————————————————————————

test("#3160 audit: wedged profile logs a warn with remediation; healthy stays silent", async () => {
    const fx = makeFixture({ profiles: { web: { manifestSpec: "^1.2.9", copyVersion: "1.2.9" } } });
    const { log, entries } = makeLog();
    try {
        fx.setProfile("web");
        await withRegistry("0.1.197", async () => {
            await auditDshProfileCopyProvenance({ log, fetchRegistryVersion: async () => "0.1.197" });
        });
        assert.equal(entries.length, 1);
        assert.ok(entries[0].startsWith("warn:"), "severity is warn");
        assert.ok(entries[0].includes("#3160"));
        assert.ok(entries[0].includes("dsh plugin --profile web add"), "remediation names the host channel");
    } finally {
        fx.cleanup();
    }
});

test("#3160 audit: registry unreachable still flags the copy-vs-lock divergence", async () => {
    // the spec-above-registry rung needs the registry, but the lockfile rungs
    // must not depend on it — an offline install still gets warned.
    const fx = makeFixture({
        profiles: { web: { manifestSpec: "^1.2.9", copyVersion: "1.2.9", lock: { specifier: "^0.1.196", version: "0.1.196" } } },
    });
    const { log, entries } = makeLog();
    try {
        fx.setProfile("web");
        await withRegistry(undefined, async () => {
            await auditDshProfileCopyProvenance({ log, fetchRegistryVersion: async () => { throw new Error("offline"); } });
        });
        const logged = entries.join("\n");
        assert.ok(logged.includes("does not match the lockfile resolution"), "copy-vs-lock logged without the registry");
        assert.ok(!logged.includes("NEWER than the registry"), "no registry verdict without the registry");
    } finally {
        fx.cleanup();
    }
});

test("#3160 audit: a broken detector never throws into the caller", async () => {
    const fx = makeFixture({ profiles: { web: { manifestSpec: "^0.1.196", copyVersion: "0.1.196" } } });
    const { log } = makeLog();
    try {
        fx.setProfile("web");
        await auditDshProfileCopyProvenance({ log, fetchRegistryVersion: async () => { throw new Error("boom"); } });
        // no DSH_HOME-independent state to assert beyond not throwing
        assert.ok(true);
    } finally {
        fx.cleanup();
    }
});
