/* ----------------------------- 交互（3D 环绕 + 点选） -----------------------------
   单指拖动 = 旋转视角 ｜ 双指捏合 = 缩放 ｜ 轻点地面 = 放置/清除 ｜ 轻点果蝇 = 追踪观察 */
const tipEl = document.getElementById('tip');
const MODE_CN = { cruise: '巡航', seek: '追踪气味', feed: '取食', cast: 'zig-zag 搜索', alarm: '惊逃/逃逸', trapped: '被粘住', dead: '死亡' };

let pointers = new Map();
let dragging = false, downP = null, pinch0 = 0, r0 = 0;
const lastMove = { x: 0, y: 0 };

cv.addEventListener('pointerdown', e => {
  try { cv.setPointerCapture(e.pointerId); } catch (_) { }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  lastMove.x = e.clientX; lastMove.y = e.clientY;
  if (pointers.size === 1) {
    dragging = false;
    downP = { x: e.clientX, y: e.clientY, t: performance.now() };
  } else if (pointers.size === 2) {
    const p = [...pointers.values()];
    pinch0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    r0 = cam.r;
  }
  hideHint();
}, { passive: true });

cv.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && pinch0 > 0) {
    const p = [...pointers.values()];
    const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    cam.r = clamp(r0 * pinch0 / Math.max(d, 1), CAM_MIN, CAM_MAX);
    W.userZoom = true; dragging = true;
  } else if (pointers.size === 1 && downP) {
    const dx = e.clientX - lastMove.x, dy = e.clientY - lastMove.y;
    if (!dragging && Math.hypot(e.clientX - downP.x, e.clientY - downP.y) > 7) dragging = true;
    if (dragging) {
      cam.theta += dx * 0.007;         // 拖动方向 = 画面移动方向（"抓住世界"的手感）
      cam.phi = clamp(cam.phi - dy * 0.007, 0.14, 1.45);
    }
  } else if (!pointers.size) {
    /* 悬停（桌面/Apple Pencil）：显示果蝇状态 */
    const f = pickFly(e.clientX, e.clientY);
    if (f) { W.inspect = f; showTipAt(f, e.clientX, e.clientY); }
    else if (!W.follow) hideTip();
  }
  lastMove.x = e.clientX; lastMove.y = e.clientY;
}, { passive: true });

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch0 = 0;
  if (pointers.size === 0 && downP) {
    const dt = performance.now() - downP.t;
    if (!dragging && dt < 420) tapAt(e.clientX, e.clientY);
    downP = null; dragging = false;
  }
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('wheel', e => {
  e.preventDefault();
  cam.r = clamp(cam.r * (1 + e.deltaY * 0.0012), CAM_MIN, CAM_MAX);
  W.userZoom = true;
}, { passive: false });

function tapAt(cx, cy) {
  const f = pickFly(cx, cy);
  if (f) {
    if (W.mode === 'erase') { f.onTrap = null; f.die('removed'); sparks(f.x, f.y, [255, 140, 160], 6); return; }
    W.inspect = f; W.follow = f; W.userZoom = true;
    showTipAt(f, cx, cy);
    hint(`追踪果蝇 #${f.id}（轻点空地取消追踪）`);
    return;
  }
  const s = screenToSim(cx, cy);
  if (!s) return;
  if (W.mode === 'erase') { if (place(s.x, s.y)) sparks(s.x, s.y, [200, 220, 255], 5); return; }
  if (W.follow) { W.follow = null; W.userZoom = false; }
  if (place(s.x, s.y)) {
    if (W.mode === 'food') sparks(s.x, s.y, [255, 200, 120], 8);
    else if (W.mode === 'fly') sparks(s.x, s.y, [150, 200, 255], 8);
  } else {
    hint(W.mode === 'food' ? '这里已经放过食物了' : W.mode === 'trap' ? '离已有粘板太近' : W.mode === 'fly' ? '果蝇数量已达上限' : '');
  }
}

/* ----------------------------- 果蝇状态浮窗 ----------------------------- */
function showTipAt(f, cx, cy) {
  const hunger = clamp(1 - f.energy / CFG.fly.hungryAt, 0, 1);
  const top = f.brain.topTypes(4).filter(t => t[1] > 0.5);
  const notes = [];
  if (f.energy < CFG.fly.desperateAt) notes.push('极饿：Hugin 抑制 MBON_av，冒险觅食');
  else if (hunger > 0.4) notes.push('Hugin(SEZ) 饥饿驱动↑');
  if (f.fermSat > 0.3) notes.push('AL 闻到发酵气味');
  if (f.odSat > 0.3) notes.push('AL 闻到食物气味');
  if ((f.peakAversion || 0) > 0.35) notes.push('MB 记忆已写入：回避粘板');
  if (f.alSat > 0.3) notes.push('报警信息素 → 回避＋逃逸');
  if (f.brain.rate('DAN_PPL1') > 1) notes.push('PPL1 多巴胺：惩罚信号发放中');
  tipEl.innerHTML =
    `<b>果蝇 #${f.id}</b> · ${MODE_CN[f.state] || f.state}<br>` +
    `能量 ${f.energy.toFixed(0)}/${CFG.fly.eMax} · 饥饿 ${(hunger * 100).toFixed(0)}% · 年龄 ${f.age.toFixed(1)}s<br>` +
    `脑 ${f.brain.popRateSlow.toFixed(2)}Hz ｜ MBON_av 权重 ×${f.brain.learnIndex().toFixed(2)}<br>` +
    `读出 MN9 ${f.brain.rate('MN_feed').toFixed(1)} · MN_walk ${f.brain.rate('MN_walk').toFixed(1)} · GF ${f.brain.rate('DN_escape').toFixed(1)} Hz<br>` +
    (top.length ? `<span style="color:#9fe8c8">活跃：${top.map(t => t[0] + ' ' + t[1].toFixed(0) + 'Hz').join('、')}</span><br>` : '') +
    (notes.length ? `<span style="color:#ffd479">${notes.join('；')}</span>` : '');
  tipEl.style.display = 'block';
  tipEl.style.left = clamp(cx + 14, 6, window.innerWidth - 230) + 'px';
  tipEl.style.top = clamp(cy + 14, 46, window.innerHeight - 130) + 'px';
}
function hideTip() { tipEl.style.display = 'none'; }

let hintTimer = null;
function hint(t) {
  if (!t) return;
  const el = document.getElementById('hint');
  el.textContent = t; el.style.opacity = 0.92;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.style.opacity = 0; }, 4200);
}
function hideHint() { document.getElementById('hint').style.opacity = 0; }
setTimeout(() => hideHint(), 12000);

/* ----------------------------- 视角快捷操作 ----------------------------- */
function toggleFollow() {
  if (W.follow) { W.follow = null; W.userZoom = false; hint('自由环绕视角'); }
  else {
    const f = W.inspect || inspectedFly();
    if (f) { W.follow = f; W.userZoom = true; W.inspect = f; hint(`追踪果蝇 #${f.id}`); }
  }
}
function toggleTopView() {
  W.follow = null; W.userZoom = false;
  cam.theta = -0.5; cam.phi = 0.16;
  hint('俯视视角');
}

/* ----------------------------- 快照（分享用） ----------------------------- */
(function () {
  const btn = document.getElementById('btnSnap');
  const ov = document.getElementById('snapview');
  if (!btn || !ov) return;
  btn.addEventListener('click', () => {
    if (!glOK || !renderer) return;
    render(0.016);
    try {
      const url = renderer.domElement.toDataURL('image/png');
      ov.querySelector('img').src = url;
      ov.style.display = 'flex';
      W.paused = true;
      document.getElementById('btnPause').textContent = '▶ 继续';
      const po = document.getElementById('paused'); if (po) po.style.display = 'none';
    } catch (e) {
      /* 个别浏览器禁止 canvas 导出：退化为直接截当前帧 */
      hint('此浏览器不支持导出图片，请直接截屏');
    }
  });
  ov.addEventListener('click', () => { ov.style.display = 'none'; });
})();
