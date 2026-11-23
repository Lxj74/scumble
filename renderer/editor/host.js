// @ts-check
// What the editor needs from its surroundings. The editor (renderer/editor/inpaint_*.js) is
// shared with the ComfyUI node, whose own js/host.js answers the same members with `app`,
// `api` and the litegraph node; here it is one object backed by the main process.
// tools/build_node.py --check fails when the editor calls a member one of the two lacks
// (docs/BUILD_NODE.md).
//
//   api   - ComfyUI's client API surface the editor uses: fetchApi, apiURL, queuePrompt,
//           addEventListener, clientId. Requests go to scumble://app/comfy/*, which the main
//           process proxies to the server, so images and uploads stay same-origin.
//   host  - the document-level services: recipe, settings targets, generate, autosave.
//           Several editors can be open (tabs in the shell); `host.editor` is the active
//           one, `host.editors()` all of them. Server events are routed to the editor
//           that asked: results by prompt id, helper masks / texts by the canvas_node id
//           the helper prompt carried (= editor.node.id).

import * as realism from "./realism.js";
import { SHAPE_ERROR, api, kleinEncoderHint, upsampledNote, bindUtil } from "./host_util.js";
import { HostStatePart } from "./host_state.js";
import { HostExportPart } from "./host_export.js";
import { HostSetupPart } from "./host_setup.js";
import { HostPresetsPart } from "./host_presets.js";
import { HostProviderPart } from "./host_provider.js";
import { HostUpscalePart } from "./host_upscale.js";
import { HostGeneratePart } from "./host_generate.js";
import { HostPicturesPart } from "./host_pictures.js";
import { HostKeyPart } from "./host_key.js";
import { HostRelightPart } from "./host_relight.js";
import { HostQueuePart } from "./host_queue.js";
import { HostDocumentsPart } from "./host_documents.js";
import { HostHelpersPart } from "./host_helpers.js";
import { HostVlmPart } from "./host_vlm.js";
import { HostHelperWatchPart } from "./host_helperwatch.js";

// ---- the contract ------------------------------------------------------------------------
//
// The editor modules (inpaint_*.js) are shared with the ComfyUI node, so every member the
// editor asks for has to exist in *this* file and in the node's own js/host.js.
// tools/build_node.py --check enforces that by grepping both files for the names the editor
// uses; the two typedefs below are the same statement in a form a type checker reads,
// types/contracts.js is where this side of it is checked against them, and types/host_calls.js
// (written by tools/host_contract.py, checked by the `types` gate and CI) reads every member the
// editor uses through the typedef, so one the typedef lacks fails tsc. The node repository has
// no tsconfig, so the grep stays: it is the only check that reaches over there.
//
// A member belongs here when an editor module calls it. Nothing else is the contract - the
// shell talks to this object too, and those members are deliberately absent.

/**
 * ComfyUI's client API surface. The editor modules call the first three; `addEventListener`
 * is in the surface because the host wires the server's events with it (the header above).
 *
 * @typedef {Object} EditorApi
 * @property {(path: string) => string} apiURL
 * @property {(path: string, init?: RequestInit) => Promise<Response>} fetchApi
 * @property {(number: number, prompt: { output: unknown, workflow?: unknown }) => Promise<unknown>} queuePrompt
 * @property {(type: string, fn: (ev: { detail: unknown }) => void) => void} addEventListener
 */

/**
 * The editor as the host sees it (renderer/editor/inpaint_canvas.js; its parts are mixed into the class).
 * @typedef {import("./inpaint_canvas.js").InpaintEditor} Editor
 */

/**
 * A layer of the document as the host is handed it: a plain object the editor owns (inpaint_ed_layers.js).
 * @typedef {{ id: string, name?: string, kind?: string, [key: string]: unknown }} EditorLayer
 */

/**
 * The document-level services: every member an editor module calls (item 77 step 3,
 * docs/PLAN_ENCAPSULATION.md). `editor` is the InpaintEditor; a value the editor only hands on
 * (a recipe row, a run's answer, a helper's result) is `unknown` here, not `any`, so a reader in a
 * checked file has to look before it uses it. types/host_calls.js (tools/host_contract.py) reads
 * every host.<member> the editor modules use through this type, so a member missing here fails tsc.
 *
 * @typedef {Object} EditorHost
 * @property {boolean} connected                         is a ComfyUI server connected
 * @property {boolean} overlay                           node: a modal over the graph; app: the window
 * @property {Record<string, string> | null} text        node-specific wording, null = the editor's own
 * @property {(rootEl: HTMLElement) => void} mount               where the editor's DOM goes
 * @property {(editor: Editor) => void} editorBuilt         the modal is built
 * @property {(editor: Editor) => void} changed             state changed: autosave
 * @property {(editor: Editor) => boolean} isActive         is this the editor the user is looking at
 * @property {() => Editor[]} editors                       every open editor
 * @property {() => unknown} graph                           the litegraph graph (node) or null (app)
 * @property {() => string[]} referencedTexts            file names outside the editors to keep
 * @property {(editor: Editor) => void} onEscape            Escape: close the overlay (node) or nothing
 * @property {(editor: Editor, tool: string, prev: string) => void} toolChanged
 * @property {(editor: Editor, mode: string) => void} modeChanged
 * @property {(editor: Editor, phase: string, e: PointerEvent, ix: number, iy: number, p: unknown) => boolean} pluginPointer
 * @property {(editor: Editor, e: KeyboardEvent, k: string) => boolean} pluginKey
 * @property {(editor: Editor, ctx: unknown) => void} pluginOverlay
 * @property {(pluginId: string, where: string, err: unknown) => void} [pluginReport]
 * @property {() => unknown} nodeTypes                       the server's node classes, for the settings rows
 * @property {(editor: Editor) => unknown[]} settingTargets     the recipe's settings rows for this editor
 * @property {(editor: Editor, list: unknown, targets: unknown) => void} renderPresets
 * @property {(editor: Editor, name: string, fallback?: unknown) => unknown} widgetValue
 * @property {(editor: Editor) => unknown} resultInputState     which result input the recipe writes to
 * @property {(editor: Editor) => unknown} workflowForPng       the workflow to embed in a saved PNG, null = embed nothing
 * @property {(editor: Editor, sec: HTMLElement) => void} buildGenerateExtras   the extra rows under Generate
 * @property {(editor: Editor, opts?: { refs?: unknown, area?: unknown }) => Promise<unknown>} queueGenerate   run the recipe; `refs`: the click's reference snapshot (docs/PLAN_REFS.md C3); `area`: one area of the selection instead of the selection (the app's Each area; the node's host is never given one)
 * @property {() => boolean} generateNewAvailable
 * @property {(editor: Editor) => void} openGenerateNew
 * @property {(editor: Editor) => ({ models: { value: string, label: string, group: string, providers: { value: string, label: string, aspects: string[], classes: { value: number, label: string }[] }[] }[], pick: { model: string, provider: string, aspect: string | null, size: number | null } | null, working: (aspect: string, size: number) => [number, number] } | null)} [newCanvasChoices]   New with a model (item 34): the models, the preset to open on, the canvas of a preset; the node answers null
 * @property {(editor: Editor, target: { recipe: string, provider?: string | null, aspect: string | null, size: number, width: number, height: number } | null) => Promise<void>} [newCanvasChosen]   New made a canvas for a preset: remember it, select its recipe; null (a New of a size given by hand): forget the last preset
 * @property {(editor: Editor, fmt?: string) => unknown} exportCanvas
 * @property {(editor: Editor) => boolean} exportIsPlain
 * @property {(editor: Editor) => number} exportQuality
 * @property {(blob: Blob, name: string, opts?: { editor?: Editor, download?: boolean }) => Promise<unknown>} saveExport   the node takes `opts`, the app ignores it
 * @property {() => unknown[]} upsampleBackends
 * @property {(editor: Editor, backend: unknown, instruction: string, refs?: unknown[]) => Promise<unknown>} upsampleInApp   `refs`: the references the prompt names (docs/PLAN_REFS.md 26d1)
 * @property {(ctx: unknown) => string} upsampleInstruction
 * @property {(backend: unknown, instruction: string, canvas: HTMLCanvasElement, images?: { png: Uint8Array, label: string }[]) => Promise<unknown>} askLLM   `images`: reference pictures (docs/PLAN_REFS.md 26d2)
 * @property {() => unknown[]} cutoutBackends
 * @property {(editor: Editor, layer: EditorLayer, backend: unknown) => Promise<unknown>} cutoutInApp
 * @property {() => boolean} objectsInApp
 * @property {(editor: Editor, pending: unknown) => Promise<unknown>} findObjects
 * @property {(editor: Editor, ix: number, iy: number, p?: unknown) => Promise<unknown>} selectPoint
 * @property {(editor: Editor, box: number[], opts?: unknown) => Promise<unknown>} selectBox
 * @property {() => Promise<unknown>} freeHelpers
 * @property {boolean} vlmLoaded                                     Florence-2 sits in the helpers' process (host_vlm.js): a local Generate frees it; the node never loads it
 * @property {boolean} removeSupported
 * @property {boolean} refTokens                                     a reference token (img1 after an at sign) in the prompt names a reference layer (docs/PLAN_REFS.md); the node has none yet. No at sign in this block: JSDoc reads one as a new tag and drops every member after it
 * @property {(editor: Editor, over?: unknown, opts?: { keep?: boolean }) => Promise<unknown>} refLayout   the chosen route's name for each shown reference ({ names, over, none, local, cap, refuse, guess? }); the node answers null
 * @property {(editor: Editor) => { takes: boolean, count: number, schema: string | null } | null} boxSwitch   the Boxes switch under the prompt (docs/PLAN_BOXES.md S3d): does the recipe send boxes, how many the document holds, in which format (flux3, ideogram4); the node answers takes true, schema flux3 (its box_prompt output) and accepts a null editor
 * @property {boolean} boxesInEditor                                 the editor owns the boxes itself (inpaint_boxes.js: tool X, the Boxes section, the boxes in getValue): the node true, the app false (its Boxes plugin owns them; docs/PLAN_NODE_BOXES.md D5)
 * @property {() => unknown} removeModel
 * @property {(editor: Editor, req: { image: Uint8Array, mask: Uint8Array }) => Promise<unknown>} removeInApp
 * @property {boolean} [depthSupported]
 * @property {boolean} [surfaceSupported] Deep paint's surface maps (the app's host; the layer list's Deep paint button)
 * @property {() => unknown} [depthModel]
 * @property {(editor: Editor, w: number, h: number) => Promise<{ image: Uint8Array, width: number, height: number }>} [depthInput]
 * @property {(editor: Editor, req: { image: Uint8Array, width: number, height: number }) => Promise<{ depth: Float32Array, min: number, max: number, ms: number, provider: string }>} [computeDepth]
 * @property {(editor: Editor, w: number, h: number, opts?: unknown) => Promise<{ image: Uint8Array, width: number, height: number }>} [pictureInput]
 * @property {(editor: Editor, opts: { grid?: number, route?: string, onProgress?: (i: number, n: number) => void, signal?: AbortSignal, global?: unknown }) => Promise<{ data: Float32Array, w: number, h: number, fits: unknown[], route: string, grid: number } | null>} [depthDetail]
* @property {(editor: Editor) => Promise<{ ready: boolean, seconds?: number, provider?: string, error?: string } | null>} warmRemove   the Remove model loaded ahead of the first stroke; null without a model; never throws (the node answers null)
 * @property {() => { intrinsic: { id: string } | null, normals: { id: string } | null } | null} surfaceModels   Deep paint's two models, each null when absent (the node answers null)
 * @property {(editor: Editor, req: { image: Uint8Array, width: number, height: number }) => Promise<{ intrinsic: Record<string, unknown>, normals: Record<string, unknown> }>} surfaceAnalysis   Deep paint's decomposition and normals of one picture (the node throws)
 * @property {string} depthDetailSetting                            the depth map's detail as picked ("standard" ...); the depth panel writes it when the host has no setDepthDetail
 * @property {() => string} getDepthDetail
 * @property {(val: string) => void} setDepthDetail                  remembered in the settings (the app; the node keeps nothing)
 * @property {() => Record<string, unknown>} getRelightSettings      the relight panel's route, strength and style as last picked
 * @property {(patch: Record<string, unknown>) => void} setRelightSettings   a key set to undefined is forgotten
 * @property {(editor: Editor, layer: EditorLayer, opts?: { route?: string, deadline?: number, prompt?: string }) => Promise<{ layer: EditorLayer | null, seconds: number, note: string, changed: boolean, route: string, seed: unknown }>} relightWhole   the whole picture through a generative relight route (host_relight.js; the node throws)
 */

// ---- host --------------------------------------------------------------------------------

export const host = {
    ...HostStatePart,
    ...HostExportPart,
    ...HostSetupPart,
    ...HostPresetsPart,
    ...HostProviderPart,
    ...HostUpscalePart,
    ...HostGeneratePart,
    ...HostPicturesPart,
    ...HostKeyPart,
    ...HostRelightPart,
    ...HostQueuePart,
    ...HostDocumentsPart,
    ...HostHelpersPart,
    ...HostVlmPart,
    ...HostHelperWatchPart,
};
bindUtil(host);

// ---- server events ------------------------------------------------------------------------

window.scumble.comfy.onEvent((ev) => api.dispatch(ev.type, ev.data));

api.addEventListener("executed", ({ detail }) => {
    // a picture run (the Realism Pass, an upscale of the whole picture) takes its own answer
    if (host.pictureRunEvent("executed", detail)) return;
    const out = detail && detail.output;
    if (!out) return;
    // a prompt of a closed tab lands nowhere (the fallbacks below would hand it to the tab in front)
    if (detail.prompt_id != null && host._closedPrompts.has(String(detail.prompt_id))) return;
    // the canvas node's notes on boxes it left out or could not write into box_prompt (docs/PLAN_NODE_BOXES.md D9; it runs
    // before the result): the run's notes, and the status line once the result has landed. Only for a run that took
    // box_prompt (queueGenerate's `_boxPrompts`): the node also writes rows nobody reads, for a switch left on under a
    // recipe that takes no boxes or a Generate new without any, and their notes say nothing about the run
    const boxNotes = Array.isArray(out.inpaint_boxes) ? out.inpaint_boxes.filter((n) => typeof n === "string" && n) : [];
    const boxEd = boxNotes.length && detail.prompt_id != null ? host.editorByPrompt(detail.prompt_id) : null;
    if (boxEd && boxEd._boxPrompts && boxEd._boxPrompts.has(String(detail.prompt_id))) {
        const held = boxEd._boxNotes || (boxEd._boxNotes = new Map());
        held.set(String(detail.prompt_id), boxNotes);
        while (held.size > 50) held.delete(held.keys().next().value);
        if (String(boxEd.lastPromptId) === String(detail.prompt_id) && Array.isArray(boxEd.lastRunNotes)) boxEd.lastRunNotes.push(...boxNotes);
        if (window.scumble && window.scumble.log) Promise.resolve(window.scumble.log.add({ level: "warn", source: "comfy", message: `local run ${detail.prompt_id}: boxes`, detail: boxNotes.join(" ") })).catch(() => { /* the log is optional */ });
    }
    // a run's prompt upsampler (0.1.50 Q9): its caption, which the image model got instead of the prompt as typed, into
    // the log, and a note on the run once the result has landed
    const upNode = detail.prompt_id != null ? host._upsampledRuns.get(String(detail.prompt_id)) : null;
    if (upNode && String(detail.node) === upNode && Array.isArray(out.text) && typeof out.text[0] === "string") {
        host._upsampledRuns.delete(String(detail.prompt_id));
        const caption = out.text[0];
        const upEd = host.editorByPrompt(detail.prompt_id);
        const note = upsampledNote(caption);
        if (upEd && String(upEd.lastPromptId) === String(detail.prompt_id) && Array.isArray(upEd.lastRunNotes)) upEd.lastRunNotes.push(note);
        // the status line once the result has landed (the result's own line comes first); a result already in takes it now
        if (upEd) {
            const pid = String(detail.prompt_id);
            if (upEd._upLanded && upEd._upLanded.has(pid)) { upEd._upLanded.delete(pid); upEd.setStatus(`${upEd.status} ${note}`, upEd.statusKind || "info"); }
            else (upEd._upNotes || (upEd._upNotes = new Map())).set(pid, note);
        }
        if (window.scumble && window.scumble.log) Promise.resolve(window.scumble.log.add({ level: "info", source: "comfy", message: `local run ${detail.prompt_id}: the prompt upsampler's caption`, detail: caption })).catch(() => { /* the log is optional */ });
    }
    // Results: the recipe's canvas node id is the same for every tab, so the prompt id
    // decides; helper outputs carry the editor id the helper prompt was queued with.
    if (out.inpaint_result) {
        const ed = host.editorByPrompt(detail.prompt_id) || host.editor;
        const sent = ed && ed._sentTexts && ed._sentTexts.get(detail.prompt_id);
        if (sent) ed._sentTexts.delete(detail.prompt_id);
        const notes = ed && ed._boxNotes && detail.prompt_id != null ? ed._boxNotes.get(String(detail.prompt_id)) : null;
        if (notes) ed._boxNotes.delete(String(detail.prompt_id));
        if (ed && ed._boxPrompts && detail.prompt_id != null) ed._boxPrompts.delete(String(detail.prompt_id));
        const h0 = ed ? ed.history.length : 0;   // addResults says nothing of a result it could not land: the history does
        const landed = ed ? ed.addResults(sent ? out.inpaint_result.map((r) => ({ ...r, ...sent, via: sent.via ? `${sent.via}, ${Math.round((Date.now() - sent.viaStarted) / 1000)} s` : undefined })) : out.inpaint_result) : null;
        if (notes) Promise.resolve(landed).then(() => ed.setStatus(`${ed.status} Boxes: ${notes.join(" ")}`, "warn")).catch(() => { /* the result's own line stands */ });
        // the run's upsampled prompt (0.1.50 Q9): its note after the result's line; a caption still to come finds the mark
        const pid = detail.prompt_id != null ? String(detail.prompt_id) : null;
        const upNote = ed && pid && ed._upNotes ? ed._upNotes.get(pid) : null;
        if (upNote) { ed._upNotes.delete(pid); Promise.resolve(landed).then(() => ed.setStatus(`${ed.status} ${upNote}`, ed.statusKind || "info")).catch(() => { /* the result's own line stands */ }); }
        else if (ed && pid && host._upsampledRuns.has(pid)) Promise.resolve(landed).then(() => { const l = ed._upLanded || (ed._upLanded = new Set()); l.add(pid); while (l.size > 64) l.delete(l.values().next().value); }).catch(() => { /* nothing to mark */ });
        // the prompts whose result has landed in the document as a layer (Each area waits for its own area's, eacharea.js
        // waitLocal); one that landed nothing (an empty answer, a result seen before, a file that would not load) is not
        if (ed && pid) Promise.resolve(landed).then(() => { if (ed.history.length > h0) markLanded(ed, pid); }).catch(() => { /* the area waits for its prompt's end */ });
    }
    // a helper prompt's output (host_helperwatch.js): one whose wait was ended (lost, cancelled) lands nowhere, any
    // other ends the watch of its prompt
    if ((out.inpaint_text || out.inpaint_mask) && detail.prompt_id != null) {
        if (host._helperEnded.has(String(detail.prompt_id))) return;
        host.helperAnswered(detail.prompt_id);
    }
    // a closed tab's helper output (queued while it closed: no prompt id was known) lands nowhere either
    const forNode = (info) => (info && info.canvas_node != null && host._closedNodes.has(String(info.canvas_node)) ? null
        : host.editorById(info && info.canvas_node) || host.editorByPrompt(detail.prompt_id) || host.editor);
    if (out.inpaint_text) for (const info of out.inpaint_text) { const ed = forNode(info); if (ed) ed.applyTextResult(info); }
    for (const info of out.inpaint_mask || []) {
        const ed = forNode(info);
        if (!ed) continue;
        if (info.purpose === "segments") ed.applySegmentsFile(info);
        else if (info.purpose === "cutout") ed.applyCutoutFile(info);
        else ed.applyMaskFile(info);
    }
});

/** A local prompt's result landed in `ed`: kept by its id (the last 64), so a run can wait for its own prompt's result. */
function markLanded(ed, pid) {
    const l = ed._landedPrompts || (ed._landedPrompts = new Set());
    l.add(String(pid));
    while (l.size > 64) l.delete(l.values().next().value);
}

/** A prompt ended on ComfyUI: no document counts it as an open render any more (see queueGenerate). */
function localRunEnded(detail) {
    const id = detail && detail.prompt_id;
    if (id != null) host._kleinRuns.delete(String(id));
    for (const ed of host.editors()) if (ed._localRuns) { if (id) ed._localRuns.delete(id); else ed._localRuns.clear(); }
}

/** Whether the prompt was a closed tab's (removeEditor); its end forgets it. */
function closedPromptEnded(detail) {
    const id = detail && detail.prompt_id != null ? String(detail.prompt_id) : null;
    return !!id && host._closedPrompts.delete(id);
}
api.addEventListener("execution_success", ({ detail }) => { localRunEnded(detail); closedPromptEnded(detail); host.pictureRunEvent("success", detail); host.helperEvent("success", detail); });
api.addEventListener("execution_interrupted", ({ detail }) => { localRunEnded(detail); closedPromptEnded(detail); host.pictureRunEvent("interrupted", detail); host.helperEvent("interrupted", detail); });
// the helper prompts a document waits for (host_helperwatch.js): a job ComfyUI will never answer ends its wait
const helperWatch = setInterval(() => { host.watchHelpers().catch((err) => console.warn("helper watch", err)); }, 1000);
// a plain-Node test that imports this module must be able to end (the window's timer is a number, without unref)
if (helperWatch && typeof helperWatch.unref === "function") helperWatch.unref();
api.addEventListener("status", ({ detail }) => {
    const info = detail && detail.status && detail.status.exec_info;
    if (info && info.queue_remaining === 0) for (const ed of host.editors()) { if (ed._localRuns) ed._localRuns.clear(); if (ed.runProgress) ed.runProgress.idle(host.liveRunIds()); }
    else if (info && info.queue_remaining > 0) host.checkTrackedRuns();
});
// a provider run's live progress (Comfy Cloud on v2): the bar of the document it runs for
if (window.scumble.providers && typeof window.scumble.providers.onProgress === "function") window.scumble.providers.onProgress((p) => host.providerProgress(p));
// the status row's bar (docs/PLAN_0_1_48.md S3)
for (const type of ["execution_start", "execution_cached", "executing", "progress", "execution_success", "execution_error", "execution_interrupted"]) {
    api.addEventListener(type, ({ detail }) => host.progressEvent(type, detail));
}

api.addEventListener("execution_error", ({ detail }) => {
    // the owner first: localRunEnded drops the id from the document's open renders, which editorByPrompt reads (and a
    // Klein run's files, read here first)
    const owner = detail ? host.editorByPrompt(detail.prompt_id) : null;
    const klein = detail && detail.prompt_id != null ? host._kleinRuns.get(String(detail.prompt_id)) : null;
    localRunEnded(detail);
    if (!detail) return;
    // a picture run's failure goes to its caller (passPicture's sentence), not into the tab's status
    if (host.pictureRunEvent("error", detail)) { closedPromptEnded(detail); return; }
    // a closed tab's prompt: its failure goes into no tab's status
    if (!owner && closedPromptEnded(detail)) return;
    const ed = owner || host.editor;
    if (!ed) return;
    const msg = detail.exception_message || "execution failed";
    if (ed.segmentPromptId && detail.prompt_id === ed.segmentPromptId) {
        ed.segmentPending = null; if (ed.segBtn) ed.segBtn.disabled = false;
        ed.setStatus("Segmentation failed: " + msg, "error");
    } else if (ed.objectsPromptId && detail.prompt_id === ed.objectsPromptId) {
        ed.objectsPending = null;
        ed.setStatus("Object detection failed: " + msg, "error");
    } else if (ed.upsamplePromptId && detail.prompt_id === ed.upsamplePromptId) {
        ed.upsamplePending = null; if (ed.upBtn) ed.upBtn.disabled = false;
        ed.setStatus("Upsampling failed: " + msg, "error");
    } else if (ed.cutoutPromptId && detail.prompt_id === ed.cutoutPromptId) {
        ed.cutoutPending = null; ed.renderLayers();
        ed.setStatus("Background removal failed: " + msg, "error");
    } else if (realism.isPassNode(detail.node_type)) {
        // the DLSS pack's failures as sentences (docs/PLAN_0_1_42.md §3.4), not "Error in DLSS5EnhanceImages: ...";
        // marked, since a sentence need not read "failed" (the generate command stops its wait on it)
        const text = realism.hint(msg);
        ed.lastPassError = text;
        ed.setStatus(text, "error");
    } else if (klein && SHAPE_ERROR.test(msg)) {
        // a Klein run whose text encoder does not fit the model: said as that, not as torch's matrix shapes (0.1.50 Q1);
        // the sentence reads "failed", so the generate command stops its wait on it at once
        ed.setStatus(kleinEncoderHint(klein, msg), "error");
    } else if (detail.node_type === "InpaintCanvas" && /^Inpaint Canvas: /.test(msg)) {
        // the node's own errors already name it ("Inpaint Canvas: reference 2 (@img2) could not be loaded ..."): said
        // once, with "failed" so the generate command stops its wait on it at once
        ed.setStatus("Inpaint Canvas failed: " + msg.replace(/^Inpaint Canvas: /, ""), "error");
    } else {
        ed.setStatus("Error in " + (detail.node_type || detail.node_id || "the graph") + ": " + msg, "error");
    }
});

export { api };
