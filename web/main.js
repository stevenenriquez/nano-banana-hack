// Fixed model
const MODEL = 'gemini-2.5-flash-image-preview';

// Elements
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const promptInput = document.getElementById('prompt');
const seedBtn = document.getElementById('seedBtn');
const clearBtn = document.getElementById('clearBtn');

// Retina-safe canvas
let DPR = 1, W = 0, H = 0;
function resizeCanvas() {
  DPR = window.devicePixelRatio || 1;
  W = Math.floor(window.innerWidth);
  H = Math.floor(window.innerHeight);
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  draw();
}
window.addEventListener('resize', resizeCanvas);

// Hex geometry (pointy-top for non-overlapping axial q,r mapping)
const size = 72; // hex radius
const hexW = Math.sqrt(3) * size;
const hexH = 2 * size;
const center = () => ({ x: W / 2, y: H / 2 });

function axialToPixel(q, r) {
  const c = center();
  // pointy-top axial to pixel
  const x = c.x + size * Math.sqrt(3) * (q + r / 2);
  const y = c.y + size * (3 / 2) * r;
  return { x, y };
}

function cubeRound(x, y, z) {
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);
  if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz;
  else if (yDiff > zDiff) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

function pixelToAxial(px, py) {
  const c = center();
  const x = px - c.x;
  const y = py - c.y;
  const qf = (Math.sqrt(3) / 3 * x - 1 / 3 * y) / size;
  const rf = (2 / 3 * y) / size;
  return cubeRound(qf, -qf - rf, rf);
}

function hexPath(q, r) {
  const { x, y } = axialToPixel(q, r);
  const pts = [];
  for (let i = 0; i < 6; i++) {
  // pointy-top: start at 30deg and step by 60deg
  const angle = (Math.PI / 3) * i + Math.PI / 6;
    pts.push([x + size * Math.cos(angle), y + size * Math.sin(angle)]);
  }
  return pts;
}

// hex path for arbitrary center (used in offscreen context/mask building)
function hexPathAt(cx, cy, rad = size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i + Math.PI / 6; // 30deg offset
    pts.push([cx + rad * Math.cos(angle), cy + rad * Math.sin(angle)]);
  }
  return pts;
}

function strokeHex(q, r, color = '#2a2c35', width = 2, dash) {
  const pts = hexPath(q, r);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  if (dash) ctx.setLineDash(dash);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

function fillHex(q, r, color) {
  const pts = hexPath(q, r);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawImageInHex(q, r, img, rotDeg = 0) {
  const pts = hexPath(q, r);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.clip();
  const { x, y } = axialToPixel(q, r);
  // draw rotated image with a tiny bleed to avoid hairline seams
  const bleed = 1.0;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((rotDeg * Math.PI) / 180);
  ctx.drawImage(
    img,
    -hexW / 2 - bleed,
    -hexH / 2 - bleed,
    hexW + bleed * 2,
    hexH + bleed * 2
  );
  ctx.restore();
  ctx.restore();
}

// State
const tiles = new Map(); // key -> { img: HTMLImageElement, b64: string, rot: number }
const generated = new Set(); // keys
const expandable = new Set(); // keys adjacent to generated
let selectedKey = null; // key
const loading = new Set(); // keys currently generating

function key(q, r) { return `${q},${r}`; }
function dekey(k) { const [q, r] = k.split(',').map(Number); return { q, r }; }

function neighbors(q, r) {
  return [
    [q+1, r], [q+1, r-1], [q, r-1], [q-1, r], [q-1, r+1], [q, r+1]
  ];
}

// Build a two-hex context image and a binary mask for the target hex.
// We rotate the source image so the requested direction maps to "east".
function buildContextAndMask(srcImg, dir) {
  const angle = DIR_TO_DEG[dir] || 0;
  const ctxW = Math.ceil(hexW);
  const ctxH = Math.ceil(hexH);

  // Context canvas: just the source tile rotated for the direction
  const c = document.createElement('canvas');
  c.width = ctxW; c.height = ctxH;
  const cctx = c.getContext('2d');
  cctx.clearRect(0, 0, ctxW, ctxH);
  // draw rotated source
  cctx.translate(ctxW / 2, ctxH / 2);
  cctx.rotate((-angle * Math.PI) / 180);
  // small bleed to avoid seams
  const bleed = 1;
  cctx.drawImage(srcImg, -hexW / 2 - bleed, -hexH / 2 - bleed, hexW + bleed * 2, hexH + bleed * 2);
  cctx.rotate((angle * Math.PI) / 180);
  cctx.translate(-ctxW / 2, -ctxH / 2);

  const sourceB64 = c.toDataURL('image/png').split(',')[1];
  return { sourceB64, outRotation: angle };
}

function addExpandableAround(q, r) {
  for (const [nq, nr] of neighbors(q, r)) {
    const k = key(nq, nr);
    if (!generated.has(k)) expandable.add(k);
  }
}

function draw(timeMs = 0) {
  ctx.clearRect(0, 0, W, H);

  // expandable outlines
  expandable.forEach(k => {
    const { q, r } = dekey(k);
    strokeHex(q, r, '#3a3d48', 2, [6, 6]);
  });

  // generated tiles
  generated.forEach(k => {
    const { q, r } = dekey(k);
    const t = tiles.get(k);
    fillHex(q, r, '#101218');
  if (t?.img) drawImageInHex(q, r, t.img, t.rot || 0);
    strokeHex(q, r, k === selectedKey ? '#ffd84a' : '#20222b', k === selectedKey ? 3 : 2);
  });

  // loading overlay spinners
  if (loading.size) {
    const phase = (timeMs / 1000) % 1; // 0..1
    const start = phase * Math.PI * 2;
    const end = start + Math.PI * 1.5;
    loading.forEach(k => {
      const { q, r } = dekey(k);
      const { x, y } = axialToPixel(q, r);
      // dim hex background
      ctx.save();
      ctx.globalAlpha = 0.15;
      fillHex(q, r, '#ffffff');
      ctx.restore();
      // spinner arc
      ctx.beginPath();
      ctx.arc(x, y, Math.min(size * 0.55, 28), start, end);
      ctx.strokeStyle = '#ffd84a';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.stroke();
    });
  }
}

let animId = null;
function ensureAnimating() {
  if (animId) return;
  const loop = (t) => {
    draw(t || 0);
    if (loading.size) animId = requestAnimationFrame(loop);
    else { animId = null; }
  };
  animId = requestAnimationFrame(loop);
}

async function postGenerate({ prompt, imageParts }) {
  const r = await fetch('/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, imageParts, mimeType: 'image/png', model: MODEL })
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`API error ${r.status}: ${txt}`);
  }
  const data = await r.json();
  if (!data.imageData) throw new Error('No image in response');
  return data.imageData;
}

function loadImageFromB64(b64) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/png;base64,${b64}`;
  });
}

async function seedCenter() {
  if (generated.size) return;
  const q = 0, r = 0;
  const prompt = promptInput.value || 'Create a picture of a nano banana dish in a fancy restaurant with a Gemini theme';
  const k = key(q, r);
  loading.add(k); ensureAnimating(); draw();
  let b64;
  try {
    b64 = await postGenerate({ prompt, imageParts: [] });
  } finally {
    loading.delete(k);
  }
  const img = await loadImageFromB64(b64);
  tiles.set(k, { img, b64, rot: 0 });
  generated.add(k);
  selectedKey = k;
  expandable.clear();
  // Pre-populate full ring of 6 adjacent hexes for a clear Catan-like layout
  const ring = [ [1,0], [1,-1], [0,-1], [-1,0], [-1,1], [0,1] ];
  for (const [dq, dr] of ring) {
    const nk = key(q + dq, r + dr);
    if (!generated.has(nk)) expandable.add(nk);
  }
  draw();
}

// pointy-top axial direction names and angles (degrees, clockwise)
function directionName(fromQ, fromR, toQ, toR) {
  if (toQ === fromQ+1 && toR === fromR) return 'east';
  if (toQ === fromQ+1 && toR === fromR-1) return 'northeast';
  if (toQ === fromQ && toR === fromR-1) return 'northwest';
  if (toQ === fromQ-1 && toR === fromR) return 'west';
  if (toQ === fromQ-1 && toR === fromR+1) return 'southwest';
  if (toQ === fromQ && toR === fromR+1) return 'southeast';
  return 'adjacent';
}
const DIR_TO_DEG = {
  east: 0,
  northeast: 60,
  northwest: 120,
  west: 180,
  southwest: 240,
  southeast: 300,
  adjacent: 0,
};

async function extendTo(q, r) {
  const destK = key(q, r);
  if (!expandable.has(destK) || !selectedKey) return;
  if (loading.has(destK)) return;
  const { q: sq, r: sr } = dekey(selectedKey);
  const srcTile = tiles.get(selectedKey);
  if (!srcTile?.b64) return;

  const dir = directionName(sq, sr, q, r);
  const basePrompt = promptInput.value || 'Create a picture of a nano banana dish in a fancy restaurant with a Gemini theme';
  const { sourceB64, outRotation } = buildContextAndMask(srcTile.img, dir);
  const prompt = `${basePrompt}. This is a hex tile. Generate a new hex tile that seamlessly extends this tile to the right, matching the style, colors, and patterns perfectly at the left edge of the new tile. The new tile should be the same size (${Math.round(hexW)}x${Math.round(hexH)} pixels) with transparent background. Return only the new tile as a PNG image.`;

  const parts = [sourceB64];

  loading.add(destK); ensureAnimating(); draw();
  let b64;
  try {
    b64 = await postGenerate({ prompt, imageParts: parts });
  } finally {
    loading.delete(destK);
  }
  const img = await loadImageFromB64(b64);
  // Rotate the returned tile into world orientation; we draw with this rotation
  const rot = outRotation % 360;
  tiles.set(destK, { img, b64, rot });
  generated.add(destK);
  expandable.delete(destK);
  addExpandableAround(q, r);
  selectedKey = destK;
  draw();
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i=0, j=pts.length-1; i<pts.length; j=i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = ((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  // initial guess
  const guess = pixelToAxial(x, y);
  const candidates = [
    [guess.q, guess.r], [guess.q+1, guess.r], [guess.q-1, guess.r],
    [guess.q, guess.r+1], [guess.q, guess.r-1], [guess.q+1, guess.r-1], [guess.q-1, guess.r+1]
  ];
  let hit = null;
  for (const [q, r] of candidates) {
    const pts = hexPath(q, r);
    if (pointInPoly(x, y, pts)) { hit = { q, r }; break; }
  }
  if (!hit) return;
  const k = key(hit.q, hit.r);
  if (generated.has(k)) {
    selectedKey = k;
    draw();
  } else if (expandable.has(k)) {
    if (!loading.has(k)) extendTo(hit.q, hit.r).catch(err => alert(err.message));
  }
});

function clearAll() {
  tiles.clear();
  generated.clear();
  expandable.clear();
  selectedKey = null;
  draw();
}

seedBtn.addEventListener('click', () => seedCenter().catch(e => alert(e.message)));
clearBtn.addEventListener('click', clearAll);

resizeCanvas();
