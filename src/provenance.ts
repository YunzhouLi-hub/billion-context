// #3160: provenance detection for dsh profile copies of billion-context.
//
// The dsh-lane self-heal paths (refreshDshProfileCopy / refreshDshDesktopCopy /
// staleDshProfileCopies in src/update.ts) all compare the copy's on-disk
// version against the target with ONE-WAY semver: local >= target reads as
// "already newest" and is skipped, so the inner === targetVersion skip in
// refreshDshProfileBundles (src/dsh-channel.ts) is never reached. A copy
// dropped out-of-band at a fabricated higher version therefore wedges the
// profile forever — exactly the #3160 incident (a hand-made 1.2.9 sitting in
// the desktop profile beside a lockfile that still resolves 0.1.196).
//
// This module is DETECTION ONLY: it reads state and warns loudly. It never
// installs, writes, or spawns anything, so it stays out of the install-lane
// contract's single-writer rule and out of src/update.ts's human-gated
// no-op-release prerequisite. Convergence (the equality gate) is the separate
// follow-up the issue thread agreed on.

import fs from "node:fs";
import path from "node:path";
import { DSH_PACKAGE, dshProfileDirs, dshProfileDepSpec, isRegistryDepSpec } from "./dsh-channel.js";
import { isVersionNewer } from "./update.js";
import type { Logger } from "./logger.js";

type ProvenanceFindingKind = "copy-vs-lock" | "manifest-vs-lock" | "copy-vs-manifest" | "spec-above-registry" | "build-divergence";

interface ProvenanceFinding {
    profile: string;
    kind: ProvenanceFindingKind;
    /** The on-disk copy's declared version, when readable. */
    copyVersion?: string;
    /** The lockfile's resolved version, when a lockfile entry exists. */
    lockVersion?: string;
    /** The profile manifest's declared spec. */
    spec?: string;
    /** The registry's latest version for the configured update tag. */
    registryVersion?: string;
    /** One-sentence, human-ready description (no log prefix). */
    detail: string;
}

/** A pnpm-lock.yaml / package-lock.json resolution of the billion-context
 *  dependency: what the manifest asked for (specifier) and what the lockfile
 *  resolved it to (version). */
interface LockResolution {
    specifier?: string;
    version?: string;
}

function readJsonFile(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

/** The profile's installed copy version — node_modules/<pkg>/package.json's
 *  version field. Undefined when the mount is declared but missing (that is
 *  doctor's "broken" verdict, not a provenance finding). */
function readCopyVersion(profileDir: string, pkg: string = DSH_PACKAGE): string | undefined {
    const doc = readJsonFile(path.join(profileDir, "node_modules", pkg, "package.json")) as { version?: unknown } | undefined;
    return typeof doc?.version === "string" ? doc.version : undefined;
}

/** The profile copy's build provenance — dist/build-info.json's commit field
 *  (written by this repo's build). Undefined when absent (a release-channel
 *  install may legitimately lack it), so absence is never a finding. */
function readCopyBuildCommit(profileDir: string, pkg: string = DSH_PACKAGE): string | undefined {
    const doc = readJsonFile(path.join(profileDir, "node_modules", pkg, "dist", "build-info.json")) as { commit?: unknown } | undefined;
    return typeof doc?.commit === "string" ? doc.commit : undefined;
}

/** Parse the pnpm-lock.yaml entry for `pkg`. Handles the two shapes pnpm has
 *  written across lockfile majors: the flat `dependencies:` object form and
 *  the `importers:` / `specifiers:` forms of v6+. Returns undefined when the
 *  file is absent or carries no entry for the package (never guesses from a
 *  sibling entry). */
function readPnpmLockResolution(profileDir: string, pkg: string = DSH_PACKAGE): LockResolution | undefined {
    let text: string;
    try {
        text = fs.readFileSync(path.join(profileDir, "pnpm-lock.yaml"), "utf8");
    } catch {
        return undefined;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        // The bare-name entry only: `billion-context@0.1.197:` snapshot keys
        // carry an @version suffix and must not match.
        const head = lines[i].match(new RegExp(`^\\s+${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(\\S*)\\s*$`));
        if (!head) continue;
        const sameLine = head[1];
        if (sameLine) return { specifier: sameLine }; // specifiers: map form
        const entryIndent = lines[i].match(/^\s*/)![0].length;
        const block: LockResolution = {};
        for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j];
            if (line.trim() === "") continue;
            const indent = line.match(/^\s*/)![0].length;
            if (indent <= entryIndent) break; // sibling entry — this block ended
            const spec = line.match(/^\s+specifier:\s*(\S+)/);
            if (spec) block.specifier = spec[1];
            const version = line.match(/^\s+version:\s*(\S+)/);
            if (version) block.version = version[1];
            if (block.specifier !== undefined && block.version !== undefined) break;
        }
        if (block.specifier !== undefined || block.version !== undefined) return block;
    }
    return undefined;
}

/** package-lock.json fallback for npm-materialized profiles: the root's
 *  declared dependency spec plus the resolved node_modules/<pkg> version. */
function readPackageLockResolution(profileDir: string, pkg: string = DSH_PACKAGE): LockResolution | undefined {
    const doc = readJsonFile(path.join(profileDir, "package-lock.json")) as
        | { packages?: Record<string, { version?: unknown; dependencies?: Record<string, unknown> }> }
        | undefined;
    if (!doc?.packages) return undefined;
    const resolved = doc.packages[`node_modules/${pkg}`];
    const root = doc.packages[""];
    const spec = root?.dependencies?.[pkg];
    const out: LockResolution = {};
    if (typeof spec === "string") out.specifier = spec;
    if (typeof resolved?.version === "string") out.version = resolved.version;
    return out.specifier !== undefined || out.version !== undefined ? out : undefined;
}

/** The base version a registry-form spec pins ("^0.1.196" → "0.1.196"),
 *  or undefined for shapes this module does not judge (dist-tags, exotic
 *  ranges). */
function specBaseVersion(spec: string): string | undefined {
    const m = spec.match(/^[\s^~>=<]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    return m ? m[1] : undefined;
}

/** Does `version` satisfy a simple caret/tilde/exact spec? Returns undefined
 *  for anything more exotic — an unjudgeable spec must never produce a
 *  finding. Prerelease semantics are deliberately simplified: a spec without
 *  a prerelease does not admit one. */
function specAdmits(spec: string, version: string): boolean | undefined {
    const m = spec.match(/^([\^~]?)(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
    if (!m) return undefined;
    const [, op, majS, minS, patchS] = m;
    const maj = Number(majS);
    const min = Number(minS);
    const patch = Number(patchS);
    const v = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!v) return false;
    const vmaj = Number(v[1]);
    const vmin = Number(v[2]);
    const vpatch = Number(v[3]);
    if (vmaj !== maj) return false;
    if (op === "^") return vmin > min || (vmin === min && vpatch >= patch);
    if (op === "~") return vmin === min && vpatch >= patch;
    return vmin === min && vpatch === patch;
}

/** The actionable tail shared by every finding: name the wedge (#3160's
 *  one-way gate) and the host-channel command that clears it. */
function remediation(profile: string, registryVersion?: string): string {
    const target = registryVersion !== undefined ? `billion-context@${registryVersion}` : "billion-context@<registry version>";
    return `self-heal skips copies whose version is not older than the target (#3160), so this profile will never converge on its own — reinstall through the host channel: run \`dsh plugin --profile ${profile} add ${target}\` from a shell where \`dsh\` resolves, or \`bili plugin install dsh\``;
}

/** All provenance findings for ONE profile dir. Pure and synchronous; never
 *  throws. Local pins (link:/file:) and profiles without an installed copy
 *  are deliberately silent — both are legitimate states under the #1196
 *  install-lane contract. */
export function dshProfileCopyFindings(
    profileDir: string,
    registryVersion?: string,
    options?: { buildBaseline?: { version: string; commit: string; profile: string } },
): ProvenanceFinding[] {
    const profile = path.basename(profileDir);
    const spec = dshProfileDepSpec(profileDir);
    if (spec === undefined) return []; // no dependency — not this lane
    if (!isRegistryDepSpec(spec)) return []; // local pin — manual dev lane by design
    const copyVersion = readCopyVersion(profileDir);
    if (copyVersion === undefined) return []; // declared-but-missing: doctor's "broken" verdict owns that
    const lock = readPnpmLockResolution(profileDir) ?? readPackageLockResolution(profileDir);
    const findings: ProvenanceFinding[] = [];

    if (lock?.version !== undefined && lock.version !== copyVersion) {
        findings.push({
            profile,
            kind: "copy-vs-lock",
            copyVersion,
            lockVersion: lock.version,
            spec,
            detail: `billion-context copy v${copyVersion} does not match the lockfile resolution v${lock.version} — the copy was likely written out-of-band (the host package manager never resolved it); ${remediation(profile, registryVersion)}`,
        });
    }
    if (lock?.specifier !== undefined && lock.specifier !== spec) {
        findings.push({
            profile,
            kind: "manifest-vs-lock",
            copyVersion,
            spec,
            detail: `profile manifest declares ${spec} but the lockfile records ${lock.specifier} — the declaration and the resolution disagree, so the host's next reconcile may roll the copy backwards; ${remediation(profile, registryVersion)}`,
        });
    }
    if (lock === undefined) {
        // No lockfile at all: the manifest spec is the only declared truth.
        const admits = specAdmits(spec, copyVersion);
        if (admits === false) {
            findings.push({
                profile,
                kind: "copy-vs-manifest",
                copyVersion,
                spec,
                detail: `billion-context copy v${copyVersion} does not satisfy the manifest spec ${spec}, and no lockfile exists to explain the difference; ${remediation(profile, registryVersion)}`,
            });
        }
    }
    if (registryVersion !== undefined) {
        // A registry-form spec may never resolve above the registry's latest
        // published version for the configured tag — a spec that does was
        // fabricated, whatever the lockfile says.
        const base = specBaseVersion(spec);
        if (base !== undefined && isVersionNewer(base, registryVersion)) {
            findings.push({
                profile,
                kind: "spec-above-registry",
                copyVersion,
                spec,
                registryVersion,
                detail: `profile manifest declares ${spec}, whose base version v${base} is NEWER than the registry's ${registryVersion} — no registry resolution can produce this spec, so the manifest (and likely the copy beside it) was hand-edited; ${remediation(profile, registryVersion)}`,
            });
        }
    }
    // Build provenance: two profiles running the SAME version from DIFFERENT
    // build commits cannot both have come from the registry channel.
    const buildCommit = readCopyBuildCommit(profileDir);
    const baseline = options?.buildBaseline;
    if (buildCommit !== undefined && baseline?.commit !== undefined && copyVersion === baseline.version && buildCommit !== baseline.commit) {
        findings.push({
            profile,
            kind: "build-divergence",
            copyVersion,
            spec,
            detail: `dsh profile ${baseline.profile} runs v${copyVersion} from build ${baseline.commit} while this profile runs the same version from build ${buildCommit} — same-version/different-build copies mean at least one never came from the registry channel; ${remediation(profile, registryVersion)}`,
        });
    }
    return findings;
}

/** Walk every dsh profile and log one warn per finding. Detached by contract:
 *  never throws, never installs. `fetchRegistryVersion` is called at most once
 *  and only when at least one profile carries a registry-pinned copy — the
 *  common machine (no dsh, or only local pins) pays no network cost. */
export async function auditDshProfileCopyProvenance(opts?: {
    env?: NodeJS.ProcessEnv;
    log?: Logger;
    fetchRegistryVersion?: () => Promise<string | undefined>;
}): Promise<ProvenanceFinding[]> {
    const log = opts?.log ?? ((): void => {});
    let dirs: string[];
    try {
        dirs = dshProfileDirs(opts?.env);
    } catch {
        return []; // dsh has never run on this machine — nothing to audit
    }
    const candidates = dirs.filter((dir) => {
        const spec = dshProfileDepSpec(dir);
        return spec !== undefined && isRegistryDepSpec(spec) && readCopyVersion(dir) !== undefined;
    });
    if (candidates.length === 0) return [];

    let registryVersion: string | undefined;
    if (opts?.fetchRegistryVersion) {
        try {
            registryVersion = await opts.fetchRegistryVersion();
        } catch {
            registryVersion = undefined; // fail-open: lockfile/manifest checks still run
        }
    }
    const findings: ProvenanceFinding[] = [];
    // First profile per version establishes the build baseline; later
    // profiles on the same version are judged against it.
    const baselines = new Map<string, { commit: string; profile: string }>();
    for (const dir of candidates) {
        const copyVersion = readCopyVersion(dir);
        const buildCommit = copyVersion !== undefined ? readCopyBuildCommit(dir) : undefined;
        if (copyVersion === undefined || buildCommit === undefined) continue;
        if (!baselines.has(copyVersion)) baselines.set(copyVersion, { commit: buildCommit, profile: path.basename(dir) });
    }
    for (const dir of candidates) {
        const copyVersion = readCopyVersion(dir);
        findings.push(...dshProfileCopyFindings(dir, registryVersion, {
            buildBaseline: copyVersion !== undefined ? { version: copyVersion, ...(baselines.get(copyVersion) ?? { commit: "", profile: "" }) } : undefined,
        }));
    }
    for (const f of findings) {
        log("warn", `[dsh-profile] ${f.profile}: ${f.detail}`);
    }
    return findings;
}
