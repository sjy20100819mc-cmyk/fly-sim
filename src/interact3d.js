/* ----------------------------- 交互（3D 环绕 + 点选） -----------------------------
   单指拖动 = 旋转视角 ｜ 双指捏合 = 缩放 ｜ 轻点地面 = 放置/清除 ｜ 轻点果蝇 = 追踪观察
   注意：位移一律用"该手指自己的上一次坐标"计算，且换指/增减手指时重置基准，
   否则双指与单指切换的瞬间会用到别的手指坐标 → 视角瞬移。 */
const tipEl = document.getElementById('tip');
const MODE_CN = { cruise: '巡航', seek: '追踪气味', feed: '取食', cast: 'zig-zag 搜索', alarm: '惊逃/逃逸', trapped: '被粘住', dead: '死亡' };

let pointers = new Map();
let dragging = false, downP = null, pinch0 = 0, r0 = 0;

/* ✕ 关闭信息框 —— 同时退出追踪、回到整体视角 */
function closeTipAndUnfollow() {
  const wasFollow = !!W.follow;
  hideTip();
  if (wasFollow) { W.follow = null; W.userZoom = false; hint('已退出追踪'); }
}
(() => {                                   // 🎯 追踪 / 停止追踪
  const btn = document.getElementById('tipFollow');
  if (!btn) return;
  btn.addEventListener('pointerdown', e => { e.stopPropagation(); });
  btn.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    const f = W.tipFly;
    if (!f) return;
    if (W.follow === f) { W.follow = null; W.userZoom = false; }
    else { W.follow = f; W.userZoom = true; W.followDist = 170; W.followEnter = 1.3; }
    renderTipBody(f);
  });
})();
(() => {
  const btn = document.getElementById('tipClose');
  if (!btn) return;
  btn.addEventListener('pointerdown', e => { e.stopPropagation(); });
  btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); closeTipAndUnfollow(); });
})();

function pinchDist() {
  const p = [...pointers.values()];
  return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
}
function applyZoom(nr) {
  if (W.follow) W.followDist = clamp(nr, 55, 600);   // 跟随时改"跟随距离"，不被跟随逻辑拉回
  else cam.r = nr;
}

cv.addEventListener('pointerdown', e => {
  try { cv.setPointerCapture(e.pointerId); } catch (_) { }
  if (pointers.size >= 2) pointers.clear();          // 万一漏了 pointerup，避免残留指针
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY });
  if (pointers.size === 1) {
    dragging = false;
    downP = { x: e.clientX, y: e.clientY, t: performance.now() };
  } else if (pointers.size === 2) {
    pinch0 = pinchDist();
    r0 = W.follow ? W.followDist : cam.r;
    W.userZoom = true;                               // 一捏合就停掉自动取景，免得和自动缩放互相拉扯
    dragging = true; downP = null;                   // 双指操作不算轻点
  }
  hideHint();
}, { passive: true });

cv.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (!p) return;                                    // 未知指针直接忽略
  if (pointers.size >= 2) {
    /* 双指捏合缩放 */
    p.x = e.clientX; p.y = e.clientY;
    const d = pinchDist();
    if (pinch0 > 1 && d > 1) applyZoom(clamp(r0 * pinch0 / d, CAM_MIN, CAM_MAX));
  } else if (pointers.size === 1 && downP) {
    /* 单指环绕：位移来自这根手指自己的轨迹 */
    const dx = e.clientX - p.lx, dy = e.clientY - p.ly;
    if (!dragging && Math.hypot(e.clientX - downP.x, e.clientY - downP.y) > 7) dragging = true;
    if (dragging) {
      cam.theta += dx * 0.007;                       // 拖动方向 = 画面移动方向（"抓住世界"的手感）
      cam.phi = clamp(cam.phi - dy * 0.007, 0.14, 1.45);
    }
    p.x = e.clientX; p.y = e.clientY;
  } else if (pointers.size === 0) {
    /* 悬停（桌面/Apple Pencil）：显示果蝇状态 */
    const f = pickFly(e.clientX, e.clientY, 1.4);
    if (f) { W.inspect = f; if (!W.tipSticky) showTipAt(f, e.clientX, e.clientY, false); }
    else if (!W.tipSticky) hideTip();
  }
  p.lx = e.clientX; p.ly = e.clientY;                // 记录"这根手指"的位置
}, { passive: true });

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch0 = 0;
  if (pointers.size === 1) {
    /* 双指变单指：剩下这根当作刚按下继续拖动，基准重置 → 不会瞬移 */
    const rest = [...pointers.values()][0];
    rest.lx = rest.x; rest.ly = rest.y;
    dragging = true; downP = null;
  }
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
  const f = 1 + e.deltaY * 0.0012;
  applyZoom(clamp((W.follow ? W.followDist : cam.r) * f, CAM_MIN, CAM_MAX));
  W.userZoom = true;
}, { passive: false });

function tapAt(cx, cy) {
  /* 放置模式下要求点得更准（0.85×），否则跟随果蝇时容易点不到空地 */
  const placing = (W.mode === 'food' || W.mode === 'trap' || W.mode === 'fly');
  const f = pickFly(cx, cy, placing ? 0.85 : 1.5);
  if (f) {
    if (W.mode === 'erase') { f.onTrap = null; f.die('removed'); sparks(f.x, f.y, [255, 140, 160], 6); return; }
    W.inspect = f;                                   // 只弹信息框；追踪改成手动点面板按钮，避免误触带走镜头
    showTipAt(f, cx, cy, true);
    return;
  }
  const s = screenToSim(cx, cy);
  if (!s) return;
  if (W.mode === 'erase') { if (place(s.x, s.y)) sparks(s.x, s.y, [200, 220, 255], 5); return; }
  hideTip();
  if (W.follow) { W.follow = null; W.userZoom = false; }   // 退出追踪并回到整体视角
  if (place(s.x, s.y)) {
    if (W.mode === 'food') sparks(s.x, s.y, [255, 200, 120], 8);
    else if (W.mode === 'fly') sparks(s.x, s.y, [150, 200, 255], 8);
  } else {
    hint(W.mode === 'food' ? '这里已经放过食物了' : W.mode === 'trap' ? '离已有粘板太近' : W.mode === 'fly' ? '果蝇数量已达上限' : '');
  }
}

/* ----------------------------- 果蝇状态浮窗 -----------------------------
   点一下果蝇 → 信息框"钉住"并实时刷新；可点 ✕ 或点空地关闭（不再是关不掉的框） */
const tipBody = document.getElementById('tipBody');
function showTipAt(f, cx, cy, sticky) {
  if (!tipEl || !tipBody) return;
  if (sticky) W.tipSticky = true;
  W.tipFly = f;
  tipEl.style.left = clamp(cx + 14, 6, window.innerWidth - 236) + 'px';
  tipEl.style.top = clamp(cy + 14, 46, window.innerHeight - 152) + 'px';
  renderTipBody(f);
  tipEl.style.display = 'block';
  syncFollowBtn();
}
function syncFollowBtn() {
  const btn = document.getElementById('tipFollow');
  if (!btn) return;
  const on = !!(W.tipFly && W.follow === W.tipFly);
  btn.textContent = on ? '⏹ 停止追踪' : '🎯 追踪这只';
  btn.classList.toggle('on', on);
}
function renderTipBody(f) {
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
  tipBody.innerHTML =
    `<b>果蝇 #${f.id}</b> · ${MODE_CN[f.state] || f.state}` +
    (W.follow === f ? ' <span style="color:#6fd8a8">· 追踪中</span>' : '') + '<br>' +
    `能量 ${f.energy.toFixed(0)}/${CFG.fly.eMax} · 饥饿 ${(hunger * 100).toFixed(0)}% · 年龄 ${f.age.toFixed(1)}s<br>` +
    `脑 ${f.brain.popRateSlow.toFixed(2)}Hz ｜ MBON_av 权重 ×${f.brain.learnIndex().toFixed(2)}<br>` +
    `读出 MN9 ${f.brain.rate('MN_feed').toFixed(1)} · MN_walk ${f.brain.rate('MN_walk').toFixed(1)} · GF ${f.brain.rate('DN_escape').toFixed(1)} Hz<br>` +
    (top.length ? `<span style="color:#9fe8c8">活跃：${top.map(t => t[0] + ' ' + t[1].toFixed(0) + 'Hz').join('、')}</span><br>` : '') +
    (notes.length ? `<span style="color:#ffd479">${notes.join('；')}</span>` : '');
  syncFollowBtn();
}
function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
  W.tipSticky = false; W.tipFly = null;
}
let _tipT = 0;
function updateTip() {                       // 每帧调用：内容实时刷新，果蝇死亡自动关闭
  if (!tipEl || !W.tipFly || tipEl.style.display === 'none') return;
  if (W.tipFly.dead || W.flies.indexOf(W.tipFly) < 0) { hideTip(); return; }
  const now = performance.now();
  if (now - _tipT < 300) return;
  _tipT = now;
  renderTipBody(W.tipFly);
}

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
    if (f) { W.follow = f; W.userZoom = true; W.inspect = f; W.followDist = 170; W.followEnter = 1.3; hint(`追踪果蝇 #${f.id}`); }
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
