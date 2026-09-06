// Visible mouse cursor overlay inside the guest page. Electron's display-media
// capture of the webview does not include the OS pointer, so record/replay/video
// need this synthetic cursor to show where actions happen.
'use strict';

const CURSOR_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
      <path d="M4 3 L4 22 L10 16 L14 24 L17 23 L13 15 L21 15 Z"
        fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>`
  );

let root = null;
let tip = null;
let clickRing = null;
let visible = false;
let x = 24;
let y = 24;
let moveTimer = null;

function ensure() {
  if (root && root.isConnected) return root;
  root = document.createElement('div');
  root.id = '__braiwser_cursor';
  root.setAttribute('data-caos', 'cursor');
  root.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:28px',
    'height:28px',
    'margin:0',
    'padding:0',
    'z-index:2147483646',
    'pointer-events:none',
    'transform:translate(-2px,-2px)',
    'transition:none',
    'opacity:0',
    'will-change:transform,opacity',
  ].join(';');

  tip = document.createElement('img');
  tip.src = CURSOR_SVG;
  tip.alt = '';
  tip.draggable = false;
  tip.style.cssText = 'display:block;width:28px;height:28px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));';
  root.appendChild(tip);

  clickRing = document.createElement('div');
  clickRing.setAttribute('data-caos', 'cursor-ring');
  clickRing.style.cssText = [
    'position:fixed',
    'width:22px',
    'height:22px',
    'margin:-11px 0 0 -11px',
    'border-radius:50%',
    'border:2px solid #3ddc97',
    'box-shadow:0 0 0 3px rgba(61,220,151,.35)',
    'pointer-events:none',
    'z-index:2147483645',
    'opacity:0',
    'transform:scale(.4)',
    'transition:opacity .18s ease, transform .18s ease',
  ].join(';');

  (document.documentElement || document.body).appendChild(clickRing);
  (document.documentElement || document.body).appendChild(root);
  paint();
  return root;
}

function paint() {
  if (!root) return;
  root.style.transform = `translate(${Math.round(x) - 2}px, ${Math.round(y) - 2}px)`;
  root.style.opacity = visible ? '1' : '0';
}

function show() {
  ensure();
  visible = true;
  paint();
}

function hide() {
  visible = false;
  if (root) root.style.opacity = '0';
  if (clickRing) {
    clickRing.style.opacity = '0';
    clickRing.style.transform = 'scale(.4)';
  }
}

function setPosition(nx, ny, { instant } = {}) {
  ensure();
  x = Number.isFinite(nx) ? nx : x;
  y = Number.isFinite(ny) ? ny : y;
  if (instant) root.style.transition = 'none';
  paint();
}

function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// Animate the cursor from its current spot to (tx, ty). Returns when it arrives.
function moveTo(tx, ty, { durationMs } = {}) {
  ensure();
  show();
  const fromX = x;
  const fromY = y;
  const dx = (Number.isFinite(tx) ? tx : fromX) - fromX;
  const dy = (Number.isFinite(ty) ? ty : fromY) - fromY;
  const dist = Math.hypot(dx, dy);
  const ms = durationMs != null
    ? durationMs
    : Math.max(180, Math.min(700, dist / 1.8));
  if (dist < 2 || ms < 16) {
    setPosition(fromX + dx, fromY + dy, { instant: true });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      setPosition(fromX + dx * e, fromY + dy * e, { instant: true });
      if (p < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

async function clickFlash(cx, cy) {
  ensure();
  if (Number.isFinite(cx) && Number.isFinite(cy)) setPosition(cx, cy, { instant: true });
  show();
  clickRing.style.left = Math.round(x) + 'px';
  clickRing.style.top = Math.round(y) + 'px';
  clickRing.style.transition = 'none';
  clickRing.style.opacity = '1';
  clickRing.style.transform = 'scale(.45)';
  // Force reflow so the next transition plays.
  void clickRing.offsetWidth;
  clickRing.style.transition = 'opacity .28s ease, transform .28s ease';
  clickRing.style.opacity = '0';
  clickRing.style.transform = 'scale(1.6)';
  await wait(220);
}

// Live follower used while the user is recording, so the exported film (which
// is a replay) and the live session both show a pointer.
function followPointer(enabled) {
  ensure();
  if (moveTimer) {
    document.removeEventListener('mousemove', moveTimer, true);
    moveTimer = null;
  }
  if (!enabled) {
    hide();
    return;
  }
  show();
  moveTimer = (e) => {
    if (e && e.clientX != null) setPosition(e.clientX, e.clientY, { instant: true });
  };
  document.addEventListener('mousemove', moveTimer, true);
}

function getPosition() {
  return { x, y };
}

module.exports = {
  show,
  hide,
  setPosition,
  moveTo,
  clickFlash,
  followPointer,
  getPosition,
};
