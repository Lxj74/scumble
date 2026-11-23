# Encapsulation of the editor's core (item 77)

The user, 2026-11-23: the app's maintainability, modularity, encapsulation and structure, then "wollen wir das
machen ?" to the three steps below. No change the user can see; the goal is fewer bugs of the kind "state that went
stale after an undo or during a run".

## Why

`InpaintEditor` is one class of 775 methods and 362 fields of its own, spread over 38 part files
(`inpaint_parts.js` mixes them into the class). Every part reads and writes every field: the split of 0.1.55 (item 56)
made the files small, not the state private. The review of 2026-11-16 found the cost of that: the undo budget counted by
three hands and going below zero (`undo-bytes-budget-goes-negative-on-unpushed-and-dropped-snapshots`), relight and the
surface maps going on with a layer object an undo had replaced, the wrap link keyed on a counter an undo does not
reset. The host contract (`host`, a global object 15 editor modules import, its typedef with over a hundred `any`)
is checked only by `build_node.py --check`: the undeclared `host.vlmLoaded` of 2026-11-20 surfaced at the node build.
55 of 265 files are `@ts-check`ed, `strict` is off.

## The rules

- **No rewrite.** One part per session, behind the gates, the behaviour the same byte for byte.
- A part becomes an object the editor owns (`this.undoHistory`), with its fields inside it and a narrow interface. The
  editor keeps forwarding methods for the old names while callers move, so a session can stop at any commit; the
  forwards go in the session that moves the last caller.
- Test tier: **full** (both backends, the editor gate in full, not sharded) for the history and anything that writes
  pixels or the document; the exe gates at the next release.
- The new module is `// @ts-check` from its first commit; its interface gets JSDoc types without `any`.

## Step 1: the undo history (`this.undoHistory`)

**What moves in.** The fields `undo`, `redo`, `undoBytes`, `undoTrimmed`, `maxUndo`, `maxUndoBytes`, `historyGen`
and the byte flag `_counted` of a step (since 2026-11-20); the methods that own them: `pushUndo`, `pushUndoSnapshot`,
`releaseSnapshot`'s byte part, `trimUndo`, `setUndoDepth`, `clearUndo`, `undoList`, the stack move of
`historyStepNow`, `takeUndoEntry` (now in `inpaint_ed_select.js`). The snapshot makers (`snapshot`, `snapshotOf`,
`snapshotLayer`, `turnSnapshot`, `copyTurn`) and `applySnapshot` stay on the editor: they read and write the whole
document, which is the editor's. The named snapshots (`snapshots`, `takeSnapshot` ...) stay too in step 1.

**Who writes the history from outside today** (read 2026-11-23; everything else only reads `undo.length`, the top
step or `historyGen`):
- `inpaint_canvas.js` 183-206: the fields' first values (they move into the history's constructor).
- `inpaint_ed_liquify.js` 79: takes a step's liquify bytes off the budget (`endLiquify`) - becomes
  `history.shrink(step, bytes)`.
- `inpaint_ed_select.js` 638: `takeUndoEntry` splices a step out - becomes `history.take(step)`.
- `renderer/shell.js` 1494: the assistant's undo step moved under the steps a call pushed - becomes
  `history.moveUnder(step, count)`.
- `plugins/glb/main.js` 192: adds the plugin data's bytes to a step it rides on - becomes `history.grow(step, bytes)`.
- The reads: `undo` 126 uses in 14 files outside `inpaint_ed_history.js`, `redo` 38 in 8, `historyGen` 31 in 12,
  `_undoPending` (a layer's held step, not the history's) 76 in 4. The reads keep working through getters
  (`get undo() { return this.history.steps; }`) until they are moved; moving them is optional.

**The interface** (a sketch; the session settles the names): `push(step, { tracked })`, `take(step)`,
`release(step)`, `grow(step, bytes)`, `shrink(step, bytes)`, `moveUnder(step, count)`, `trim()`, `clear()`,
`setDepth({ steps, mb })`, `list()`, `top`, `canUndo`, `canRedo`, `gen`, `bytes`, and the stack move used by
`historyStepNow` (`popFor(redo)`, `pushOther(step, redo)`). The byte count is the history's alone: only `push`,
`grow`, `shrink` and `release` touch it, and a step carries whether it is counted.

**Done when:** no file but the history module writes `undo`, `redo` or the byte count; the gates `editor`, `commands`,
`selection`, `liquify` (inside `editor`), `glb`, `assistant`, `document`, `docux`, `mcp` and `groups` pass on both
backends; a new plain-Node test of the history object alone (budget never below zero, trim against bytes and steps,
redo dropped on push, take / grow / shrink / moveUnder); `tsc` checks the module.

**As built (2026-11-23).** `renderer/editor/inpaint_history.js`, class `UndoHistory`, `// @ts-check` and in
`tsconfig.check.json`; `this.undoHistory` made in the editor's constructor with the depth and a `release` callback (the
editor's `releaseSnapshot`, which revokes a step's blob URLs and calls `history.uncount`). Its interface:
`push`, `dropRedo`, `trim`, `setDepth(depth, fallback)`, `clear`, `take`, `popTop(redo)`, `pushOther(step, toUndo)`,
`moveUnder(count)`, `count`, `uncount`, `grow`, `shrink`, `rows(labels)`, and `replace(undo, redo)` for tests. The
old names forward through accessors on `InpaintEditor.prototype` (`inpaint_canvas.js`, next to `installParts`):
`undo` and `redo` (setters for tests only), `undoBytes` and `undoTrimmed` (read only), `maxUndo` / `maxUndoBytes`
(set by tests), `historyGen` (set by the parts that bump it). The six writers moved: the constructor, `endLiquify`
(`shrink`), `takeUndoEntry` (`take`), the shell's assistant step (`moveUnder`), the glb plugin (`grow`), and inside
`inpaint_ed_history.js` `pushUndoSnapshot`, `trimUndo`, `setUndoDepth`, `undoList`, `clearUndo`, `releaseSnapshot`
and `historyStepNow`'s stack moves. No file outside `inpaint_history.js` writes the stacks or the count
(`git grep` for `.undo.push|pop|splice|shift`, `.redo.push|pop|splice`, `undoBytes =`, `.undo =`, `.redo =`).
`tools/build_node.py` lists the module; the node's `js/host.js` needs nothing new. `tools/history_test.js` (plain
Node, 22 checks) tests the object alone. Left for later, as optional: moving the many reads (`ed.undo.length`, the
top step) onto `history`, and then dropping the accessors.

## Step 2: the same pattern, one part per session

- **The selection** (`sel`, its bounds cache `cachedBounds` / `selectionDirty` / `selectionLoose`, `selectionSeq`,
  `rangePending`, the encode state `selectionDataUrl` / `selectionEncoded`): the review's
  `select-range-untracked-undo-and-cancel-crash` and `range-add-nothing-matched-bounds-whole-picture` lived in it.
- **The document maps** (`maps`, `mapsVersion`, the wrap links and `wrapGeo`, the surface-map run): the turn
  snapshot's shared `xf` and the restored wrap's geometry lived in it.
- **Relight** (the whole-picture run's state, `relightSettled`, the hidden layers during a read): a run keeps the ids it
  works on and re-reads the layers after every await (`host_relight.js` does it by hand since 2026-11-20).

Each gets its inventory (who writes its fields from outside) at the start of its session, as step 1 has above.

## Step 3: types alongside

- `// @ts-check` on each module of steps 1 and 2 as it is made.
- The host contract: `renderer/editor/host.js`'s typedef without `any` for the members the editor calls, so a member
  the editor calls and the typedef lacks fails `tsc` (today only `build_node.py --check` sees it).
- `strict` stays off for the rest of the code; no file is checked that nobody touches.

## Not part of it

The main process (`main.js`, 1,757 lines), the file sizes (no file above 2,800 lines since item 56), and the tests
(`editor_test.py`, 15,000 lines of Python with JavaScript in strings: it works and only costs time).
