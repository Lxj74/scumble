// The prompt templates of Settings > Prompt writing (electron/main/prompts.js) in plain Node against a temp folder:
// node tools/prompts_test.js. Review finding main-net/prompts-remove-mangles-folder-template-id: a template put into the
// folder through Open folder keeps its file's stem as its id (spaces and all), and Remove deletes that file, never a
// file whose name the id was stripped to.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-prompts-"));
const orig = Module._load;
Module._load = function (request, ...rest) {
    if (request === "electron") return { app: { getPath: () => USERDATA }, shell: { openPath: async () => "" } };
    return orig.call(this, request, ...rest);
};
const prompts = require(path.join(ROOT, "electron", "main", "prompts.js"));
Module._load = orig;

async function main() {
    const builtin = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-prompts-builtin-"));
    const dir = path.join(USERDATA, "prompts");
    fs.mkdirSync(dir, { recursive: true });
    const md = (name) => `---\nname: ${name}\n---\nWrite it as ${name}.\n`;
    fs.writeFileSync(path.join(dir, "My Style.md"), md("My Style"));
    fs.writeFileSync(path.join(dir, "MyStyle.md"), md("MyStyle"));
    fs.writeFileSync(path.join(dir, "Grüße.md"), md("Gruesse"));
    const ids = (await prompts.list(builtin)).map((t) => t.id).sort();
    check("templates put into the folder keep their file's stem as the id", ids.join("|") === ["Grüße", "My Style", "MyStyle"].sort().join("|"), JSON.stringify(ids));

    await prompts.remove("My Style");
    check("Remove of \"My Style\" deletes My Style.md and leaves MyStyle.md", !fs.existsSync(path.join(dir, "My Style.md")) && fs.existsSync(path.join(dir, "MyStyle.md")), fs.readdirSync(dir).join(", "));
    await prompts.remove("Grüße");
    check("a template with a non-ASCII name can be removed", !fs.existsSync(path.join(dir, "Grüße.md")), fs.readdirSync(dir).join(", "));

    const refused = [];
    for (const bad of ["", "..", "../x", "nothere", "MyStyle.md"]) {
        try { await prompts.remove(bad); refused.push(false); } catch (_) { refused.push(true); }
    }
    check("an empty id, a path or an id no file of the folder has is refused", refused.every(Boolean) && fs.existsSync(path.join(dir, "MyStyle.md")), JSON.stringify(refused));

    fs.rmSync(USERDATA, { recursive: true, force: true });
    fs.rmSync(builtin, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
