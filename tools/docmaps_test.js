// The document maps object alone (renderer/editor/inpaint_docmaps.js, item 77 step 2): put / set / replaceAll and the
// version, follow() moves only placed maps and bumps once, the meta preview keeps the first map it replaced with its
// kind, commits it for the undo step, cancels it back under its own kind. Plain Node: `node tools/docmaps_test.js`.
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
    const { DocumentMaps } = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_docmaps.js")).href);
    const m = new DocumentMaps();
    check("fresh: empty, version 0, no preview", Object.keys(m.all).length === 0 && m.version === 0 && m.preview === null);

    const depth = { kind: "depth", xf: [1, 0, 0, 1, 0, 0] }, normal = { kind: "normal" };
    m.put("depth", depth);
    check("put keeps the version", m.get("depth") === depth && m.version === 0);
    m.set({ normal, depth: null });
    check("set: puts, drops null, one version", m.get("normal") === normal && m.get("depth") === null && !("depth" in m.all) && m.version === 1);
    m.put("normal", undefined);
    check("put undefined drops", m.get("normal") === null);

    // replaceAll: a new object, the old set stays with whoever holds it
    m.set({ depth });
    const held = m.all;
    const v = m.version;
    m.replaceAll({ normal });
    check("replaceAll: a new object, the old set kept", m.all !== held && held.depth === depth && m.get("normal") === normal && m.get("depth") === null);
    check("replaceAll bumps", m.version === v + 1);
    m.replaceAll(null, { bump: false });
    check("replaceAll(null, no bump)", Object.keys(m.all).length === 0 && m.version === v + 1);

    // follow: placed maps move, one version when any moved, none when none
    const a = { xf: [1, 0, 0, 1, 0, 0] }, b = { xf: null }, c = { xf: [2, 0, 0, 2, 0, 0] };
    m.set({ a, b, c });
    let v0 = m.version;
    m.follow((xf) => xf.map((n) => n + 1));
    check("follow moves the placed maps", a.xf[0] === 2 && c.xf[0] === 3 && b.xf === null);
    check("follow bumps once", m.version === v0 + 1);
    m.replaceAll({ b });
    v0 = m.version;
    m.follow((xf) => xf);
    check("follow without a placed map keeps the version", m.version === v0);

    // the meta preview
    const cur = { meta: { s: 0 } }, p1 = { meta: { s: 1 } }, p2 = { meta: { s: 2 } };
    m.replaceAll({ depth: cur });
    v0 = m.version;
    m.showPreview("depth", p1);
    m.showPreview("depth", p2);
    check("preview shows the latest", m.get("depth") === p2 && m.version === v0 + 2);
    check("preview keeps the first map it replaced, with its kind", m.preview && m.preview.prev === cur && m.preview.kind === "depth");
    check("endPreview of another kind hands nothing", m.endPreview("normal") === null && m.preview === null);
    m.showPreview("depth", p1);
    check("endPreview hands the replaced map", m.endPreview("depth") === p2 && m.preview === null);
    m.put("depth", cur);
    m.showPreview("depth", p1);
    const normal2 = { kind: "n2" };
    m.put("normal", normal2);
    v0 = m.version;
    const back = m.cancelPreview();
    check("cancelPreview puts the map back under its own kind", back && back.kind === "depth" && m.get("depth") === cur && m.get("normal") === normal2 && m.version === v0 + 1);
    check("cancelPreview twice: nothing", m.cancelPreview() === null);
    m.showPreview("depth", p1);
    m.forgetPreview();
    check("forgetPreview puts nothing back", m.preview === null && m.get("depth") === p1);
    m.showPreview("depth", p2);
    m.replaceAll(null);
    check("replaceAll drops the preview", m.preview === null);
    m.showPreview("missing", p1);
    check("a preview of a kind with no map keeps nothing to put back", m.preview === null && m.get("missing") === p1);

    console.log(`${checks - failures}/${checks} passed`);
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
