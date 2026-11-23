// Relight's runtime state alone (renderer/editor/inpaint_relightstate.js, item 77 step 2): track keeps a job until it
// settles (a rejected one too), the march count never goes below zero, hide leaves layers out until every read that
// hid them released, a release twice is one release. Plain Node: `node tools/relightstate_test.js`.
"use strict";

const path = require("path");
const { pathToFileURL } = require("url");

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
    checks++;
    if (!ok) failures++;
    console.log(`[${ok ? "ok" : "FAIL"}] ${name}${detail ? ": " + detail : ""}`);
}

(async () => {
    const { RelightState } = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_relightstate.js")).href);
    const r = new RelightState();
    check("fresh: no jobs, no marches, nothing hidden", r.jobs.size === 0 && r.marches === 0 && r.hidden.size === 0 && r.pending().length === 0);

    // track: kept until settled, the same promise back, a rejection dropped too
    let ok1, bad1;
    const a = new Promise((res) => { ok1 = res; });
    const b = new Promise((_, rej) => { bad1 = rej; });
    check("track answers the promise", r.track(a) === a);
    r.track(b);
    b.catch(() => {});   // the job's own caller handles it; the state must not raise an unhandled rejection
    check("two jobs pending", r.jobs.size === 2 && r.pending().includes(a) && r.pending().includes(b));
    const snap = r.pending();
    ok1(1);
    await a;
    await new Promise((res) => setTimeout(res, 0));
    check("a settled job leaves", !r.jobs.has(a) && r.jobs.has(b));
    check("pending() is a copy", snap.length === 2);
    bad1(new Error("x"));
    await new Promise((res) => setTimeout(res, 0));
    check("a rejected job leaves", r.jobs.size === 0);

    // marches: paired, never below zero
    r.marchBegan(); r.marchBegan();
    check("two marches", r.marches === 2);
    r.marchEnded(); r.marchEnded(); r.marchEnded();
    check("never below zero", r.marches === 0);

    // hide: counted per id, a release twice is one release
    check("nothing hidden", !r.isHidden("L1"));
    const rel1 = r.hide(["L1", "L2", "L1"]);
    check("hidden after hide (a repeated id once)", r.isHidden("L1") && r.isHidden("L2") && r.hidden.get("L1") === 1);
    const rel2 = r.hide(["L1"]);
    rel1();
    check("still hidden while another read holds it", r.isHidden("L1") && !r.isHidden("L2"));
    rel1();
    check("a second release of the same read changes nothing", r.isHidden("L1"));
    rel2();
    check("shown again once every read released", !r.isHidden("L1") && r.hidden.size === 0);
    const rel3 = r.hide([]);
    rel3();
    check("an empty hide is harmless", r.hidden.size === 0);

    console.log(`${checks - failures}/${checks} checks passed`);
    process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
