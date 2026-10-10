import test from "node:test";
import assert from "node:assert/strict";
import { createLiveOriginResolver, installNativeFetchIntercept, isModelApiUrl, noteRoutedOrigin, observeRoutedOrigin, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";

test("isModelApiUrl: matches model-API endpoint shapes", () => {
    assert.equal(isModelApiUrl("http://127.0.0.1:8199/v1/messages"), true);
    assert.equal(isModelApiUrl("http://127.0.0.1:8199/v1/chat/completions"), true);
    assert.equal(isModelApiUrl("http://127.0.0.1:8199/v1/completions"), true);
    assert.equal(isModelApiUrl("http://127.0.0.1:8199/v1/responses"), true);
    assert.equal(isModelApiUrl("https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages"), true);
    assert.equal(isModelApiUrl("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"), true);
    assert.equal(isModelApiUrl("https://api.anthropic.com/v1/messages?beta=true"), true);
    assert.equal(isModelApiUrl("http://localhost:9123/v1/messages/"), true);
});

test("isModelApiUrl: matches Google native wire shapes (#2493)", () => {
    assert.equal(isModelApiUrl("http://127.0.0.1:8317/v1beta/models/gemini-3.8-flash-high:streamGenerateContent"), true);
    assert.equal(isModelApiUrl("http://127.0.0.1:8317/v1beta/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse"), true);
    assert.equal(isModelApiUrl("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"), true);
    assert.equal(isModelApiUrl("http://127.0.0.1:8317/v1beta/models/gemini-2.5-flash:countTokens"), true);
    assert.equal(isModelApiUrl("https://gw.example.com/api/v1beta/models/my-model@v2:generateContent"), true);
});

test("isModelApiUrl: rejects non-model URLs, proxy paths, non-HTTP", () => {
    assert.equal(isModelApiUrl("http://127.0.0.1:8199/v1/models"), false);
    assert.equal(isModelApiUrl("http://127.0.0.1:36485/__bili/plugin/manifest"), false);
    assert.equal(isModelApiUrl("http://127.0.0.1:36485/bili/http://127.0.0.1:8199/v1/messages"), false);
    assert.equal(isModelApiUrl("https://registry.npmjs.org/billion-context"), false);
    assert.equal(isModelApiUrl("https://example.com/v1/messages/count_tokens"), false);
    assert.equal(isModelApiUrl("file:///tmp/v1/messages"), false);
    assert.equal(isModelApiUrl("not a url"), false);
    assert.equal(isModelApiUrl("https://api.anthropic.com/v1/messages/count_tokens"), false);
    // Google wire: only the three methods the proxy core prepares count.
    // Model listing, unprepared methods (:predict) and case drift stay direct.
    assert.equal(isModelApiUrl("http://127.0.0.1:8317/v1beta/models/gemini-pro"), false);
    assert.equal(isModelApiUrl("http://127.0.0.1:8317/v1beta/models/gemini-pro:predict"), false);
    assert.equal(isModelApiUrl("http://127.0.0.1:8317/v1beta/models/gemini-pro:generatecontent"), false);
    assert.equal(isModelApiUrl("http://127.0.0.1:18787/bili/http://127.0.0.1:8317/v1beta/models/m:generateContent"), false);
});

function fakeFetch(sink: string[]) {
    return (async (input: string | URL | Request, _init?: RequestInit) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

interface RecordedCall {
    url: string;
    headers: Record<string, string>;
    at: number;
}

function fakeFetchRecordingHeaders(sink: RecordedCall[]) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        const src = init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined;
        const headers: Record<string, string> = {};
        if (src !== undefined) for (const [k, v] of new Headers(src).entries()) headers[k] = v;
        sink.push({ url, headers, at: Date.now() });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

async function withPatchRecording<T>(
    state: NativeInterceptState,
    fn: (fetch: typeof globalThis.fetch) => Promise<T>,
): Promise<{ sink: RecordedCall[]; result: T }> {
    const saved = globalThis.fetch;
    _resetForTest();
    const sink: RecordedCall[] = [];
    globalThis.fetch = fakeFetchRecordingHeaders(sink);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const result = await fn(globalThis.fetch);
        return { sink, result };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

async function withPatch<T>(state: NativeInterceptState, fn: (fetch: typeof globalThis.fetch) => Promise<T>): Promise<{ sink: string[]; result: T }> {
    const saved = globalThis.fetch;
    _resetForTest();
    const sink: string[] = [];
    globalThis.fetch = fakeFetch(sink);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const result = await fn(globalThis.fetch);
        return { sink, result };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

test("install: rewrites model URLs once ready", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { sink } = await withPatch(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("install: rewrites Google-wire model URLs through the proxy (#2493)", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40006", ready: Promise.resolve("http://127.0.0.1:40006") };
    const { sink } = await withPatch(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8317/v1beta/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40006/bili/http://127.0.0.1:8317/v1beta/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse"]);
});

test("install: already-routed Google-wire /bili/ request gets plugin headers re-stamped (#2493)", async () => {
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40007",
        ready: Promise.resolve("http://127.0.0.1:40007"),
        headersFor: () => ({ "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "session-g" }),
    };
    const { sink } = await withPatchRecording(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:40007/bili/http://127.0.0.1:8317/v1beta/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.equal(sink.length, 1);
    assert.equal(sink[0].url, "http://127.0.0.1:40007/bili/http://127.0.0.1:8317/v1beta/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse");
    assert.equal(sink[0].headers["x-bili-plugin"], "dsh");
    assert.equal(sink[0].headers["x-bili-plugin-conversation"], "session-g");
});

test("install: waits for a not-yet-ready proxy before rewriting", async () => {
    let release: (v: string | undefined) => void = () => {};
    const ready = new Promise<string | undefined>((r) => {
        release = r;
    });
    const state: NativeInterceptState = { origin: undefined, ready, readyTimeoutMs: 5000 };
    const { sink } = await withPatch(state, async (fetch) => {
        const pending = fetch("http://127.0.0.1:8199/v1/messages");
        await new Promise((r) => setTimeout(r, 20));
        release("http://127.0.0.1:40002");
        const res = await pending;
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40002/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("install: holds the first model request until toolsReady, then stamps (#1268)", async () => {
    let releaseTools: () => void = () => {};
    const toolsReady = new Promise<void>((r) => {
        releaseTools = r;
    });
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40003",
        ready: Promise.resolve("http://127.0.0.1:40003"),
        toolsReady,
        headersFor: () => ({ "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "session-1" }),
    };
    let releasedAt = 0;
    const { sink } = await withPatchRecording(state, async (fetch) => {
        const pending = fetch("http://127.0.0.1:8199/v1/messages");
        await new Promise((r) => setTimeout(r, 30));
        releaseTools();
        releasedAt = Date.now();
        const res = await pending;
        assert.equal(res.status, 200);
    });
    assert.equal(sink.length, 1);
    assert.ok(sink[0].at >= releasedAt - 5, "request held until toolsReady resolved (sent only after release)");
    assert.equal(sink[0].url, "http://127.0.0.1:40003/bili/http://127.0.0.1:8199/v1/messages");
    assert.equal(sink[0].headers["x-bili-plugin"], "dsh");
    assert.equal(sink[0].headers["x-bili-plugin-conversation"], "session-1");
});

test("install: beforeSend runs after the tools gate and before headersFor on rewrites (#2399)", async () => {
    const order: string[] = [];
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40004",
        ready: Promise.resolve("http://127.0.0.1:40004"),
        toolsReady: Promise.resolve(),
        headersFor: () => {
            order.push("headersFor");
            return { "x-bili-plugin": "dsh" };
        },
        beforeSend: async () => {
            order.push("beforeSend");
        },
    };
    const { sink } = await withPatchRecording(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", body: "{}" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(order, ["beforeSend", "headersFor"]);
    assert.equal(sink.length, 1);
    assert.equal(sink[0].headers["x-bili-plugin"], "dsh");
});

test("install: a throwing beforeSend never breaks the request (#2399)", async () => {
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40005",
        ready: Promise.resolve("http://127.0.0.1:40005"),
        beforeSend: async () => {
            throw new Error("adoption exploded");
        },
    };
    const { sink } = await withPatch(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8199/v1/chat/completions", { method: "POST", body: "{}" });
        assert.equal(res.status, 200);
    });
    assert.equal(sink.length, 1);
});

test("install: routed /bili/ model URLs also await beforeSend before stamping (#2399)", async () => {
    const order: string[] = [];
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40006",
        ready: Promise.resolve("http://127.0.0.1:40006"),
        toolsReady: Promise.resolve(),
        headersFor: () => {
            order.push("headersFor");
            return { "x-bili-plugin": "dsh" };
        },
        beforeSend: async () => {
            order.push("beforeSend");
        },
    };
    const { sink } = await withPatchRecording(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:40006/bili/http://127.0.0.1:8199/v1/messages", { method: "POST", body: "{}" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(order, ["beforeSend", "headersFor"]);
    assert.equal(sink.length, 1);
    assert.equal(sink[0].headers["x-bili-plugin"], "dsh");
});

test("install: toolsReady timeout falls back to wire mode; later requests stamp (#1268)", async () => {
    let readyFlag = false;
    const toolsReady = new Promise<void>((r) => {
        setTimeout(() => {
            readyFlag = true;
            r();
        }, 150);
    });
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40004",
        ready: Promise.resolve("http://127.0.0.1:40004"),
        toolsReady,
        readyTimeoutMs: 40,
        headersFor: () => (readyFlag ? { "x-bili-plugin": "dsh" } : undefined),
    };
    const { sink } = await withPatchRecording(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        await new Promise((r) => setTimeout(r, 160));
        const res2 = await fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res2.status, 200);
    });
    assert.equal(sink.length, 2);
    assert.equal(sink[0].headers["x-bili-plugin"], undefined, "gate timed out — first request un-stamped (wire mode)");
    assert.equal(sink[1].headers["x-bili-plugin"], "dsh", "registration landed — later request stamped");
});

test("install: routed /bili/ model URLs also hold for toolsReady before stamping (#1268)", async () => {
    let releaseTools: () => void = () => {};
    const toolsReady = new Promise<void>((r) => {
        releaseTools = r;
    });
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40005",
        ready: Promise.resolve("http://127.0.0.1:40005"),
        toolsReady,
        headersFor: () => ({ "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "session-9" }),
    };
    let releasedAt = 0;
    const { sink } = await withPatchRecording(state, async (fetch) => {
        const pending = fetch("http://127.0.0.1:40005/bili/http://127.0.0.1:8199/v1/messages");
        await new Promise((r) => setTimeout(r, 30));
        releaseTools();
        releasedAt = Date.now();
        const res = await pending;
        assert.equal(res.status, 200);
    });
    assert.equal(sink.length, 1);
    assert.ok(sink[0].at >= releasedAt - 5, "routed request held until toolsReady resolved (sent only after release)");
    assert.equal(sink[0].url, "http://127.0.0.1:40005/bili/http://127.0.0.1:8199/v1/messages");
    assert.equal(sink[0].headers["x-bili-plugin"], "dsh");
    assert.equal(sink[0].headers["x-bili-plugin-conversation"], "session-9");
});

test("install: falls back to direct when the bootstrap fails/times out", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), readyTimeoutMs: 50 };
    const { sink } = await withPatch(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:8199/v1/messages"]);
});

test("install: leaves non-model URLs untouched", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { sink } = await withPatch(state, async (fetch) => {
        await fetch("https://registry.npmjs.org/billion-context");
        await fetch("http://127.0.0.1:40001/__bili/plugin/manifest");
    });
    assert.deepEqual(sink, ["https://registry.npmjs.org/billion-context", "http://127.0.0.1:40001/__bili/plugin/manifest"]);
});

test("install: non-model-API URLs fire onUnroutedModelUrl so direct sends are visible (#1290)", async () => {
    const unrouted: string[] = [];
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        onUnroutedModelUrl: (u) => { unrouted.push(u); },
    };
    const { sink } = await withPatch(state, async (fetch) => {
        // A third-party plugin's custom wire (commandcode's Go plan, POST) —
        // not a recognized model endpoint, so it goes direct AND is reported.
        await fetch("https://api.commandcode.example/alpha/generate", { method: "POST" });
        await fetch("https://api.commandcode.example/alpha/generate", { method: "POST" });
        // A real model endpoint — routed, never reported as unrouted.
        await fetch("http://127.0.0.1:8199/v1/messages");
        // Bili's own control plane — direct by design, never reported either.
        await fetch("http://127.0.0.1:40001/__bili/plugin/manifest");
        await fetch("http://127.0.0.1:40001/bili/openai/http://127.0.0.1:9/alpha/generate");
    });
    assert.ok(sink.includes("https://api.commandcode.example/alpha/generate"), "custom wire sent direct");
    assert.ok(sink.includes("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"), "model endpoint routed");
    assert.equal(unrouted.length, 2, "hook fires per unrouted request (host dedups)");
    for (const u of unrouted) assert.ok(u.endsWith("/alpha/generate"), `unexpected unrouted: ${u}`);
});

test("install: only POST fires onUnroutedModelUrl — registry/catalog/git GETs stay silent (#1657)", async () => {
    const unrouted: string[] = [];
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        onUnroutedModelUrl: (u) => { unrouted.push(u); },
    };
    const { sink } = await withPatch(state, async (fetch) => {
        // dsh plugin-manager boot traffic (#1657 repro): npm registry / CDN
        // catalog / git refs — all pass through direct and UNREPORTED.
        await fetch("https://mirrors.cloud.tencent.com/npm/dshmarket/latest");
        await fetch("https://cdn.jsdelivr.net/gh/duhu2000/dsh-mcp-connector-registry@main/catalog.json");
        await fetch("https://github.com/142475/dsh-pocket.git/info/refs");
        await fetch("https://api.github.com/repos/duhu2000/dsh-mcp-connector/releases/latest");
        // Non-model custom wire via other methods — also unreported.
        await fetch("https://api.commandcode.example/alpha/generate");
        await fetch("https://api.commandcode.example/alpha/generate", { method: "HEAD" });
        // The same custom wire as POST — the #1290 case, still reported.
        // Lowercase init method and Request-object method both count.
        await fetch("https://api.commandcode.example/alpha/generate", { method: "post" });
        await fetch(new Request("https://api.commandcode.example/alpha/generate", { method: "POST" }));
    });
    assert.equal(sink.length, 8, "every request still passes through direct");
    assert.deepEqual(
        unrouted,
        ["https://api.commandcode.example/alpha/generate", "https://api.commandcode.example/alpha/generate"],
        "only POSTs fire the hook",
    );
});

test("install: proxy-origin URLs are never re-proxied (self guard)", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { sink } = await withPatch(state, async (fetch) => {
        await fetch("http://127.0.0.1:40001/v1/messages");
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/v1/messages"]);
});

test("install: TypeError triggers one respawn + retry", async () => {
    const calls: string[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    let failNext = true;
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        if (failNext) {
            failNext = false;
            throw new TypeError("fetch failed");
        }
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001"), respawn: undefined };
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        state.respawn = () => {
            state.origin = "http://127.0.0.1:40009";
            state.ready = Promise.resolve("http://127.0.0.1:40009");
            return Promise.resolve("http://127.0.0.1:40009");
        };
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        assert.deepEqual(calls, [
            "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
            "http://127.0.0.1:40009/bili/http://127.0.0.1:8199/v1/messages",
        ]);
        assert.equal(state.origin, "http://127.0.0.1:40009");
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("install: second install is a no-op while active", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const saved = globalThis.fetch;
    _resetForTest();
    globalThis.fetch = fakeFetch([]);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        assert.equal(installNativeFetchIntercept(state), false);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("install: Request-object input is re-dispatched with the rewritten URL", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { sink } = await withPatch(state, async (fetch) => {
        const req = new Request("http://127.0.0.1:8199/v1/messages", { method: "POST", body: "{}" });
        const res = await fetch(req);
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("install: failed respawn degrades to a direct send and fires onGiveUp", async () => {
    const calls: string[] = [];
    const dispatches: string[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    let failNext = true;
    let respawns = 0;
    let giveUps = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        if (failNext) {
            failNext = false;
            throw new TypeError("fetch failed");
        }
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        respawn: () => {
            respawns += 1;
            return Promise.resolve(undefined);
        },
        onGiveUp: () => {
            giveUps += 1;
        },
        onDispatch: (_url, action) => dispatches.push(action),
    };
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const res = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        assert.deepEqual(calls, [
            "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
            "http://127.0.0.1:8199/v1/messages",
        ]);
        assert.deepEqual(dispatches, ["rewrite", "direct"]);
        assert.equal(state.origin, undefined);
        assert.equal(respawns, 1);
        assert.equal(giveUps, 1);
        // The degrade is permanent for the session: later model requests go
        // direct without re-entering the respawn path.
        const res2 = await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.equal(res2.status, 200);
        assert.equal(calls[2], "http://127.0.0.1:8199/v1/messages");
        assert.deepEqual(dispatches, ["rewrite", "direct", "direct"]);
        assert.equal(respawns, 1);
        assert.equal(giveUps, 1);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("install: a consumed-body Request throws without triggering a respawn", async () => {
    const saved = globalThis.fetch;
    _resetForTest();
    let respawnCalls = 0;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        respawn: () => {
            respawnCalls += 1;
            return Promise.resolve("http://127.0.0.1:40001");
        },
    };
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const req = new Request("http://127.0.0.1:8199/v1/messages", {
            method: "POST",
            body: ReadableStream.from([new TextEncoder().encode("{}")]),
            duplex: "half",
        } as RequestInit & { duplex?: string });
        await req.arrayBuffer();
        await assert.rejects(() => globalThis.fetch(req), TypeError);
        assert.equal(respawnCalls, 0);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("routedBiliModelUrl: extracts the embedded model URL from /bili/ form", async () => {
    const { routedBiliModelUrl } = await import("../src/agent/native-intercept.ts");
    assert.equal(routedBiliModelUrl("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"), "http://127.0.0.1:8199/v1/messages");
    assert.equal(routedBiliModelUrl("http://127.0.0.1:40001/bili/https://api.anthropic.com/v1/messages?beta=1"), "https://api.anthropic.com/v1/messages?beta=1");
    // Google-wire embedded target (#2493): header re-stamping applies too.
    assert.equal(
        routedBiliModelUrl("http://127.0.0.1:40001/bili/http://127.0.0.1:8317/v1beta/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse"),
        "http://127.0.0.1:8317/v1beta/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse",
    );
    // non-model embedded targets and plugin endpoints do not count
    assert.equal(routedBiliModelUrl("http://127.0.0.1:40001/bili/https://registry.npmjs.org/pkg"), undefined);
    assert.equal(routedBiliModelUrl("http://127.0.0.1:40001/__bili/plugin/manifest"), undefined);
    assert.equal(routedBiliModelUrl("http://127.0.0.1:8199/v1/messages"), undefined);
});

test("install: headersFor stamps an already-routed /bili/ request without rewriting (#941)", async () => {
    const saved = globalThis.fetch;
    _resetForTest();
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        const headers: Record<string, string> = {};
        if (init?.headers instanceof Headers) {
            init.headers.forEach((v, k) => (headers[k] = v));
        } else if (Array.isArray(init?.headers)) {
            for (const [k, v] of init?.headers as Array<[string, string]>) headers[k] = v;
        } else if (init?.headers && typeof init.headers === "object") {
            Object.assign(headers, init.headers as Record<string, string>);
        }
        seen.push({ url, headers });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        const state: NativeInterceptState = {
            origin: "http://127.0.0.1:40001",
            ready: Promise.resolve("http://127.0.0.1:40001"),
            headersFor: () => ({ "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "session-1" }),
        };
        assert.equal(installNativeFetchIntercept(state), true);
        await globalThis.fetch("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages", { method: "POST", headers: { "content-type": "application/json" } });
        assert.equal(seen.length, 1);
        assert.equal(seen[0].url, "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages");
        assert.equal(seen[0].headers["x-bili-plugin"], "dsh");
        assert.equal(seen[0].headers["x-bili-plugin-conversation"], "session-1");
        assert.equal(seen[0].headers["content-type"], "application/json");
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("install: attach mode rewrites to the attach origin and stamps (#809 + #941)", async () => {
    const saved = globalThis.fetch;
    _resetForTest();
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        const headers: Record<string, string> = {};
        const h = init?.headers;
        if (h instanceof Headers) {
            h.forEach((v, k) => (headers[k] = v));
        } else if (Array.isArray(h)) {
            for (const [k, v] of h as Array<[string, string]>) headers[k] = v;
        } else if (h && typeof h === "object") {
            Object.assign(headers, h as Record<string, string>);
        } else if (input instanceof Request) {
            input.headers.forEach((v, k) => (headers[k] = v));
        }
        seen.push({ url, headers });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        const state: NativeInterceptState = {
            origin: "http://127.0.0.1:40001",
            ready: Promise.resolve("http://127.0.0.1:40001"),
            attach: true,
            headersFor: (url) => (url.includes("8199") ? { "x-bili-plugin": "dsh" } : undefined),
        };
        assert.equal(installNativeFetchIntercept(state), true);
        // plain-object init headers
        await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", headers: { "x-keep": "1" } });
        // Headers-instance init headers
        await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", headers: new Headers({ "x-keep": "2" }) });
        // entries-array init headers
        await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", headers: [["x-keep", "3"]] });
        // no init at all
        await globalThis.fetch("http://127.0.0.1:8199/v1/messages");
        assert.deepEqual(
            seen.map((s) => s.url),
            [
                "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
                "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
                "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
                "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
            ],
        );
        for (const [i, s] of seen.entries()) {
            assert.equal(s.headers["x-bili-plugin"], "dsh", `call ${i}`);
            if (i < 3) assert.equal(s.headers["x-keep"], String(i + 1), `call ${i}`);
        }
        // headersFor undefined → no plugin headers, rewrite still happens
        await globalThis.fetch("http://127.0.0.1:9000/v1/messages");
        assert.equal(seen[4].url, "http://127.0.0.1:40001/bili/http://127.0.0.1:9000/v1/messages");
        assert.equal(seen[4].headers["x-bili-plugin"], undefined);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("install: spawn mode stamps headers on the rewritten request (#941)", async () => {
    const saved = globalThis.fetch;
    _resetForTest();
    let headerDump = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        headerDump = h.get("x-bili-plugin") ?? "";
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        const state: NativeInterceptState = {
            origin: "http://127.0.0.1:40001",
            ready: Promise.resolve("http://127.0.0.1:40001"),
            headersFor: () => ({ "x-bili-plugin": "dsh" }),
        };
        assert.equal(installNativeFetchIntercept(state), true);
        await globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", headers: { "content-type": "application/json" } });
        assert.equal(headerDump, "dsh");
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("#1117 takeoverGate: unattributed model URL sends direct, never rewritten", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001"), takeoverGate: () => false };
    const { sink } = await withPatch(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:8199/v1/messages"]);
});

test("#1117 takeoverGate: attributed model URL still rewrites", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001"), takeoverGate: () => true };
    const { sink } = await withPatch(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("#1117 takeoverGate: unattributed /bili/-routed URL is marked x-bili-passthrough", async () => {
    const saved = globalThis.fetch;
    _resetForTest();
    let passthrough = "";
    let pluginHeader = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        passthrough = h.get("x-bili-passthrough") ?? "";
        pluginHeader = h.get("x-bili-plugin") ?? "";
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        const state: NativeInterceptState = {
            origin: "http://127.0.0.1:40001",
            ready: Promise.resolve("http://127.0.0.1:40001"),
            takeoverGate: () => false,
            headersFor: () => ({ "x-bili-plugin": "dsh" }),
        };
        assert.equal(installNativeFetchIntercept(state), true);
        const res = await globalThis.fetch("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
        assert.equal(passthrough, "1", "unattributed routed request carries the passthrough marker");
        assert.equal(pluginHeader, "", "plugin headers are not stamped on an unattributed request");
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("#1117 takeoverGate: attributed /bili/-routed URL keeps plugin headers (no marker)", async () => {
    const saved = globalThis.fetch;
    _resetForTest();
    let passthrough = "";
    let pluginHeader = "";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        passthrough = h.get("x-bili-passthrough") ?? "";
        pluginHeader = h.get("x-bili-plugin") ?? "";
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        const state: NativeInterceptState = {
            origin: "http://127.0.0.1:40001",
            ready: Promise.resolve("http://127.0.0.1:40001"),
            takeoverGate: () => true,
            headersFor: () => ({ "x-bili-plugin": "dsh" }),
        };
        assert.equal(installNativeFetchIntercept(state), true);
        const res = await globalThis.fetch("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
        assert.equal(passthrough, "");
        assert.equal(pluginHeader, "dsh");
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("#1117 takeoverGate: round-1 wire mode is preserved (attributed, no headers yet → still rewrites)", async () => {
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        takeoverGate: () => true,
        headersFor: () => undefined,
    };
    const { sink } = await withPatch(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

// #1130: a settings overlay bakes the proxy origin into /bili/ URLs, so when
// the owning launcher of a SHARED proxy exits mid-session those baked URLs
// keep hitting the dead port — permanently, until this recovery lands.

test("install: routed /bili/ request against a dead attach origin recovers and reroutes (#1130)", async () => {
    const calls: string[] = [];
    const dispatches: string[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        if (url.startsWith("http://127.0.0.1:40001/")) throw new TypeError("fetch failed");
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    let respawns = 0;
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        attach: true,
        respawn: () => {
            respawns += 1;
            state.origin = "http://127.0.0.1:40009";
            state.ready = Promise.resolve("http://127.0.0.1:40009");
            return Promise.resolve("http://127.0.0.1:40009");
        },
        onDispatch: (_url, action) => dispatches.push(action),
    };
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const res = await globalThis.fetch("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        assert.deepEqual(calls, [
            "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
            "http://127.0.0.1:40009/bili/http://127.0.0.1:8199/v1/messages",
        ]);
        assert.deepEqual(dispatches, ["self", "retry"]);
        assert.equal(respawns, 1);
        assert.equal(state.origin, "http://127.0.0.1:40009");
        // The overlay keeps baking the OLD origin — subsequent requests are
        // rerouted pre-emptively without paying another connection failure.
        const res2 = await globalThis.fetch("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages");
        assert.equal(res2.status, 200);
        assert.equal(calls[2], "http://127.0.0.1:40009/bili/http://127.0.0.1:8199/v1/messages");
        assert.deepEqual(dispatches, ["self", "retry", "retry"]);
        assert.equal(respawns, 1);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

// #2496: a network blip against a ROUTED /bili/ URL whose recovery lands back
// on the SAME origin used to be treated as give-up — the request went direct
// AND onGiveUp fired (omp/pi lanes delete BILLION_CONTEXT_PROXY there, right
// after bootstrap republished it), so the proxy variable stayed unset for the
// whole host process even though the proxy never died.
test("install: routed /bili/ transient failure recovering to the same origin retries there, no give-up (#2496)", async () => {
    const calls: string[] = [];
    const dispatches: string[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    let failures = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        if (url.startsWith("http://127.0.0.1:40001/") && failures < 1) {
            failures += 1;
            throw new TypeError("fetch failed");
        }
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    let respawns = 0;
    let giveUps = 0;
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        attach: true,
        respawn: () => {
            respawns += 1;
            // The attached proxy is still healthy — recovery lands on the SAME origin.
            state.origin = "http://127.0.0.1:40001";
            state.ready = Promise.resolve("http://127.0.0.1:40001");
            return Promise.resolve("http://127.0.0.1:40001");
        },
        onGiveUp: () => {
            giveUps += 1;
        },
        onDispatch: (_url, action) => dispatches.push(action),
    };
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const res = await globalThis.fetch("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        assert.deepEqual(calls, [
            "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
            "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
        ]);
        assert.deepEqual(dispatches, ["self", "retry"]);
        assert.equal(respawns, 1);
        assert.equal(giveUps, 0, "same-origin recovery is not a loss — onGiveUp must not fire");
        assert.equal(state.origin, "http://127.0.0.1:40001");
        // The baked URL stays valid as-is — no replaced-origin record, so the
        // next request goes straight through without another reroute.
        const res2 = await globalThis.fetch("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages");
        assert.equal(res2.status, 200);
        assert.equal(calls[2], "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages");
        assert.deepEqual(dispatches, ["self", "retry", "self"]);
        assert.equal(respawns, 1);
        assert.equal(giveUps, 0);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("install: routed /bili/ request with no respawn degrades to a direct send (#1130)", async () => {
    const calls: string[] = [];
    const dispatches: string[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        if (url.startsWith("http://127.0.0.1:40001/")) throw new TypeError("fetch failed");
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    let giveUps = 0;
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        attach: true,
        onGiveUp: () => {
            giveUps += 1;
        },
        onDispatch: (_url, action) => dispatches.push(action),
    };
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const res = await globalThis.fetch("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        assert.deepEqual(calls, [
            "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
            "http://127.0.0.1:8199/v1/messages",
        ]);
        assert.deepEqual(dispatches, ["self", "direct"]);
        assert.equal(giveUps, 1);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});

test("install: routed /bili/ request whose recovery also fails degrades to direct + onGiveUp (#1130)", async () => {
    const calls: string[] = [];
    const dispatches: string[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        if (url.startsWith("http://127.0.0.1:40001/")) throw new TypeError("fetch failed");
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    let respawns = 0;
    let giveUps = 0;
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        attach: true,
        respawn: () => {
            respawns += 1;
            return Promise.resolve(undefined);
        },
        onGiveUp: () => {
            giveUps += 1;
        },
        onDispatch: (_url, action) => dispatches.push(action),
    };
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const res = await globalThis.fetch("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        assert.deepEqual(calls, [
            "http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages",
            "http://127.0.0.1:8199/v1/messages",
        ]);
        assert.deepEqual(dispatches, ["self", "direct"]);
        assert.equal(respawns, 1);
        assert.equal(giveUps, 1);
        assert.equal(state.origin, undefined);
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }

});

// #1365: routed-channel evidence — the fetch patch must record where this
// process's model traffic actually goes BEFORE any gate await, so attach
// recovery can see it even when the first request lands while tool
// registration is still pending.

test("#1365 noteRoutedOrigin: records origin, sticky per origin, hook fires on transitions only", () => {
    const seen: string[] = [];
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), onRoutedOriginObserved: (o) => seen.push(o) };
    noteRoutedOrigin(state, "http://127.0.0.1:8787/bili/https://api.anthropic.com/v1/messages");
    assert.equal(state.routedOrigin, "http://127.0.0.1:8787");
    noteRoutedOrigin(state, "http://127.0.0.1:8787/bili/http://127.0.0.1:8199/v1/chat/completions");
    assert.deepEqual(seen, ["http://127.0.0.1:8787"], "same-origin re-observation is a no-op");
    noteRoutedOrigin(state, "http://127.0.0.1:9999/bili/http://127.0.0.1:8199/v1/messages");
    assert.equal(state.routedOrigin, "http://127.0.0.1:9999", "last observation wins");
    assert.deepEqual(seen, ["http://127.0.0.1:8787", "http://127.0.0.1:9999"]);
    noteRoutedOrigin(state, "not a url");
    assert.equal(state.routedOrigin, "http://127.0.0.1:9999", "malformed input ignored");
    assert.equal(seen.length, 2);
});

test("#1365 pre-gate proof: first routed request records evidence while toolsReady is still pending", async () => {
    let releaseTools: () => void = () => {};
    const toolsReady = new Promise<void>((r) => { releaseTools = r; });
    const state: NativeInterceptState = {
        origin: undefined,
        ready: new Promise<string | undefined>(() => {}),
        toolsReady,
        readyTimeoutMs: 150,
    };
    const { sink } = await withPatchRecording(state, async (fetch) => {
        const pending = fetch("http://127.0.0.1:8787/bili/https://api.anthropic.com/v1/messages");
        // gate deliberately held — if evidence were recorded AFTER the gate,
        // routedOrigin would be undefined here and observeRoutedOrigin would
        // burn the full grace window → spawn fallback → the #1365 split-brain
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(state.routedOrigin, "http://127.0.0.1:8787", "evidence recorded before any gate await");
        releaseTools();
        const res = await pending;
        assert.equal(res.status, 200);
    });
    assert.equal(sink.length, 1);
    assert.equal(sink[0].url, "http://127.0.0.1:8787/bili/https://api.anthropic.com/v1/messages");
});

test("#1365 unattributed /bili/ riders never record evidence (#1117 boundary)", async () => {
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        takeoverGate: () => false,
    };
    await withPatch(state, async (fetch) => {
        const res = await fetch("http://127.0.0.1:8787/bili/http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
    });
    assert.equal(state.routedOrigin, undefined, "another plugin's channel does not pin ours");
});

test("#1365 observeRoutedOrigin: pre-set evidence skips the window; expiry clean; mid-window arrival ends early", async () => {
    const saved = process.env.BILI_ATTACH_EVIDENCE_GRACE_MS;
    try {
        process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "60000";
        const withEvidence: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), routedOrigin: "http://127.0.0.1:8787" };
        const fast = await Promise.race([
            observeRoutedOrigin(withEvidence),
            new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000)),
        ]);
        assert.equal(fast, "http://127.0.0.1:8787", "pre-set evidence must not pay the (60s) grace window");

        process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "50";
        const empty: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
        const t0 = Date.now();
        assert.equal(await observeRoutedOrigin(empty), undefined, "no evidence within the window → legacy path");
        assert.ok(Date.now() - t0 >= 40, "no-evidence path waits out the window");

        process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "2000";
        const late: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined) };
        setTimeout(() => { late.routedOrigin = "http://127.0.0.1:9999"; }, 50);
        const t1 = Date.now();
        assert.equal(await observeRoutedOrigin(late), "http://127.0.0.1:9999", "mid-window arrival ends the wait early");
        assert.ok(Date.now() - t1 < 1500, "early return on mid-window evidence");
    } finally {
        if (saved === undefined) delete process.env.BILI_ATTACH_EVIDENCE_GRACE_MS;
        else process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = saved;
    }
});

// — #1957: a health verdict describes a PROCESS GENERATION, not a URL —
// A respawn puts a new process behind the same origin (lane port memory,
// #1723). Verdicts obtained before that boundary — cached or still in flight
// — must not steer routing for the replacement.

test("#1957 same-origin respawn: replacement is probed for real (stale negative verdict discarded)", async (t) => {
    let now = 100_000;
    t.mock.method(Date, "now", () => now);
    const origin = "http://127.0.0.1:18787";
    let online = true;
    let probes = 0;
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        origin,
        ready: Promise.resolve(origin),
        respawn: async () => {
            respawnCalls += 1;
            online = true;
            state.origin = origin;
            return origin;
        },
    };
    const resolve = createLiveOriginResolver(state, {
        probe: async () => { probes += 1; return online; },
        probeTtlMs: 2_000,
    });
    assert.equal(await resolve(), origin, "healthy hold fast-paths through the cached verdict");
    now += 2_001;
    online = false;
    const recovered = await resolve();
    assert.equal(respawnCalls, 1, "one respawn on death");
    assert.equal(recovered, origin, "post-recovery request must route to the respawned proxy");
    assert.equal(probes, 3, "replacement must be probed for real, not served from the stale negative cache");
    assert.equal(state.origin, origin);
});

test("#1957 new-origin respawn lands on the replacement's own origin", async (t) => {
    t.mock.method(Date, "now", () => 100_000);
    const dead = "http://127.0.0.1:1";
    const fresh = "http://127.0.0.1:2";
    const state: NativeInterceptState = {
        origin: dead,
        ready: Promise.resolve(dead),
        respawn: async () => { state.origin = fresh; return fresh; },
    };
    const resolve = createLiveOriginResolver(state, {
        probe: async (o: string) => o === fresh,
        probeTtlMs: 2_000,
    });
    assert.equal(await resolve(), fresh, "respawn lands on a different origin and passes its real probe");
    assert.equal(state.origin, fresh);
    assert.equal(await resolve(), fresh, "subsequent requests reuse the landed origin");
});

test("#1957 a replacement that fails its real probe degrades — the respawn URL is never trusted blindly", async (t) => {
    t.mock.method(Date, "now", () => 100_000);
    const origin = "http://127.0.0.1:18787";
    let giveUps = 0;
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        origin,
        ready: Promise.resolve(origin),
        onGiveUp: () => { giveUps += 1; },
        respawn: async () => { respawnCalls += 1; state.origin = origin; return origin; },
    };
    const resolve = createLiveOriginResolver(state, {
        probe: async () => false,
        probeTtlMs: 2_000,
    });
    assert.equal(await resolve(), undefined, "an unhealthy replacement must not be routed to");
    assert.equal(respawnCalls, 1);
    assert.equal(giveUps, 1, "onGiveUp fires so the host can surface the loss");
});

test("#1957 failed respawn: cooldown suppresses re-fire within the window", async (t) => {
    let now = 100_000;
    t.mock.method(Date, "now", () => now);
    const origin = "http://127.0.0.1:18787";
    let giveUps = 0;
    let respawnCalls = 0;
    const state: NativeInterceptState = {
        origin,
        ready: Promise.resolve(origin),
        onGiveUp: () => { giveUps += 1; },
        respawn: async () => { respawnCalls += 1; return undefined; },
    };
    const resolve = createLiveOriginResolver(state, {
        probe: async () => false,
        probeTtlMs: 2_000,
    });
    assert.equal(await resolve(), undefined);
    assert.equal(respawnCalls, 1);
    now += 5_000;
    assert.equal(await resolve(), undefined, "still degraded inside the cooldown");
    assert.equal(respawnCalls, 1, "cooldown bounds attempts to one per interval");
    assert.equal(giveUps, 1, "loss is reported once per observed loss, not per degraded request");
    now += 15_001;
    assert.equal(await resolve(), undefined, "replacement still absent after the cooldown");
    assert.equal(respawnCalls, 2, "cooldown elapsed → retry bootstrap");
});

test("#1957 steady-state verdict reuse survives the fix (#928)", async (t) => {
    let now = 100_000;
    t.mock.method(Date, "now", () => now);
    const origin = "http://127.0.0.1:18787";
    let probes = 0;
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const resolve = createLiveOriginResolver(state, {
        probe: async () => { probes += 1; return true; },
        probeTtlMs: 2_000,
    });
    for (let i = 0; i < 3; i++) assert.equal(await resolve(), origin);
    assert.equal(probes, 1, "steady-state requests ride the cached positive verdict");
    now += 2_001;
    assert.equal(await resolve(), origin, "after the TTL lapses a fresh probe confirms and routes");
    assert.equal(probes, 2);
});

test("#1957 a stale in-flight verdict cannot clobber a healthy same-origin replacement", async (t) => {
    t.mock.method(Date, "now", () => 100_000);
    const origin = "http://127.0.0.1:18787";
    let respawnCalls = 0;
    const gates: Array<(ok: boolean) => void> = [];
    const state: NativeInterceptState = {
        origin,
        ready: Promise.resolve(origin),
        respawn: async () => {
            respawnCalls += 1;
            state.origin = origin;   // replacement binds the SAME origin
            return origin;
        },
    };
    const resolve = createLiveOriginResolver(state, {
        probe: async () => new Promise<boolean>((res) => { gates.push(res); }),
        probeTtlMs: 2_000,
    });
    const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

    const first = resolve();
    const second = resolve();   // both hold the pre-respawn origin while probing
    assert.equal(gates.length, 2, "two concurrent in-flight probes");

    gates[0](false);   // caller 1 sees the OLD process dead
    await tick();      // → respawn fires, replacement lands on the same origin,
                       //   caller 1 starts its post-ready verification probe
    assert.equal(respawnCalls, 1);
    assert.equal(gates.length, 3, "caller 1 verifies the replacement for real");

    gates[1](false);   // caller 2's verdict arrives AFTER the boundary — stale
    await tick();      // it must be discarded, not acted on
    assert.equal(state.origin, origin, "stale verdict must not wipe the healthy replacement");
    assert.equal(respawnCalls, 1, "stale verdict must not trigger a redundant respawn");
    assert.ok(gates.length >= 4, "caller 2 must verify the current origin for real");

    gates[2](true);    // caller 1's verification: replacement is alive
    await tick();
    gates[3](true);    // caller 2's own verification of the current origin
    assert.equal(await first, origin);
    assert.equal(await second, origin, "caller 2 recovers through the shared ready");
});

// #2496 guard (PR #2581 review): a Request-object input whose body was
// DISTURBED by a failed send (the underlying fetch consumed it before
// throwing) is unrecoverable — `new Request(target, input)` on a used body
// throws a confusing "Body is unusable", and a retry/degrade would at best
// send garbage. The wrapper must surface the ORIGINAL failure instead of
// retrying, respawning, or degrading to a direct send.
test("install: routed /bili/ Request with a disturbed body fails with the original error — no retry, no respawn, no give-up (#2496)", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    const dispatches: string[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    let failures = 0;
    let disturb = true; // phase 1 disturbs the body before failing; phase 2 fails clean
    globalThis.fetch = (async (input: string | URL | Request) => {
        const req = input instanceof Request ? input : undefined;
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        calls.push(url);
        if (req !== undefined) {
            // Record the body BEFORE deciding the outcome (clone-then-read
            // keeps the original stream untouched for a potential retry).
            bodies.push(await req.clone().text());
        }
        if (url.startsWith("http://127.0.0.1:40001/") && failures < 1) {
            failures += 1;
            if (req !== undefined && disturb) {
                // Disturb the body — consume it, then fail. The wrapper's
                // retry path (`new Request(target, input)`) can no longer
                // rebuild a sendable request from this input.
                await req.text();
            }
            throw new TypeError("fetch failed");
        }
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    let respawns = 0;
    let giveUps = 0;
    const state: NativeInterceptState = {
        origin: "http://127.0.0.1:40001",
        ready: Promise.resolve("http://127.0.0.1:40001"),
        attach: true,
        respawn: () => {
            respawns += 1;
            state.origin = "http://127.0.0.1:40001";
            state.ready = Promise.resolve("http://127.0.0.1:40001");
            return Promise.resolve("http://127.0.0.1:40001");
        },
        onGiveUp: () => {
            giveUps += 1;
        },
        onDispatch: (_url, action) => dispatches.push(action),
    };
    const payload = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] });
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        // Phase 1: disturbed body — the original failure must bubble out.
        const disturbed = new Request("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
        });
        await assert.rejects(
            globalThis.fetch(disturbed),
            (err: unknown) => err instanceof TypeError && err.message === "fetch failed",
            "the original 'fetch failed' must surface — not a confusing 'Body is unusable'",
        );
        assert.equal(calls.length, 1, "no retry may be attempted on a disturbed body");
        assert.deepEqual(dispatches, ["self"]);
        assert.equal(respawns, 0, "a disturbed body is not a proxy death — no respawn");
        assert.equal(giveUps, 0, "no give-up side effects");

        // Phase 2: UN-disturbed Request body — the same blip retries and the
        // forwarded body is byte-identical to what the caller handed in.
        failures = 0; // re-arm the one-shot failure for the second phase
        disturb = false; // phase 2 fails WITHOUT disturbing the body
        const intact = new Request("http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
        });
        const res = await globalThis.fetch(intact);
        assert.equal(res.status, 200, "intact body retries normally");
        assert.deepEqual(dispatches, ["self", "self", "retry"]);
        assert.equal(respawns, 1);
        assert.equal(giveUps, 0);
        assert.equal(bodies.length, 3);
        assert.equal(bodies[0], payload, "first attempt carried the caller's body");
        assert.equal(bodies[2], payload, "retry carried the SAME body bytes — no empty/garbled re-send");
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
});
