// The undo history object alone (renderer/editor/inpaint_history.js, item 77 step 1): the byte budget never goes below
// zero and follows what the stacks hold, trim against steps and bytes, a push drops the redo steps, take / grow /
// shrink / moveUnder / popTop / pushOther, the depth, clear. Plain Node: `node tools/history_test.js`.
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
    const { UndoHistory } = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_history.js")).href);
    const released = [];
    const make = (opts = {}) => {
        const h = new UndoHistory({
            maxSteps: opts.maxSteps || 30,
            maxBytes: opts.maxBytes || 1000,
            // the editor's releaseSnapshot: it takes the step's bytes off through uncount
            release: (s) => { released.push(s.label); h.uncount(s); },
        });
        return h;
    };
    const step = (label, bytes = 0) => ({ label, kind: "layers", bytes });
    // the count is what the counted steps on both stacks hold
    const held = (h) => [...h.undo, ...h.redo].filter((s) => s._counted).reduce((n, s) => n + (s.bytes || 0), 0);

    {
        const h = make();
        h.push(step("a", 100));
        h.push(step("b", 200));
        check("push_counts_each_step_once", h.bytes === 300 && held(h) === 300 && h.undo.length === 2, `${h.bytes}`);
        h.count(h.undo[0]);
        check("count_twice_counts_once", h.bytes === 300);
        const b = h.popTop(false);
        h.pushOther(step("b-now", 50), false);
        check("an_undo_moves_the_present_to_redo_counted", h.redo.length === 1 && h.bytes === 350 && b._counted, `${h.bytes}`);
        h.release(b);
        check("the_undone_step_released_takes_its_bytes_off", h.bytes === 150 && held(h) === 150, `${h.bytes}`);
        h.push(step("c", 10));
        check("a_push_drops_the_redo_steps", h.redo.length === 0 && released.includes("b-now") && h.bytes === 110 && held(h) === 110, `${h.bytes}`);
    }
    {
        // the review's case: a held step never pushed, a named snapshot and a step taken out by hand never drive the count below zero
        const h = make();
        const loose = step("loose", 500);
        h.release(loose);
        check("releasing_an_uncounted_step_changes_nothing", h.bytes === 0);
        const s = step("range", 64);
        h.push(s);
        const t = h.take(s);
        h.release(t);
        h.release(t);
        check("a_taken_step_released_twice_counts_off_once", h.bytes === 0 && h.undo.length === 0, `${h.bytes}`);
        check("take_of_a_step_not_on_the_stack_is_null", h.take(step("x")) === null && h.take(null) === null);
    }
    {
        const h = make({ maxSteps: 3, maxBytes: 1e9 });
        for (const l of ["1", "2", "3", "4", "5"]) h.push(step(l, 1));
        check("trim_keeps_the_newest_steps", h.undo.map((s) => s.label).join("") === "345" && h.trimmed && h.bytes === 3, h.undo.map((s) => s.label).join(""));
    }
    {
        const h = make({ maxSteps: 30, maxBytes: 250 });
        h.push(step("a", 100));
        h.push(step("b", 100));
        h.push(step("c", 100));
        check("trim_against_bytes_drops_the_oldest", h.undo.map((s) => s.label).join("") === "bc" && h.bytes === 200, `${h.bytes}`);
        h.push(step("huge", 5000));
        check("the_last_step_stays_even_above_the_budget", h.undo.length === 1 && h.undo[0].label === "huge" && h.bytes === 5000);
    }
    {
        const h = make();
        const s = step("glb", 100);
        h.push(s);
        h.grow(s, 40);
        check("grow_on_a_counted_step_counts", s.bytes === 140 && h.bytes === 140);
        h.shrink(s, 100);
        check("shrink_on_a_counted_step_counts_off", s.bytes === 40 && h.bytes === 40);
        const u = step("loose", 10);
        h.grow(u, 5);
        check("grow_on_an_uncounted_step_leaves_the_count", u.bytes === 15 && h.bytes === 40);
        h.release(s);
        check("a_grown_step_released_takes_all_its_bytes", h.bytes === 0, `${h.bytes}`);
    }
    {
        const h = make();
        h.push(step("before"));
        h.push(step("turn"));
        h.push(step("own1"));
        h.push(step("own2"));
        h.moveUnder(2);
        check("move_under_puts_the_top_step_below_the_count", h.undo.map((s) => s.label).join(",") === "before,own2,turn,own1", h.undo.map((s) => s.label).join(","));
        h.moveUnder(10);
        check("move_under_past_the_stack_does_nothing", h.undo.length === 4 && h.undo[3].label === "own1");
    }
    {
        const h = make({ maxSteps: 30, maxBytes: 1e9 });
        for (let i = 0; i < 10; i++) h.push(step("s" + i, 1));
        h.setDepth({ steps: 4 }, { steps: 30, bytes: 1e9 });
        check("a_smaller_depth_trims_at_once", h.undo.length === 4 && h.maxSteps === 4 && h.bytes === 4);
        h.setDepth({ steps: 0, bytes: 10 }, { steps: 30, bytes: 1e9 });
        check("the_depth_has_floors", h.maxSteps === 30 && h.maxBytes === 1048576, `${h.maxSteps} ${h.maxBytes}`);
    }
    {
        const h = make();
        h.push(step("a", 10));
        h.pushOther(step("r", 5), false);
        const gen = h.gen;
        h.clear();
        check("clear_releases_both_stacks_and_moves_the_generation", h.undo.length === 0 && h.redo.length === 0 && h.bytes === 0 && !h.trimmed && h.gen === gen + 1);
    }
    {
        const h = make();
        h.push(step("a", 10));
        h.push(step("b", 20));
        const rows = h.rows({ layers: "Layers" });
        check("rows_list_the_states_oldest_first", rows.length === 3 && rows[0].label === "Start" && rows[2].current && rows[1].steps === -1, JSON.stringify(rows.map((r) => [r.label, r.steps])));
        h.replace([step("x", 7)], []);
        check("replace_counts_what_the_stacks_hold", h.bytes === 0 && h.undo.length === 1);
    }

    console.log(`\n${checks - failures} of ${checks} checks passed`);
    console.log(failures ? "FAIL" : "PASS");
    process.exit(failures ? 1 : 0);
})();
