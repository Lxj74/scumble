// Plain-Node test of renderer/editor/inpaint_meshwarp.js, the distort / warp bake by backward mapping (item 73,
// `distort-warp-mesh-seams-on-half-transparent-pixels`): node tools/meshwarp_test.js
// (a) the identity mesh gives the bytes back exactly, a half-transparent layer included;
// (b) a distorted layer of one half-transparent colour keeps that alpha everywhere inside: no grid of seams, and no
//     pixel is written twice (the canvas mesh drew a 0.7 px overlap on every edge: 0.4 alpha became 0.64 there);
// (c) the rim fades over about a pixel instead of stepping, and nothing lands outside the shape;
// (d) a corner shrunk four times reads the box-filtered level: a pixel checkerboard comes out as its mean, not as
//     aliased black or white;
// (e) a warp grid with a fold writes the folded pixels once each (the later triangle) and the rest once.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ROOT = path.join(__dirname, "..");
const load = (name) => import(pathToFileURL(path.join(ROOT, "renderer", "editor", name)).href);
let meshWarp = null;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("FAIL " + msg); } };

const grid = (nx, ny, f) => { const p = []; for (let j = 0; j <= ny; j++) { const r = []; for (let i = 0; i <= nx; i++) r.push(f(i / nx, j / ny)); p.push(r); } return p; };
// the editor's own homography (inpaint_mesh.js), loaded in main()
let HOMO = null;
const homography = (src, dst) => HOMO(src, dst);

async function main() {
    ({ homography: HOMO } = await load("inpaint_mesh.js"));
    ({ meshWarp } = await load("inpaint_meshwarp.js"));
    // (a) identity: 37 x 23, random half-transparent bytes, a 24 x 24 mesh (cells smaller than a pixel too)
    {
        const W = 37, H = 23, src = new Uint8ClampedArray(W * H * 4);
        let s = 7;
        const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s & 255; };
        for (let i = 0; i < src.length; i += 4) { const a = rnd(); src[i + 3] = a; if (a) { src[i] = rnd(); src[i + 1] = rnd(); src[i + 2] = rnd(); } }
        for (const n of [1, 5, 24]) {
            const st = {};
            const out = meshWarp(src, W, H, grid(n, n, (u, v) => [u * W, v * H]), n, n, W, H, null, st);
            let bad = 0;
            for (let i = 0; i < src.length; i++) if (out[i] !== src[i]) bad++;
            ok(bad === 0, `(a) identity n=${n}: ${bad} bytes differ`);
            ok(st.twice === 0 && st.written === W * H, `(a) identity n=${n}: written ${st.written}, twice ${st.twice}`);
        }
    }
    // (b) a 200 x 150 layer of (200, 80, 40, 102) distorted into a quad 1.3 x as large, 24 x 24 mesh
    {
        const W = 200, H = 150, src = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < src.length; i += 4) { src[i] = 200; src[i + 1] = 80; src[i + 2] = 40; src[i + 3] = 102; }
        const quad = [[10, 5], [270, 30], [250, 200], [0, 180]];
        const Hm = homography([[0, 0], [1, 0], [1, 1], [0, 1]], quad);
        const st = {};
        const OW = 280, OH = 210;
        const out = meshWarp(src, W, H, grid(24, 24, (u, v) => Hm(u, v)), 24, 24, OW, OH, null, st);
        // inside: at least 2 px from the quad's edges (by the inverse homography: source more than 2 px from its rim)
        const Hi = homography(quad, [[0, 0], [W, 0], [W, H], [0, H]]);
        let inside = 0, off = 0, worst = 0;
        for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
            const [sx, sy] = Hi(x + 0.5, y + 0.5);
            if (sx < 2 || sy < 2 || sx > W - 2 || sy > H - 2) continue;
            inside++;
            const o = (y * OW + x) * 4, d = Math.max(Math.abs(out[o + 3] - 102), Math.abs(out[o] - 200), Math.abs(out[o + 1] - 80), Math.abs(out[o + 2] - 40));
            if (d > 0) off++;
            worst = Math.max(worst, d);
        }
        ok(inside > 30000 && worst === 0, `(b) the inside of a distorted 40 % layer: ${off} of ${inside} pixels off, worst ${worst}`);
        ok(st.twice === 0, `(b) ${st.twice} pixels written twice`);
        // (c) the rim: outside (source more than 1.5 px past the rectangle) nothing; the ramp across the left edge rises
        let outside = 0;
        for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
            const [sx, sy] = Hi(x + 0.5, y + 0.5);
            if ((sx < -1.5 || sy < -1.5 || sx > W + 1.5 || sy > H + 1.5) && out[(y * OW + x) * 4 + 3]) outside++;
        }
        ok(outside === 0, `(c) ${outside} pixels outside the shape have alpha`);
        let row = 100, ramp = [];
        for (let x = 0; x < 12; x++) ramp.push(out[(row * OW + x) * 4 + 3]);
        const firstFull = ramp.findIndex((a) => a === 102), firstAny = ramp.findIndex((a) => a > 0);
        ok(firstAny >= 0 && firstFull > firstAny && firstFull - firstAny <= 3 && ramp.slice(firstAny, firstFull).every((a, i, r) => a > 0 && a < 102 && (i === 0 || a >= r[i - 1])), `(c) the left rim does not fade over a pixel or two: ${ramp}`);
    }
    // (d) a 256 x 256 checkerboard of single pixels, shrunk to 64 x 64: the mean grey, not aliased
    {
        const W = 256, H = 256, src = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, v = (x + y) & 1 ? 255 : 0; src[i] = src[i + 1] = src[i + 2] = v; src[i + 3] = 255; }
        const out = meshWarp(src, W, H, grid(12, 12, (u, v) => [u * 64, v * 64]), 12, 12, 64, 64);
        let worst = 0;
        for (let y = 2; y < 62; y++) for (let x = 2; x < 62; x++) worst = Math.max(worst, Math.abs(out[(y * 64 + x) * 4] - 128));
        ok(worst <= 2, `(d) a checkerboard shrunk 4 x: worst ${worst} from the mean`);
    }
    // (e) a fold: the middle column of a 2 x 1 grid pushed past the right edge; every pixel still written once or by the fold
    {
        const W = 40, H = 20, src = new Uint8ClampedArray(W * H * 4).fill(255);
        const pts = [[[0, 0], [50, 0], [40, 0]], [[0, 20], [50, 20], [40, 20]]];
        const st = {};
        meshWarp(src, W, H, pts, 2, 1, 60, 20, null, st);
        ok(st.written > 0 && st.twice > 0 && st.twice <= 10 * 20 + 40, `(e) a fold: written ${st.written}, twice ${st.twice}`);
    }
    // the time of a 2048 x 2048 layer through a 24 x 24 distort (not a gate: a number for the notes)
    {
        const W = 2048, H = 2048, src = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < src.length; i += 4) { src[i] = i & 255; src[i + 1] = 90; src[i + 2] = 40; src[i + 3] = 128 + (i & 127); }
        const quad = [[30, 0], [2000, 60], [2048, 2048], [0, 1900]];
        const Hm = homography([[0, 0], [1, 0], [1, 1], [0, 1]], quad);
        const t = performance.now();
        meshWarp(src, W, H, grid(24, 24, (u, v) => Hm(u, v)), 24, 24, 2048, 2048);
        console.log(`time: 2048 x 2048 distort ${Math.round(performance.now() - t)} ms`);
    }
    console.log(`${pass}/${pass + fail}`);
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
