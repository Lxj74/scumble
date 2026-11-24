// The ONNX runtime's sessions (electron/main/onnx/runtime.js) with fake sessions, no model and no onnxruntime-node:
// node tools/onnx_runtime_test.js. Review finding main-net/matting-gpu-concurrent-session-dispose: jobs run side by
// side in the helper process and share one session per file, so a release asked while a run is in flight (the matting
// model's after its own GPU run, a device change, Free) waits for the last run; with no run in flight it is at once.
"use strict";

const path = require("node:path");
const { Runtime, _tracked } = require(path.join(__dirname, "..", "electron", "main", "onnx", "runtime.js"));

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A session whose run takes `ms` and fails once released, as onnxruntime-node's does after dispose. */
function fakeSession(ms) {
    const s = { released: 0, runs: 0 };
    s.run = async () => {
        s.runs++;
        await sleep(ms);
        if (s.released) throw new Error("session disposed");
        return { out: s.runs };
    };
    s.release = async () => { s.released++; };
    return s;
}

async function main() {
    const rt = new Runtime();
    const put = (file, ms) => { const e = _tracked({ session: fakeSession(ms), provider: "dml", file }); rt.sessions.set(file, e); return e; };

    // two runs on one session; the first one's release (Matting.run's on the GPU) comes while the second still runs
    let e = put("m.onnx", 40);
    const second = e.session.run({});
    const first = (async () => { await sleep(5); return rt.release("m.onnx"); })();
    let err = null;
    try { await second; } catch (x) { err = x; }
    await first;
    check("a release during a run waits for it: the run answers", !err, err && err.message);
    check("... and the session is released once, after the run", e.session.released === 1 && e.busy === 0, JSON.stringify({ released: e.session.released, busy: e.busy }));
    check("... the file is out of the map at once (the next use loads it again)", !rt.sessions.has("m.onnx"));

    // no run in flight: released at once
    e = put("n.onnx", 10);
    await rt.release("n.onnx");
    check("a release with no run in flight is at once", e.session.released === 1);

    // Free during two runs on two files: both answer, both released after
    const a = put("a.onnx", 30), b = put("b.onnx", 50);
    const runs = [a.session.run({}), b.session.run({}), b.session.run({})];
    await sleep(5);
    await rt.free();
    const outs = await Promise.allSettled(runs);
    check("Free during runs: every run answers", outs.every((o) => o.status === "fulfilled"), JSON.stringify(outs.map((o) => o.status)));
    check("... and each session is released once, after its last run", a.session.released === 1 && b.session.released === 1 && a.busy === 0 && b.busy === 0, JSON.stringify([a.session.released, b.session.released]));

    // a run that fails still counts down
    e = put("f.onnx", 5);
    const inner = e.session;
    const failing = _tracked({ session: { run: async () => { await sleep(10); throw new Error("bad input"); }, release: async () => { inner.released++; } }, provider: "dml", file: "f.onnx" });
    rt.sessions.set("f.onnx", failing);
    const pf = failing.session.run({}).catch(() => null);
    await sleep(2);
    await rt.release("f.onnx");
    await pf;
    check("a run that throws still lets the release through", inner.released === 1 && failing.busy === 0, JSON.stringify({ released: inner.released, busy: failing.busy }));

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
