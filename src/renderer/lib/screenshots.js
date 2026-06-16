// Composite annotation overlays onto a captured screenshot. Draws a colored
// box + numbered badge + truncated note for each annotation that has a target
// box, scaled from CSS viewport coordinates to the captured image's pixels.

const ACTION_COLORS = {
  remove: '#ff6b6b', change: '#ffb454', fix: '#5b8cff',
  add: '#3ddc97', question: '#c792ea', comment: '#9aa2b1',
};

export function compositeAnnotations(dataUrl, annotations, { cssWidth }) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const scale = cssWidth ? img.naturalWidth / cssWidth : 1;
      ctx.font = `${Math.round(13 * scale)}px -apple-system, sans-serif`;
      ctx.textBaseline = 'top';

      annotations.forEach((a, i) => {
        // Accept an explicit page-coordinate box (full-page) or the stored
        // viewport box on the annotation target (viewport screenshot).
        const box = a.box || (a.target && a.target.box);
        if (!box) return;
        const color = ACTION_COLORS[a.action] || '#9aa2b1';
        const x = box.x * scale, y = box.y * scale, w = box.w * scale, h = box.h * scale;

        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, 2 * scale);
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = hexA(color, 0.12);
        ctx.fillRect(x, y, w, h);

        // numbered badge
        const r = 11 * scale;
        ctx.beginPath();
        ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = '#0e0f13';
        ctx.textAlign = 'center';
        ctx.fillText(String(i + 1), x + r, y + r - 7 * scale);
        ctx.textAlign = 'left';

        // note label
        const label = `${a.action}: ${a.note}`.slice(0, 48);
        const ty = y + h + 3 * scale;
        const tw = ctx.measureText(label).width + 10 * scale;
        ctx.fillStyle = 'rgba(14,15,19,0.85)';
        ctx.fillRect(x, ty, tw, 18 * scale);
        ctx.fillStyle = color;
        ctx.fillText(label, x + 5 * scale, ty + 2 * scale);
      });

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function hexA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
