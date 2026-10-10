import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

type Captured = { url: string; body: Buffer };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// #2607: archivable media folds BY DEFAULT — its pixels must therefore be
// archived by mNNNNN ref on EVERY session (not only stripImages ones), or a
// fold destroys them unrecoverably. Two passes: entry-time (messages that
// already have refs) and post-prepare (messages whose ref was assigned during
// this turn's prepare — e.g. a freshly-sent image). Neither strips anything:
// with stripImages off the forwarded body must still carry the image part.
test("default config archives inbound images by ref without stripping", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const stateRoot = join(tmpdir(), `bili-fold-img-${process.pid}-${Date.now()}`);
    mkdirSync(stateRoot, { recursive: true });
    process.env.XDG_STATE_HOME = stateRoot;
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", body: Buffer.concat(chunks) });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "resp_test", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    const img = { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", detail: "high" };
    const msg = (id: string, content: unknown[]) => ({ type: "message", id, status: "completed", role: "user", content });
    const dir = join(stateRoot, "billion-context", "retrieve", "img", "fold-archive-1");
    try {
        // Turn 1: a single image message. It has NO ref at entry time, so only
        // the post-prepare refresh can archive it — if the spill file exists
        // after this request, both the always-on gate and the post-prepare
        // pass are proven.
        const r1 = await fetch(`${base}/responses`, {
            method: "POST",
            headers: { authorization: "Bearer k", "session-id": "fold-archive-1", "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5", stream: false, input: [msg("a1", [{ type: "input_text", text: "look" }, img])] }),
        });
        assert.equal(r1.status, 200);
        await r1.arrayBuffer();
        const files1 = readdirSync(dir);
        assert.equal(files1.length, 1);
        assert.match(files1[0], /^m\d+-[0-9a-f]{8}\.png$/);
        // stripImages is off: nothing stripped from the forwarded body.
        assert.ok(JSON.stringify(JSON.parse(captured[0].body.toString("utf8")).input).includes('"input_image"'));

        // Turn 2: the client re-sends history plus one text message. The
        // entry-time pass now sees the archived message's ref; skip-if-exists
        // keeps exactly one file (no duplicates from the second indexing).
        const r2 = await fetch(`${base}/responses`, {
            method: "POST",
            headers: { authorization: "Bearer k", "session-id": "fold-archive-1", "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5", stream: false, input: [msg("a1", [{ type: "input_text", text: "look" }, img]), msg("a2", [{ type: "input_text", text: "more" }])] }),
        });
        assert.equal(r2.status, 200);
        await r2.arrayBuffer();
        const files2 = readdirSync(dir);
        assert.deepEqual(files2, files1);
    } finally {
        delete process.env.XDG_STATE_HOME;
        rmSync(stateRoot, { recursive: true, force: true });
        await close(proxy);
        await close(upstream);
    }
});
