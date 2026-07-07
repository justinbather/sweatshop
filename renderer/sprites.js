/* sprites.js
 * Hand-authored pixel art. Characters share one humanoid template (12x16 body +
 * 4-row leg frames) so the four agents stay visually consistent; per-role color
 * palettes + small props (headset, beret, visor, glasses) make them distinct.
 *
 * A "sprite" is an array of equal-length strings. Each character is a key into a
 * palette map ('.' = transparent). pixel.js renders them at integer scale with
 * smoothing off, so every pixel stays crisp.
 */

// ---- shared humanoid template (12 wide) -------------------------------------
// keys: o outline | h hair H hairshade | s skin S skinshade | c cloth C clothshade
//       a accent | b belt | w eyewhite | k pupil | p pants P pantsshade | u shoe
const BODY = [
  '...oooooo...',
  '..ohhhhhho..',
  '.ohhhhhhhho.',
  '.ohHhhhhHho.',
  '.osssssssso.',
  '.oswksskwso.',
  '.osssssssso.',
  '..oSssssSo..',
  '..cccaaccc..',
  '.cccaaaaccc.',
  '.cCcaaaacCc.',
  '.cccaaaaccc.',
  '.cccccccccc.',
  '.sCcccccccS.',
  '..bbbbbbbb..',
  '..pppppppp..'
];

// three leg frames (4 rows each) for a simple contact / pass / contact walk
const LEGS = [
  [ // frame 0 - stand / contact
    '..pp..pp..',
    '..pp..pp..',
    '..PP..PP..',
    '.uuu.uuu..'
  ],
  [ // frame 1 - left forward
    '..pp..pp..',
    '..pp..pp..',
    '.PP....PP.',
    'uuu....uuu'
  ],
  [ // frame 2 - right forward (mirror feel)
    '..pp..pp..',
    '..pp..pp..',
    '.PP....PP.',
    '.uuu.uuu..'
  ]
];

// pad leg rows to 12 wide, centered, so they align with the body grid
function padLeg(rows) {
  return rows.map(r => {
    const total = 12 - r.length;
    const left = Math.floor(total / 2);
    return '.'.repeat(left) + r + '.'.repeat(total - left);
  });
}
const LEG_FRAMES = LEGS.map(padLeg);

// per-role palettes. accent doubles as the agent's signature color across the app.
const ROLE = {
  research: {
    accent: '#4fc3e8',
    palette: {
      o: '#0a0814', h: '#2b3a52', H: '#1d2a3e', s: '#e8b894', S: '#c98e6a',
      c: '#27506b', C: '#1b3a50', a: '#4fc3e8', b: '#13202c', w: '#f4f1ff',
      k: '#1a1430', p: '#202a3a', P: '#161e2a', u: '#0e1620'
    },
    prop: 'headset'
  },
  content: {
    accent: '#f4b04a',
    palette: {
      o: '#0a0814', h: '#6b3b1f', H: '#4d2a16', s: '#e8b894', S: '#c98e6a',
      c: '#8a5a1e', C: '#664015', a: '#f4b04a', b: '#3a2410', w: '#f4f1ff',
      k: '#1a1430', p: '#3a2c1a', P: '#2a2012', u: '#1a120a'
    },
    prop: 'beret'
  },
  creation: {
    accent: '#ed5fa6',
    palette: {
      o: '#0a0814', h: '#3a1f33', H: '#291624', s: '#e8b894', S: '#c98e6a',
      c: '#7a2a55', C: '#5a1f3f', a: '#ed5fa6', b: '#2a0f1d', w: '#f4f1ff',
      k: '#1a1430', p: '#2e1726', P: '#22111c', u: '#160a12'
    },
    prop: 'visor'
  },
  orchestrator: {
    accent: '#5ad6a0',
    palette: {
      o: '#0a0814', h: '#23402f', H: '#172b20', s: '#e8b894', S: '#c98e6a',
      c: '#235640', C: '#183c2c', a: '#5ad6a0', b: '#0f241a', w: '#f4f1ff',
      k: '#1a1430', p: '#1c2a22', P: '#131e18', u: '#0c1410'
    },
    prop: 'glasses'
  },
  poster: {
    accent: '#56b6f0',
    palette: {
      o: '#0a0814', h: '#2a2b3e', H: '#1c1d2c', s: '#e8b894', S: '#c98e6a',
      c: '#2b5b7a', C: '#1e4258', a: '#56b6f0', b: '#14202c', w: '#f4f1ff',
      k: '#1a1430', p: '#202a3a', P: '#161e2a', u: '#0e1620'
    },
    prop: 'headset'
  }
};

// ---- furniture / prop sprites (drawn as colored rects in pixel.js mostly,
//      but a couple of detailed props live here as sprites) -------------------
const PLANT = [
  '..g..g..',
  '.gGg.gGg',
  'gGGGgGGG',
  '.gGGGGg.',
  '..gGGg..',
  '...tt...',
  '..tTTt..',
  '..tTTt..',
  '..oTTo..'
];
const PLANT_PAL = { '.': null, g: '#3fa56a', G: '#2c7a4c', t: '#b9743a', T: '#8a5328', o: '#0a0814' };

window.SPRITES = { BODY, LEG_FRAMES, ROLE, PLANT, PLANT_PAL };
