// Companion-pet sprite generator — the single source of truth for the pet
// pixel art. Run: node scripts/generate_pet_sprites.mjs
//
// Emits, all from the pixel maps in this file (no external assets):
//   public/pets/cat.png | axolotl.png | robot.png   16×16-frame sprite sheets
//   public/pets/hats.png                            cosmetic overlays
//   public/pets/contact-sheet.png                   6× QA sheet (not shipped)
//   src/lib/pets/manifest.ts                        typed frame map for the app
//
// Zero dependencies: PNG encoding is hand-rolled (node:zlib + CRC32). Pixel
// maps are 16×16 char grids, one char per pixel, per-species palette below.
// Rows are right-padded with '.' if short and rejected if too long, so a
// miscount can't silently shift art. If you edit the art, re-run this script
// and eyeball public/pets/contact-sheet.png.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PETS = join(ROOT, "public", "pets");
const OUT_MANIFEST = join(ROOT, "src", "lib", "pets", "manifest.ts");

const FW = 16; // frame width/height in pixels

// ── Pixel-map helpers ────────────────────────────────────────────────────────
// Maps are arrays of 16 strings of 16 chars. '.' = transparent.

function validate(name, map) {
  if (map.length !== FW) throw new Error(`${name}: expected ${FW} rows, got ${map.length}`);
  const rows = map.map((row, y) => {
    if (row.length > FW)
      throw new Error(`${name} row ${y}: ${row.length} chars (max ${FW}): "${row}"`);
    return row.padEnd(FW, ".");
  });
  return rows;
}

/** Vertical shift; vacated rows fill with '.'; pixels pushed off are lost. */
function vshift(map, dy) {
  const blank = ".".repeat(FW);
  const out = [];
  for (let y = 0; y < FW; y++) {
    const sy = y - dy;
    out.push(sy >= 0 && sy < FW ? map[sy] : blank);
  }
  return validate("vshift", out);
}

/** Overwrite a rectangular region with new rows (top-left at x,y), clipped
 *  to the frame. '\u0000' chars inside a patch row leave the pixel unchanged. */
function patch(map, x, y, rows) {
  const grid = map.map((r) => r.split(""));
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const px = x + rx;
      const py = y + ry;
      if (px < 0 || px >= FW || py < 0 || py >= FW) continue;
      const c = row[rx];
      if (c !== "\u0000") grid[py][px] = c;
    }
  });
  return validate("patch", grid.map((r) => r.join("")));
}

/** Horizontal shift (trembles, sways); vacated columns fill with '.'. */
function hshift(map, dx) {
  const out = map.map((row) => {
    if (dx > 0) return (".".repeat(dx) + row).slice(0, FW);
    if (dx < 0) return (row + ".".repeat(-dx)).slice(-FW);
    return row;
  });
  return validate("hshift", out);
}

const KEEP = "\u0000";

// ── PNG encoder (RGBA8, no deps) ─────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Render rows of frames into one sheet PNG. */
function renderSheet(rowsOfMaps, palette) {
  const cols = Math.max(...rowsOfMaps.map((r) => r.length));
  const width = cols * FW;
  const height = rowsOfMaps.length * FW;
  const rgba = Buffer.alloc(width * height * 4);
  rowsOfMaps.forEach((maps, row) => {
    maps.forEach((map, col) => {
      for (let y = 0; y < FW; y++) {
        for (let x = 0; x < FW; x++) {
          const ch = map[y][x];
          if (ch === ".") continue;
          const hex = palette[ch];
          if (!hex) throw new Error(`Unknown palette char '${ch}' at row ${row} frame ${col} ${y}:${x}`);
          const idx = ((row * FW + y) * width + col * FW + x) * 4;
          rgba[idx] = parseInt(hex.slice(1, 3), 16);
          rgba[idx + 1] = parseInt(hex.slice(3, 5), 16);
          rgba[idx + 2] = parseInt(hex.slice(5, 7), 16);
          rgba[idx + 3] = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255;
        }
      }
    });
  });
  return encodePNG(width, height, rgba);
}

// ═════════════════════════════════════════════════════════════════════════════
// ART — front-facing chibi pets, 16×16. Feet on y=13, y14-15 left empty
// (hop/jump headroom at the bottom; walk/celebrate shift the sprite up).
// ═════════════════════════════════════════════════════════════════════════════

// ── CAT — soft blue-gray, light muzzle/belly, pink ears ─────────────────────
const CAT = {
  palette: {
    o: "#3a3550", // outline
    b: "#a9b2c6", // body
    d: "#8d97af", // shade
    l: "#edf1f8", // light — muzzle / belly
    p: "#f3b7c9", // pink — ears, nose
    e: "#2e2a44", // eye
    w: "#ffffff", // glint
    x: "#ff8fae", // effect — hearts
    c: "#7ec8e8", // effect — sweat
  },
  stand: validate("cat.stand", [
    "................",
    "....o......o....",
    "..oppo....oppo..",
    "...obbooooobbo..",
    "..obbbbbbbbbbo..",
    "..obbwebbwebbo..",
    "..obbeebbeebbo..",
    "..obbblpplbbbo..",
    "...obbbbbbbbo...",
    "..obbllllllbbo..",
    "..obbllllllbbo..",
    "..obbllllllbbo..",
    "...obbbbbbbbo...",
    "....oo....oo....",
    "................",
    "................",
  ]),
  crouch: validate("cat.crouch", [
    "................",
    "................",
    "................",
    "................",
    "....o......o....",
    "..oppo....oppo..",
    "...obbooooobbo..",
    "..obbbbbbbbbbo..",
    "..obbwebbwebbo..",
    "..obbeebbeebbo..",
    "..obbblpplbbbo..",
    "...obbbbbbbbo...",
    "..obbbbbbbbbbo..",
    "...oo......oo...",
    "................",
    "................",
  ]),
  curl: validate("cat.curl", [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "....o......o....",
    "..oppo....oppo..",
    "...obbooooobbo..",
    "..obbbbbbbbbbo..",
    "..obbooobbooob..",
    "..obbbbbbbbbbo..",
    "..obbbbbbbbbbo..",
    "...oooooooooo...",
    "................",
  ]),
  workBase: validate("cat.workBase", [
    "................",
    "....o......o....",
    "..oppo....oppo..",
    "...obbooooobbo..",
    "..obbbbbbbbbbo..",
    "..obbwebbwebbo..",
    "..obbeebbeebbo..",
    "..obbblpplbbbo..",
    "...obbbbbbbbo...",
    "..obbllllllbbo..",
    "..obbllllllbbo..",
    "..obbllllllbbo..",
    "..oddddddddddo..",
    "..oooooooooooo..",
    "................",
    "................",
  ]),
};

// Cat frame derivations (eyes sit at x5-6 and x9-10, rows y5-y6)
const catBlink = (m) => patch(patch(m, 5, 5, ["bb", "oo"]), 9, 5, ["bb", "oo"]);
// Happy: ^_^ eyes, a drawn smile, and hearts floating beside the head.
const catHappyEyes = (m) => {
  const eyes = patch(patch(m, 5, 4, ["e.", ".e"]), 9, 4, ["e.", ".e"]);
  const smile = patch(eyes, 6, 8, ["oo"]);
  return patch(patch(smile, 1, 3, ["x.", "xx", "x."]), 14, 2, ["xx", "x."]);
};
// Concerned: slump 1px + ears folded flat + sweat drip + a small worried
// mouth; frame B trembles 1px and the drip moves down.
const catSadBase = patch(
  patch(patch(vshift(CAT.stand, 1), 4, 2, ["d......d"]), 4, 3, ["d......d"]),
  6, 8, ["oo"],
);
const catSad = patch(catSadBase, 14, 4, ["c", "c", "c"]);
const catSadB = hshift(patch(catSadBase, 14, 5, ["c", "c", "c"]), 1);
// Working: half-closed "focusing" eyes, both paws on the keyboard with one
// raised per frame, and an accent key lighting up under them.
const catWorkLid = (m) => patch(patch(m, 5, 5, ["dd", "dd"]), 10, 5, ["dd", "dd"]);
const catWorkA = patch(
  patch(catWorkLid(CAT.workBase), 4, 10, ["pp....pp"]),
  4, 11, ["pp......"],
);
const catWorkB = patch(
  patch(catWorkLid(CAT.workBase), 4, 10, ["pp....pp"]),
  4, 11, ["......pp"],
);
const catWorkA2 = patch(catWorkA, 7, 12, ["x"]);
const catWorkB2 = patch(catWorkB, 8, 12, ["x"]);

// ── AXOLOTL — pink, coral gill frills, big happy eyes, wide smile ───────────
const AXY = {
  palette: {
    o: "#5c3a4e", // outline
    b: "#f6a9c6", // body
    d: "#e78cb2", // shade
    l: "#fde9f3", // light — belly
    g: "#ff7fa2", // gill frills
    e: "#4a2c3e", // eye
    w: "#ffffff", // glint
    m: "#d96a92", // smile
    x: "#ff5f85", // effect — hearts
    c: "#a8dcf5", // effect — sweat
  },
  stand: validate("axy.stand", [
    "................",
    "................",
    "....oooooooo....",
    "...obbbbbbbbbo..",
    "..obbwebbwebbo..",
    "..obbeebbeebbo..",
    "..obbmmmmmmbbo..",
    "...obbbbbbbbbo..",
    "....oblllllbo...",
    "....oblllllbo...",
    "....oblllllbo...",
    "....oblllllbo...",
    "....oblllllbo...",
    ".....oo....oo...",
    "................",
    "................",
  ]),
  crouch: validate("axy.crouch", [
    "................",
    "................",
    "................",
    "................",
    "................",
    "....oooooooo....",
    "...obbbbbbbbbo..",
    "..obbwebbwebbo..",
    "..obbeebbeebbo..",
    "..obbmmmmmmbbo..",
    "...obbbbbbbbbo..",
    "...obblllllbbo..",
    "...obblllllbbo..",
    "..obbbbbbbbbbo..",
    "..oooooooooooo..",
    "................",
  ]),
  curl: validate("axy.curl", [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "....oooooooo....",
    "...obbbbbbbbbo..",
    "..obbbbbbbbbbo..",
    "..obboobboobbo..",
    "..obbmmmmmmbbo..",
    "..obbbbbbbbbbo..",
    "...oooooooooo...",
    "................",
  ]),
  workBase: validate("axy.workBase", [
    "................",
    "................",
    "....oooooooo....",
    "...obbbbbbbbbo..",
    "..obbwebbwebbo..",
    "..obbeebbeebbo..",
    "..obbmmmmmmbbo..",
    "...obbbbbbbbbo..",
    "....oblllllbo...",
    "....oblllllbo...",
    "....oblllllbo...",
    "....oblllllbo...",
    "..oddddddddddo..",
    "..oooooooooooo..",
    "................",
    "................",
  ]),
};
const axyBlink = (m) => patch(patch(m, 5, 4, ["bb", "oo"]), 9, 4, ["bb", "oo"]);
// Happy: ^_^ eyes + hearts flanking the head (the wide smile is already there).
const axyHappyEyes = (m) => {
  const eyes = patch(patch(m, 5, 3, ["e.", ".e"]), 9, 3, ["e.", ".e"]);
  return patch(patch(eyes, 0, 2, ["x.", "xx", "x."]), 14, 2, ["xx", "x."]);
};
// Gill frills: three attached 1px nubs per side, staggered down the head
// edge (a frill that doesn't touch the head reads as floating confetti).
const axyNubs = (map, dy) =>
  [[1, 4 + dy], [14, 4 + dy], [1, 6 + dy], [14, 6 + dy], [2, 7 + dy], [13, 7 + dy]].reduce(
    (m, [x, y]) => patch(m, x, y, ["g"]),
    map,
  );
const axyStand = axyNubs(AXY.stand, 0);
const axyCrouch = axyNubs(AXY.crouch, 3);
// Dozing: frills rest — one relaxed pair at the widest head row.
const axyCurl = patch(patch(AXY.curl, 1, 10, ["g"]), 14, 10, ["g"]);
// Concerned: slump, top frills droop off, wavy mouth, sweat drip + tremble.
const axySadBase = patch(
  patch(patch(vshift(axyStand, 1), 1, 5, ["."]), 14, 5, ["."]),
  6, 7, ["m....m"],
);
const axySad = patch(axySadBase, 14, 4, ["c", "c", "c"]);
const axySadB = hshift(patch(axySadBase, 14, 5, ["c", "c", "c"]), 1);
// Working: half-lidded eyes, tapping paws, one lit key per frame.
const axyWorkLid = (m) => patch(patch(m, 5, 4, ["dd", "dd"]), 10, 4, ["dd", "dd"]);
const axyWorkA = patch(
  patch(axyWorkLid(axyNubs(AXY.workBase, 0)), 5, 10, ["dd..dd"]),
  5, 11, ["dd...."],
);
const axyWorkB = patch(
  patch(axyWorkLid(axyNubs(AXY.workBase, 0)), 5, 10, ["dd..dd"]),
  5, 11, ["....dd"],
);
const axyWorkA2 = patch(axyWorkA, 7, 12, ["x"]);
const axyWorkB2 = patch(axyWorkB, 8, 12, ["x"]);

// ── ROBOT — steel chassis, dark screen face, teal glow ──────────────────────
const BOT = {
  palette: {
    o: "#2f3444", // outline
    b: "#b7c3d6", // chassis
    d: "#93a1b8", // shade
    l: "#e8edf5", // panel light
    a: "#5fd4c4", // accent teal (antenna, buttons)
    s: "#232838", // screen
    e: "#7ef0dc", // eye glow
    w: "#ffffff", // glint
    x: "#ff8fae", // effect — hearts
    c: "#6fb8e8", // effect — sweat
  },
  stand: validate("bot.stand", [
    "........a.......",
    "........o.......",
    "...oooooooooo...",
    "..obssssssssbo..",
    "..obseesseesbo..",
    "..obseesseesbo..",
    "..obssseesssbo..",
    "..obbsssssssbo..",
    "..obbbbbbbbbbo..",
    "..obllalllalbo..",
    "..obllllllllbo..",
    "..obbllllllbbo..",
    "...obbbbbbbbo...",
    "....oo....oo....",
    "................",
    "................",
  ]),
  crouch: validate("bot.crouch", [
    "................",
    "................",
    "................",
    "........a.......",
    "........o.......",
    "...oooooooooo...",
    "..obssssssssbo..",
    "..obseesseesbo..",
    "..obseesseesbo..",
    "..obssseesssbo..",
    "..obbsssssssbo..",
    "..obbbbbbbbbbo..",
    "..obbbbbbbbbbo..",
    "...oo......oo...",
    "................",
    "................",
  ]),
  curl: validate("bot.curl", [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "........a.......",
    "...oooooooooo...",
    "..obssssssssbo..",
    "..obssddddssbo..",
    "..obssssssssbo..",
    "..obbbbbbbbbbo..",
    "..obbbbbbbbbbo..",
    "...oooooooooo...",
    "................",
  ]),
  workBase: validate("bot.workBase", [
    "........a.......",
    "........o.......",
    "...oooooooooo...",
    "..obssssssssbo..",
    "..obseesseesbo..",
    "..obseesseesbo..",
    "..obssseesssbo..",
    "..obbsssssssbo..",
    "..obbbbbbbbbbo..",
    "..obllalllalbo..",
    "..obllllllllbo..",
    "..obbllllllbbo..",
    "..oddddddddddo..",
    "..oooooooooooo..",
    "................",
    "................",
  ]),
};
const botBlink = (m) => patch(patch(m, 5, 4, ["ss", "ss"]), 9, 4, ["ss", "ss"]);
// Happy robot: eyes stay lit, the mouth glow widens into a grin, hearts beside
// the antenna.
const botHappyEyes = (m) => {
  const grin = patch(m, 7, 6, ["eeee"]);
  return patch(patch(grin, 1, 1, ["x.", "xx", "x."]), 14, 2, ["xx", "x."]);
};
// Concerned robot: dim the eye glow, slump, sweat drip off the chassis edge +
// a 1px tremble between frames.
const botSadBase = patch(patch(vshift(BOT.stand, 1), 5, 5, ["dd", "dd"]), 10, 5, ["dd", "dd"]);
const botSad = patch(botSadBase, 14, 3, ["c", "c", "c"]);
const botSadB = hshift(patch(botSadBase, 14, 4, ["c", "c", "c"]), 1);
// Working: gaze lowered on the screen, tapping accent arms, one lit key.
const botWorkLid = (m) => patch(patch(m, 5, 4, ["ss", "ss"]), 10, 4, ["ss", "ss"]);
const botWorkA = patch(
  patch(botWorkLid(BOT.workBase), 5, 10, ["aa..aa"]),
  5, 11, ["aa...."],
);
const botWorkB = patch(
  patch(botWorkLid(BOT.workBase), 5, 10, ["aa..aa"]),
  5, 11, ["....aa"],
);
const botWorkA2 = patch(botWorkA, 7, 12, ["x"]);
const botWorkB2 = patch(botWorkB, 8, 12, ["x"]);

// ── Animation assembly ───────────────────────────────────────────────────────
// Row order is fixed and shared by every species (matches PetMood):
// 0 idle · 1 walk · 2 work · 3 celebrate · 4 concerned · 5 doze · 6 happy
// 7 teleport-out · 8 teleport-in

/** Scanline-dissolve teleport: the standing pose breaks into horizontal
 *  slices while pixels of it stream upward, ending in a scattered column +
 *  a pile at the feet. Classic, and reads instantly at 48px. */
function buildTele(S, spark) {
  const blank = ".".repeat(FW);
  const frames = [];
  for (let i = 1; i <= 3; i++) {
    const rows = S.stand.map((row, y) => ((y + i) % 4 < 4 - i ? row : blank));
    const m = rows.map((r) => r.split(""));
    const spots = [[7, 3], [9, 1], [5, 5], [11, 2], [8, 4]];
    for (let k = 0; k <= i; k++) {
      const [sx, sy] = spots[k];
      const ty = sy - i;
      if (ty >= 0 && sy < FW) m[ty][sx] = k % 2 === 0 ? spark : "w";
    }
    frames.push(validate(`tele-out-${i}`, m.map((r) => r.join(""))));
  }
  const last = Array.from({ length: FW }, () => blank);
  const pile = [[5, 13], [7, 13], [9, 13], [11, 13], [8, 10], [7, 7], [9, 4], [7, 1]];
  pile.forEach(([px, py], k) => {
    last[py] = last[py].substring(0, px) + (k % 2 ? "w" : spark) + last[py].substring(px + 1);
  });
  frames.push(validate("tele-out-4", last));
  return frames;
}

function buildSpecies(S, fns, confetti) {
  const { blink, happyEyes, sad, sadB, workA, workB } = fns;
  const hop = vshift(S.stand, -1);
  const air = vshift(S.stand, -2);
  // Cheer: airborne + a sparkle of confetti down both sides.
  const cheer = patch(patch(air, 1, 2, [confetti, ".", confetti]), 14, 2, [confetti, ".", confetti]);
  const happyBounce = vshift(happyEyes(S.stand), -1);
  const teleOut = buildTele(S, confetti);
  const teleIn = teleOut.slice().reverse();
  return [
    [S.stand, blink(S.stand)], // 0 idle
    [S.stand, hop], // 1 walk
    [workA, workB], // 2 work
    [S.crouch, air, cheer, S.crouch], // 3 celebrate
    [sad, sadB], // 4 concerned
    [S.curl], // 5 doze
    [happyEyes(S.stand), happyBounce], // 6 happy
    teleOut, // 7 teleport-out
    teleIn, // 8 teleport-in
  ];
}

const catFrames = buildSpecies(CAT, {
  blink: catBlink, happyEyes: catHappyEyes, sad: catSad, sadB: catSadB,
  workA: catWorkA2, workB: catWorkB2,
}, "p");
const axyFrames = buildSpecies(
  { stand: axyStand, crouch: axyCrouch, curl: axyCurl },
  { blink: axyBlink, happyEyes: axyHappyEyes, sad: axySad, sadB: axySadB,
    workA: axyWorkA2, workB: axyWorkB2 },
  "g",
);
const botFrames = buildSpecies(BOT, {
  blink: botBlink, happyEyes: botHappyEyes, sad: botSad, sadB: botSadB,
  workA: botWorkA2, workB: botWorkB2,
}, "a");

// ── Hats (shared overlay sheet, one 16×16 frame each) ────────────────────────
const HAT = {
  palette: {
    o: "#3a3550",
    r: "#ff6f91", // party
    y: "#ffd166", // gold / stars
    u: "#7b68d9", // wizard
    k: "#4a4560", // headphones dark
  },
  frames: [
    // party hat
    validate("hat.party", [
      "................",
      ".......y........",
      ".......o........",
      "......oro.......",
      "......orro......",
      ".....orrro......",
      ".....orrrro.....",
      "....orrrrrro....",
      "....oooooooo....",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ]),
    // headphones
    validate("hat.headphones", [
      "................",
      "....oooooooo....",
      "...ok......ko...",
      "..ok........ko..",
      ".okk........kko.",
      ".orro......orro.",
      ".orro......orro.",
      ".okk........kko.",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ]),
    // wizard hat
    validate("hat.wizard", [
      "................",
      ".......u........",
      "......uuu.......",
      "......uyu.......",
      ".....uuuuu......",
      ".....uuyuu......",
      "....uuuuuuu.....",
      "..uuuuuuuuuuu...",
      ".uuuuuuuuuuuuu..",
      ".ooooooooooooo..",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ]),
    // crown
    validate("hat.crown", [
      "................",
      "................",
      "................",
      "................",
      "...y...y...y....",
      "...y..yyy..y....",
      "..yyy.yyy.yyy...",
      "..yyyyyyyyyyy...",
      "..yyyyyyyyyyy...",
      "..ooooooooooo...",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ]),
  ],
};

// ── Contact sheet (QA): each species' rows at 6× on a checkerboard ───────────
function renderContactSheet() {
  const scale = 6;
  const pad = 8;
  const sheetCols = 4;
  const rowsPerSpecies = 9;
  const sheets = [
    ["cat", catFrames, CAT.palette],
    ["axolotl", axyFrames, AXY.palette],
    ["robot", botFrames, BOT.palette],
    ["hats", [HAT.frames], HAT.palette],
  ];
  const w = (sheetCols * FW * scale + pad * 2) * sheets.length + pad;
  const h = rowsPerSpecies * FW * scale + pad * 2 + 10;
  const rgba = Buffer.alloc(w * h * 4);
  const put = (x, y, hex) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    rgba[i] = parseInt(hex.slice(1, 3), 16);
    rgba[i + 1] = parseInt(hex.slice(3, 5), 16);
    rgba[i + 2] = parseInt(hex.slice(5, 7), 16);
    rgba[i + 3] = 255;
  };
  // checkerboard
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) put(x, y, (x >> 3) + (y >> 3) & 1 ? "#20242e" : "#272c38");
  sheets.forEach(([name, frames, palette], si) => {
    const ox = pad + si * (sheetCols * FW * scale + pad * 2);
    const oy = pad + 10;
    frames.forEach((maps, row) => {
      maps.forEach((map, col) => {
        for (let y = 0; y < FW; y++)
          for (let x = 0; x < FW; x++) {
            const ch = map[y][x];
            if (ch === ".") continue;
            const hex = palette[ch];
            for (let dy = 0; dy < scale; dy++)
              for (let dx = 0; dx < scale; dx++)
                put(ox + (col * FW + x) * scale + dx, oy + (row * FW + y) * scale + dy, hex);
          }
      });
    });
  });
  return { png: encodePNG(w, h, rgba), w, h };
}

// ── Manifest ─────────────────────────────────────────────────────────────────
const ANIMS = [
  { key: "idle", frames: 2, fps: 1.2 },
  { key: "walk", frames: 2, fps: 5 },
  { key: "work", frames: 2, fps: 4 },
  { key: "celebrate", frames: 4, fps: 6 },
  { key: "concerned", frames: 2, fps: 2 },
  { key: "doze", frames: 1, fps: 1 },
  { key: "happy", frames: 2, fps: 4 },
  { key: "teleout", frames: 4, fps: 10 },
  { key: "telein", frames: 4, fps: 10 },
  { key: "zoomies", frames: 2, fps: 10 },
];

function manifestSource() {
  const lines = [];
  lines.push(`// GENERATED by scripts/generate_pet_sprites.mjs — do not edit by hand.`);
  lines.push(`// Re-run \`node scripts/generate_pet_sprites.mjs\` after editing the art.`);
  lines.push(``);
  lines.push(`export const PET_FRAME = ${FW};`);
  lines.push(`export const PET_SHEET_COLS = 4;`);
  lines.push(`export const PET_SHEET_ROWS = ${ANIMS.length};`);
  lines.push(``);
  lines.push(`export type PetAnimKey =
  | "idle"
  | "walk"
  | "work"
  | "celebrate"
  | "concerned"
  | "doze"
  | "happy"
  | "teleout"
  | "telein"
  | "zoomies";`);
  lines.push(``);
  lines.push(`export interface PetAnim { row: number; frames: number; fps: number }`);
  lines.push(``);
  lines.push(`export const PET_ANIMS: Record<PetAnimKey, PetAnim> = {`);
  ANIMS.forEach((a, i) => lines.push(`  ${a.key}: { row: ${i}, frames: ${a.frames}, fps: ${a.fps} },`));
  lines.push(`};`);
  lines.push(``);
  lines.push(`export interface PetSpeciesDef {`);
  lines.push(`  sheet: string;`);
  lines.push(`  /** Frame-space point the hat overlay is centred on (hat sits above it). */`);
  lines.push(`  hatAnchor: { x: number; y: number };`);
  lines.push(`  /** Silhouette-specific anchors: the curled doze and crouched celebrate`);
  lines.push(`   *  poses carry the head much lower than the standing pose. */`);
  lines.push(`  hatAnchorDoze: { x: number; y: number };`);
  lines.push(`  hatAnchorCelebrate: { x: number; y: number };`);
  lines.push(`  /** Display name used as the default pet name. */`);
  lines.push(`  defaultName: string;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`export const PET_SPECIES: Record<"cat" | "axolotl" | "robot", PetSpeciesDef> = {`);
  lines.push(`  cat: { sheet: "/pets/cat.png", hatAnchor: { x: 8, y: 2 }, hatAnchorDoze: { x: 8, y: 8 }, hatAnchorCelebrate: { x: 8, y: 5 }, defaultName: "Mochi" },`);
  lines.push(`  axolotl: { sheet: "/pets/axolotl.png", hatAnchor: { x: 8, y: 3 }, hatAnchorDoze: { x: 8, y: 8 }, hatAnchorCelebrate: { x: 8, y: 6 }, defaultName: "Bloop" },`);
  lines.push(`  robot: { sheet: "/pets/robot.png", hatAnchor: { x: 8, y: 1 }, hatAnchorDoze: { x: 8, y: 6 }, hatAnchorCelebrate: { x: 8, y: 4 }, defaultName: "Bolt" },`);
  lines.push(`};`);
  lines.push(``);
  lines.push(`export const PET_HATS = {`);
  lines.push(`  sheet: "/pets/hats.png",`);
  lines.push(`  frame: ${FW},`);
  lines.push(`  keys: ["party", "headphones", "wizard", "crown"] as const,`);
  lines.push(`};`);
  lines.push(``);
  lines.push(`export type PetHatKey = (typeof PET_HATS.keys)[number];`);
  lines.push(``);
  lines.push(`/** Lowest art row of each hat within its 16×16 frame — runtime raises`);
  lines.push(` *  each hat so this row lands on the species hatAnchor.y. */`);
  lines.push(`export const PET_HAT_BOTTOM: Record<PetHatKey, number> = {`);
  lines.push(`  party: 8,`);
  lines.push(`  headphones: 7,`);
  lines.push(`  wizard: 9,`);
  lines.push(`  crown: 9,`);
  lines.push(`};`);
  return lines.join("\n") + "\n";
}

// ── Emit ─────────────────────────────────────────────────────────────────────
if (process.argv.includes("--debug")) {
  const bbox = (map) => {
    let minY = FW, maxY = -1, minX = FW, maxX = -1;
    map.forEach((row, y) => {
      for (let x = 0; x < FW; x++)
        if (row[x] !== ".") {
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        }
    });
    return { minY, maxY, minX, maxX };
  };
  const all = [["cat", catFrames], ["axolotl", axyFrames], ["robot", botFrames]];
  for (const [name, frames] of all) {
    console.log(`\n== ${name} ==`);
    frames.forEach((maps, row) => {
      maps.forEach((map, col) => {
        const b = bbox(map);
        console.log(
          `  anim ${row} frame ${col}: y ${b.minY}..${b.maxY}  x ${b.minX}..${b.maxX}` +
            (b.maxY < 0 ? "  (EMPTY!)" : ""),
        );
      });
    });
    console.log(`  doze frame ASCII:`);
    frames[5][0].forEach((r) => console.log(`    |${r}|`));
  }
}

mkdirSync(OUT_PETS, { recursive: true });
mkdirSync(dirname(OUT_MANIFEST), { recursive: true });

writeFileSync(join(OUT_PETS, "cat.png"), renderSheet(catFrames, CAT.palette));
writeFileSync(join(OUT_PETS, "axolotl.png"), renderSheet(axyFrames, AXY.palette));
writeFileSync(join(OUT_PETS, "robot.png"), renderSheet(botFrames, BOT.palette));
writeFileSync(join(OUT_PETS, "hats.png"), renderSheet([HAT.frames], HAT.palette));
const contact = renderContactSheet();
writeFileSync(join(OUT_PETS, "contact-sheet.png"), contact.png);
writeFileSync(OUT_MANIFEST, manifestSource());

console.log(`pet sprites written:`);
console.log(`  public/pets/{cat,axolotl,robot,hats}.png  (4×7 grid of 16×16 frames)`);
console.log(`  public/pets/contact-sheet.png             (${contact.w}×${contact.h} QA sheet)`);
console.log(`  src/lib/pets/manifest.ts`);
