// The selection state object alone (renderer/editor/inpaint_selection.js, item 77 step 2): replace and invalidate
// drop what was known and bump the counter, changed() with a known box, a superset or nothing, bounds() scans only
// when it has to (a superset is made exact inside it), the PNG is kept only for the mask it was made of and is current
// only at its counter, the range run begins / ends / is taken once. Plain Node: `node tools/selection_state_test.js`.
"use strict";

const path = require("path");
const { pathToFileURL } = require("url");

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
    checks++;
    if (!ok) failures++;
    console.log(`[${ok ? "ok" : "FAIL"}] ${name}${detail ? ": " + detail : ""}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
    const { SelectionState } = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_selection.js")).href);
    const scans = [];
    const make = (answer) => new SelectionState({ scan: (within) => { scans.push(within); return typeof answer === "function" ? answer(within) : answer; } });

    // a fresh state: nothing known, the first bounds() scans the whole mask
    let s = make([1, 2, 3, 4]);
    check("fresh: no mask, dirty, not encoded", s.mask === null && s.dirty && !s.loose && !s.encoded && s.seq === 0);
    check("fresh: knownBounds is undefined", s.knownBounds() === undefined);
    scans.length = 0;
    check("bounds scans the whole mask", same(s.bounds(), [1, 2, 3, 4]) && scans.length === 1 && scans[0] === null);
    check("bounds again: no second scan", same(s.bounds(), [1, 2, 3, 4]) && scans.length === 1);
    check("knownBounds after a scan is the box", same(s.knownBounds(), [1, 2, 3, 4]));

    // replace: the new mask, everything known about the old one goes
    const m1 = { name: "m1" }, m2 = { name: "m2" };
    s.dataUrl = "data:old"; s.box = [0, 0, 1, 1]; s.encoded = true;
    let seq = s.seq;
    s.replace(m1);
    check("replace: the mask", s.mask === m1);
    check("replace: dirty, PNG dropped, counter bumped", s.dirty && !s.loose && s.dataUrl === null && s.box === null && !s.encoded && s.seq === seq + 1);
    seq = s.seq;
    s.invalidate();
    check("invalidate: counter bumped, mask kept", s.seq === seq + 1 && s.mask === m1 && s.dirty);

    // changed() with a known box: no scan follows
    s = make([9, 9, 9, 9]); scans.length = 0;
    seq = s.seq; s.encoded = true;
    s.changed([5, 6, 7, 8]);
    check("changed(box): exact, no scan", same(s.bounds(), [5, 6, 7, 8]) && scans.length === 0 && s.seq === seq + 1 && !s.encoded);
    s.changed(null);
    check("changed(null): empty, no scan", s.bounds() === null && scans.length === 0 && s.knownBounds() === null);

    // changed() with a superset: knownBounds hands the superset, bounds() scans inside it once
    s = make((within) => within ? [within[0] + 1, within[1] + 1, within[2] - 1, within[3] - 1] : [0, 0, 100, 100]);
    scans.length = 0;
    s.changed({ within: [10, 10, 50, 50] });
    check("changed(within): loose and dirty", s.loose && s.dirty);
    check("changed(within): knownBounds is the superset", same(s.knownBounds(), [10, 10, 50, 50]));
    check("bounds inside the superset", same(s.bounds(), [11, 11, 49, 49]) && scans.length === 1 && same(scans[0], [10, 10, 50, 50]));
    check("after it: exact, not loose", !s.dirty && !s.loose);

    // changed() with nothing known: a whole scan
    scans.length = 0;
    s.changed(undefined);
    check("changed(undefined): knownBounds undefined", s.knownBounds() === undefined);
    check("changed(undefined): a whole scan", same(s.bounds(), [0, 0, 100, 100]) && scans.length === 1 && scans[0] === null);
    // a superset that is null (an empty selection known as empty) is not a superset: a whole scan
    scans.length = 0;
    s.cached = null; s.dirty = true; s.loose = true;
    s.bounds();
    check("loose without a box scans the whole mask", scans.length === 1 && scans[0] === null);

    // the drag: known() and rescan() leave the counter to the changed() at the end
    seq = s.seq;
    s.known([1, 1, 2, 2]);
    check("known: exact box, counter kept", same(s.knownBounds(), [1, 1, 2, 2]) && !s.dirty && !s.loose && s.seq === seq);
    s.changed({ within: [0, 0, 9, 9] });
    s.known(null);
    check("known(null) after a superset: exact empty", s.knownBounds() === null && !s.loose);
    seq = s.seq;
    s.rescan();
    check("rescan: dirty, not loose, counter kept", s.dirty && !s.loose && s.seq === seq && s.knownBounds() === undefined);

    // the PNG: one background encode at a time, kept for its mask, current at its counter
    s = make(null); s.replace(m1);
    check("encodeStart once", s.encodeStart() && !s.encodeStart() && s.encoding);
    const at = s.seq;
    s.encodeEnd();
    check("encodeEnd", !s.encoding);
    check("stored current", s.stored(m1, "data:a", [1, 2, 3, 4], at) === "current" && s.encoded && s.dataUrl === "data:a" && same(s.box, [1, 2, 3, 4]));
    s.changed(undefined);
    check("a change makes it not current", !s.encoded && s.dataUrl === "data:a");
    check("stored at an old counter: kept, stale", s.stored(m1, "data:b", null, at) === "stale" && !s.encoded && s.dataUrl === "data:b");
    s.replace(m2);
    check("stored for a replaced mask: dropped", s.stored(m1, "data:c", null, s.seq) === "dropped" && s.dataUrl === null && !s.encoded);
    s.encodeStart();
    check("a PNG made on the spot leaves the background encode alone", s.stored(m2, "data:d", null, s.seq) === "current" && s.encoding);
    check("stored(null) of an empty selection on tiles is current", s.stored(m2, null, null, s.seq) === "current" && s.dataUrl === null && s.encoded);

    // the range run
    const r1 = { group: "range1", seq: 1, snap: {}, limit: {}, mode: "add" };
    const r2 = { group: "range2", seq: 2, snap: {}, limit: {}, mode: "add" };
    s.beginRange(r1);
    check("beginRange", s.range === r1);
    check("endRange of another run: false, kept", !s.endRange(r2) && s.range === r1);
    check("endRange of the run: true, cleared", s.endRange(r1) && s.range === null);
    check("endRange twice: false", !s.endRange(r1));
    s.beginRange(r2);
    check("takeRange hands it once", s.takeRange() === r2 && s.takeRange() === null && s.range === null);
    check("endRange after a cancel took it: false", !s.endRange(r2));

    console.log(`${checks - failures}/${checks} passed`);
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
