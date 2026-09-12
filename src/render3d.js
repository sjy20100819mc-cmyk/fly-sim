/* ============================================================================
   3D 渲染层（three.js · WebGL）
   ── 世界坐标 = 仿真像素：培养箱 ARENA×ARENA，与 2D 版标定过的生态密度一致
   ── 每只果蝇由实例化网格拼成（腹部/胸部/头/复眼/双翅/六足 + 接触阴影）
   ── 三种气味以叠加混合的半透明"云层"贴图悬浮在箱内
   ========================================================================== */
const ARENA = 600;                       // 培养箱边长（仿真单位 = 像素）
W.w = ARENA; W.h = ARENA;                // 物理世界固定为方形箱体
const cv = document.getElementById('cv');
let renderer = null, scene = null, camera = null, DPR = 1;
let glOK = true;
const R = {};                            // 3D 资源

/* ------------------------- 通用小工具 ------------------------- */
const _vA = new THREE.Vector3(), _vB = new THREE.Vector3(), _vC = new THREE.Vector3();
const _qA = new THREE.Quaternion(), _eA = new THREE.Euler(), _mA = new THREE.Matrix4(), _mB = new THREE.Matrix4();
function px2world(x, y) { return [x - ARENA / 2, y - ARENA / 2]; }

function radialTex(size, inner, outer, softness) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  rg.addColorStop(0, inner); rg.addColorStop(softness === undefined ? 0.55 : softness, outer);
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; t.encoding = THREE.sRGBEncoding; return t;
}
function wingTex() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, 'rgba(225,242,255,0.85)'); grad.addColorStop(1, 'rgba(190,220,245,0.35)');
  g.fillStyle = grad;
  g.beginPath(); g.ellipse(30, 16, 30, 12, 0, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; t.encoding = THREE.sRGBEncoding; return t;
}
function floorTex() {
  const s = 512, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(s / 2, s / 2, 20, s / 2, s / 2, s * 0.72);
  rg.addColorStop(0, '#7d95a6'); rg.addColorStop(0.65, '#46596a'); rg.addColorStop(1, '#242f39');
  g.fillStyle = rg; g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(190,230,255,0.30)'; g.lineWidth = 1;
  for (let i = 0; i <= 16; i++) {
    const p = i * s / 16;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(s, p); g.stroke();
  }
  g.strokeStyle = 'rgba(160,220,255,0.45)'; g.lineWidth = 3;
  g.strokeRect(1, 1, s - 2, s - 2);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; t.encoding = THREE.sRGBEncoding; return t;
}
function trapTex() {
  const w = 128, h = 84, c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(226,180,54,0.55)'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,235,160,0.5)'; g.lineWidth = 6;
  for (let i = -h; i < w; i += 16) { g.beginPath(); g.moveTo(i, h); g.lineTo(i + h, 0); g.stroke(); }
  g.fillStyle = 'rgba(255,248,210,0.35)';
  for (let i = 0; i < 24; i++) g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; t.encoding = THREE.sRGBEncoding; return t;
}

/* ----------------------------- 初始化 ----------------------------- */
function initGL() {
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: cv, antialias: true, alpha: false, powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
      /* QQ/微信内置浏览器 & 部分安卓 WebView 在切后台后会清空画布缓冲，
         开启 preserveDrawingBuffer 可避免"回到前台一片黑" */
      preserveDrawingBuffer: true
    });
  } catch (e) {
    glOK = false;
  }
  if (!glOK || !renderer || !renderer.getContext()) { glFail(); return false; }
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if ('outputEncoding' in renderer && THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1219);
  scene.fog = new THREE.Fog(0x0a1219, 2000, 6000);   // 范围在 updateCamera 中随相机距离自适应

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 2, 8000);

  /* 灯光：半球环境光 + 主方向光（暖） + 补光（冷） */
  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x24303c, 1.00));
  const key = new THREE.DirectionalLight(0xfff0d5, 1.35);
  key.position.set(260, 520, 180); scene.add(key);
  const fill = new THREE.DirectionalLight(0x9cc8ff, 0.55);
  fill.position.set(-320, 260, -240); scene.add(fill);

  /* 箱底 */
  const floorMat = new THREE.MeshLambertMaterial({ map: floorTex() });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA, ARENA), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  R.floor = floor;

  /* 箱壁（半透明玻璃） */
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x9ed0ff, transparent: true, opacity: 0.20, side: THREE.DoubleSide, depthWrite: false });
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0xa8e2ff, transparent: true, opacity: 0.8 });
  const H = 46, T = 3;
  const walls = [[0, -ARENA / 2, ARENA, T], [0, ARENA / 2, ARENA, T], [-ARENA / 2, 0, T, ARENA], [ARENA / 2, 0, T, ARENA]];
  for (const [x, z, w, d] of walls) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, H, d), wallMat);
    m.position.set(x, H / 2, z); scene.add(m);
    const e = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, d), edgeMat);
    e.position.set(x, H, z); scene.add(e);
  }

  /* 气味云层（三种，叠在不同高度） */
  R.fields = [];
  const fdefs = [[11.0, 0.22], [19.0, 0.20], [27.0, 0.18]];
  for (let i = 0; i < 3; i++) {
    const tex = new THREE.DataTexture(new Uint8Array(W.cols * W.rows * 4), W.cols, W.rows, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: fdefs[i][1], blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(ARENA, ARENA), mat);
    m.rotation.x = -Math.PI / 2; m.position.y = fdefs[i][0];
    scene.add(m); R.fields.push({ mesh: m, tex: tex });
  }

  /* 火花粒子 */
  const MAXP = 240;
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3));
  pgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3));
  R.points = new THREE.Points(pgeo, new THREE.PointsMaterial({
    size: 9, map: radialTex(32, 'rgba(255,255,255,1)', 'rgba(255,255,255,0.4)', 0.4),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, sizeAttenuation: true
  }));
  R.points.frustumCulled = false;
  scene.add(R.points);

  buildFlyMeshes();
  buildFoodMeshes();
  buildTrapMeshes();
  buildEggMeshes();
  buildPulsePool();
  resizeGL();
  window.addEventListener('resize', resizeGL);
  window.addEventListener('orientationchange', () => setTimeout(resizeGL, 260));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { last = 0; render(0.016); }     // 回到前台立即补一帧
  });
  camReset();
  return true;
}
function glFail() {
  const d = document.getElementById('glfail');
  if (d) d.style.display = 'flex';
}

/* --------------------- 果蝇：实例化各部件 --------------------- */
const MAXFLY = 260;
function buildFlyMeshes() {
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x161c24 });
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xa8283c });
  const wingMat = new THREE.MeshLambertMaterial({
    map: wingTex(), transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, emissive: 0x2c3f52
  });
  const legMat = new THREE.MeshLambertMaterial({ color: 0x2a3038 });
  const mk = (geo, mat, n) => { const m = new THREE.InstancedMesh(geo, mat, n); m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); return m; };

  R.abd = mk(new THREE.SphereGeometry(1, 10, 8), bodyMat, MAXFLY);
  R.thx = mk(new THREE.SphereGeometry(1, 10, 8), bodyMat, MAXFLY);
  R.head = mk(new THREE.SphereGeometry(1, 9, 7), bodyMat, MAXFLY);
  R.eye = mk(new THREE.SphereGeometry(1, 7, 6), eyeMat, MAXFLY * 2);
  const wingGeo = new THREE.PlaneGeometry(1, 1);
  wingGeo.rotateX(-Math.PI / 2);              // 平躺
  wingGeo.translate(-0.5, 0, 0);              // 原点移到翅根
  R.wing = mk(wingGeo, wingMat, MAXFLY * 2);
  const legGeo = new THREE.BoxGeometry(0.32, 0.32, 1);
  legGeo.translate(0, 0, 0.5);
  R.leg = mk(legGeo, legMat, MAXFLY * 6);
  /* 接触阴影 */
  const shMat = new THREE.MeshBasicMaterial({ map: radialTex(64, 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0.22)', 0.6), transparent: true, opacity: 0.7, depthWrite: false });
  const shGeo = new THREE.PlaneGeometry(1, 1); shGeo.rotateX(-Math.PI / 2);
  R.shadow = mk(shGeo, shMat, MAXFLY);

  /* 尸体 / 粘板上的残骸 */
  const dMat = new THREE.MeshLambertMaterial({ color: 0x6b5642, emissive: 0x1a120c });
  R.dead = mk(new THREE.SphereGeometry(1, 7, 5), dMat, 320);
  for (const k in R) if (R[k] && R[k].isInstancedMesh) R[k].count = 0;
}

/* --------------------- 食物 / 粘板 / 卵 / 脉冲 --------------------- */
function buildFoodMeshes() {
  const MAXF = 40, MAXB = 400;
  R.foodBlob = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 9, 7),
    new THREE.MeshLambertMaterial({ color: 0xffd79a, emissive: 0xd07a20 }), MAXB);
  R.foodBlob.frustumCulled = false; R.foodBlob.count = 0; scene.add(R.foodBlob);
  R.foodGlow = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: radialTex(64, 'rgba(255,190,110,0.85)', 'rgba(255,150,60,0.35)', 0.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    MAXF);
  R.foodGlow.frustumCulled = false; R.foodGlow.count = 0; scene.add(R.foodGlow);
  R.foodSeeds = [];
  for (let i = 0; i < MAXB / 6; i++) R.foodSeeds.push([rand(-0.7, 0.7), rand(-0.7, 0.7), rand(0.5, 1.3), rand(3, 5)]);
}
function buildTrapMeshes() {
  const MAXT = 40;
  const mat = new THREE.MeshLambertMaterial({ color: 0xffdc66, map: trapTex(), emissive: 0x8a6208, transparent: true, opacity: 0.95 });
  R.trap = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, MAXT);
  R.trap.frustumCulled = false; R.trap.count = 0; scene.add(R.trap);
  R.trapEdge = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffe89a, transparent: true, opacity: 0.85 }), MAXT);
  R.trapEdge.frustumCulled = false; R.trapEdge.count = 0; scene.add(R.trapEdge);
}
function buildEggMeshes() {
  R.egg = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 7, 5),
    new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xb0a888 }), 160);
  R.egg.frustumCulled = false; R.egg.count = 0; scene.add(R.egg);
}
function buildPulsePool() {
  R.pulses = [];
  const geo = new THREE.RingGeometry(0.82, 1, 32).rotateX(-Math.PI / 2);
  for (let i = 0; i < 26; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff5a78, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.visible = false; scene.add(m); R.pulses.push(m);
  }
}

/* ----------------------------- 相机 ----------------------------- */
const cam = { r: 900, theta: -0.5, phi: 0.92, target: new THREE.Vector3(0, 0, 0), tTarget: new THREE.Vector3(0, 0, 0) };
const CAM_MIN = 60, CAM_MAX = 3600;
function camReset() {
  cam.theta = -0.5; cam.phi = 0.80; cam.r = fitRadius();
  cam.target.set(0, 0, 0); cam.tTarget.set(0, 0, 0);
  if (W.follow) { W.follow = null; }
}
function fitRadius() {
  const vFov = camera.fov * Math.PI / 180;
  const aspect = camera.aspect;
  const halfW = ARENA / 2 * 1.18;
  const need = halfW / Math.tan(aspect >= 1 ? vFov / 2 : Math.atan(Math.tan(vFov / 2) * aspect));
  return clamp(need / Math.sin(cam.phi) * 1.02, CAM_MIN, CAM_MAX);
}
function resizeGL() {
  if (!renderer) return;
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (!W.userZoom) cam.r = fitRadius();
}
function updateCamera(dt) {
  if (W.follow && W.follow.dead) W.follow = null;
  if (W.follow) {
    const [wx, wz] = px2world(W.follow.x, W.follow.y);
    cam.tTarget.set(wx, 3, wz);
    cam.r += (170 - cam.r) * clamp(dt * 2.2, 0, 1);
    cam.phi += (1.05 - cam.phi) * clamp(dt * 2.2, 0, 1);
  } else {
    cam.tTarget.set(0, 0, 0);
    if (W.userZoom) cam.r += 0; else cam.r += (fitRadius() - cam.r) * clamp(dt * 1.5, 0, 1);
  }
  cam.target.lerp(cam.tTarget, clamp(dt * 3.2, 0, 1));
  if (scene.fog) { scene.fog.near = cam.r * 1.18; scene.fog.far = cam.r * 3.0; }
  const sp = cam.phi;
  camera.position.set(
    cam.target.x + cam.r * Math.sin(sp) * Math.cos(cam.theta),
    cam.target.y + cam.r * Math.cos(sp),
    cam.target.z + cam.r * Math.sin(sp) * Math.sin(cam.theta)
  );
  camera.lookAt(cam.target);
}

/* ----------------------------- 每帧更新实例 ----------------------------- */
const dummy = new THREE.Object3D();
const flyCol = new THREE.Color(), eyeCol = new THREE.Color(0xd84058);
function updateFlyInstances() {
  const R_ = R;
  let n = 0, nw = 0, nl = 0, ne = 0;
  const S = CFG.fly.size * 3.0;                        // 视觉尺度（按真实比例：体长≈箱体 4%，不影响物理）
  for (const f of W.flies) {
    if (f.dead) continue;
    if (n >= MAXFLY) break;
    const [wx, wz] = px2world(f.x, f.y);
    const trapped = f.state === 'trapped';
    const hunger = clamp(1 - f.energy / CFG.fly.hungryAt, 0, 1);
    const bob = trapped ? 0 : Math.sin(f.wingPhase * 0.35) * 0.35;
    const alt = (trapped ? 1.3 : 2.4) * S + bob;
    const yaw = -f.dir;

    dummy.position.set(wx, alt, wz);
    dummy.rotation.set(trapped ? Math.sin(f.jitter * 3) * 0.25 : Math.sin(f.wingPhase * 0.6) * 0.04, yaw, trapped ? Math.sin(f.jitter * 4) * 0.2 : 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    const M = dummy.matrix.clone();

    /* 体色：饥饿偏红棕，被粘住偏琥珀 */
    if (trapped) flyCol.setRGB(0.55, 0.34, 0.12);
    else flyCol.setRGB(0.15 + 0.16 * hunger, 0.13 + 0.09 * hunger, 0.14 + 0.02 * hunger);

    const part = (mesh, idx, px, py, pz, rx, ry, rz, sx, sy, sz) => {
      _eA.set(rx, ry, rz); _qA.setFromEuler(_eA); _vA.set(px * S, py * S, pz * S);
      _vB.set(sx * S, sy * S, sz * S);
      _mB.compose(_vA, _qA, _vB);
      _mB.premultiply(M);
      mesh.setMatrixAt(idx, _mB);
    };
    /* 腹部（后） · 胸部 · 头 · 复眼 */
    part(R_.abd, n, -2.6, 0, 0, 0, 0, 0, 3.2, 2.1, 2.3);
    part(R_.thx, n, 0.2, 0.15, 0, 0, 0, 0, 2.4, 2.2, 2.4);
    part(R_.head, n, 3.2, 0.1, 0, 0, 0, 0, 1.9, 1.8, 1.9);
    part(R_.eye, ne++, 3.6, 0.55, -0.95, 0, 0, 0, 1.15, 1.15, 1.15);
    part(R_.eye, ne++, 3.6, 0.55, 0.95, 0, 0, 0, 1.15, 1.15, 1.15);
    R_.abd.setColorAt(n, flyCol); R_.thx.setColorAt(n, flyCol); R_.head.setColorAt(n, flyCol);
    R_.eye.setColorAt(ne - 2, eyeCol); R_.eye.setColorAt(ne - 1, eyeCol);
    /* 双翅：绕体轴扇动 */
    const flap = Math.sin(f.wingPhase) * 0.85;
    for (let s = 0; s < 2; s++) {
      const sign = s === 0 ? -1 : 1;
      part(R_.wing, nw++, 0.7, 1.5, sign * 1.0, 0, sign * 0.22, sign * (0.22 + flap * 0.9), 8.0, 1, 3.4);
    }
    /* 六足 */
    for (let i = 0; i < 3; i++) {
      for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? -1 : 1;
        const wig = trapped ? Math.sin(f.jitter * 9 + i) * 0.5 : 0;
        part(R_.leg, nl++, -1.6 + i * 1.9, -0.5, sign * 1.15, Math.PI / 2 + sign * 0.32, 0, (i - 1) * 0.3 + wig, 1, 1, 2.6);
      }
    }
    /* 接触阴影 */
    dummy.position.set(wx, 0.35, wz); dummy.rotation.set(0, 0, 0);
    dummy.scale.set(10 * S, 1, 7 * S); dummy.updateMatrix();
    R_.shadow.setMatrixAt(n, dummy.matrix);
    n++;
  }
  for (const k of ['abd', 'thx', 'head', 'shadow']) R[k].count = n;
  R.wing.count = nw; R.leg.count = nl; R.eye.count = ne;
  for (const k of ['abd', 'thx', 'head', 'eye', 'wing', 'leg', 'shadow']) {
    R[k].instanceMatrix.needsUpdate = true;
    if (R[k].instanceColor) R[k].instanceColor.needsUpdate = true;
  }
}
function updatePropInstances() {
  /* 食物 */
  let fb = 0;
  for (const f of W.foods) {
    const [wx, wz] = px2world(f.x, f.y);
    R.foodGlow.count = W.foods.length;
    dummy.position.set(wx, 0.5, wz); dummy.rotation.set(0, 0, 0);
    const pulse = 1 + Math.sin(W.time * 2 + f.ph) * 0.06;
    dummy.scale.set(CFG.food.r * 3.6 * pulse, 1, CFG.food.r * 3.6 * pulse);
    dummy.updateMatrix(); R.foodGlow.setMatrixAt(W.foods.indexOf(f), dummy.matrix);
    for (const s of R.foodSeeds) {
      if (fb >= 400) break;
      dummy.position.set(wx + s[0] * CFG.food.r, s[2] * 2.2, wz + s[1] * CFG.food.r);
      dummy.rotation.set(s[0], s[1], 0);
      const sc = s[3];
      dummy.scale.set(sc, sc * 0.8, sc); dummy.updateMatrix();
      R.foodBlob.setMatrixAt(fb++, dummy.matrix);
    }
  }
  R.foodBlob.count = fb;
  R.foodGlow.instanceMatrix.needsUpdate = true; R.foodBlob.instanceMatrix.needsUpdate = true;

  /* 粘板 */
  let ti = 0;
  for (const t of W.traps) {
    if (ti >= 40) break;
    const [wx, wz] = px2world(t.x + CFG.trap.w / 2, t.y + CFG.trap.h / 2);
    dummy.position.set(wx, 1.6, wz); dummy.rotation.set(0, 0, 0);
    dummy.scale.set(CFG.trap.w, 3.2, CFG.trap.h); dummy.updateMatrix();
    R.trap.setMatrixAt(ti, dummy.matrix);
    dummy.position.y = 3.3; dummy.scale.set(CFG.trap.w * 1.02, 0.6, CFG.trap.h * 1.02); dummy.updateMatrix();
    R.trapEdge.setMatrixAt(ti, dummy.matrix);
    ti++;
  }
  R.trap.count = ti; R.trapEdge.count = ti;
  R.trap.instanceMatrix.needsUpdate = true; R.trapEdge.instanceMatrix.needsUpdate = true;

  /* 卵 */
  let ei = 0;
  for (const e of W.eggs) {
    if (ei >= 160) break;
    const [wx, wz] = px2world(e.x, e.y);
    const s = 1.5 * (1 + Math.sin(W.time * 4 + e.ph) * 0.12);
    dummy.position.set(wx, 1.4, wz); dummy.rotation.set(0.5, e.ph, 0);
    dummy.scale.set(s * 1.5, s * 0.9, s); dummy.updateMatrix();
    R.egg.setMatrixAt(ei++, dummy.matrix);
  }
  R.egg.count = ei; R.egg.instanceMatrix.needsUpdate = true;

  /* 尸体 + 粘板上的残骸 */
  let di = 0;
  for (const t of W.traps) for (const b of (t.bodies || [])) {
    if (di >= 320) break;
    const [wx, wz] = px2world(b.x, b.y);
    dummy.position.set(wx, 2.6, wz); dummy.rotation.set(0.3, -b.dir, 0.4);
    dummy.scale.set(4.6, 1.6, 2.6); dummy.updateMatrix();
    R.dead.setMatrixAt(di++, dummy.matrix);
  }
  for (const c of W.corpses) {
    if (di >= 320) break;
    const [wx, wz] = px2world(c.x, c.y);
    dummy.position.set(wx, 0.8, wz); dummy.rotation.set(0, -c.dir, 0.2);
    dummy.scale.set(4.6, 1.4, 2.6); dummy.updateMatrix();
    R.dead.setMatrixAt(di++, dummy.matrix);
  }
  R.dead.count = di; R.dead.instanceMatrix.needsUpdate = true;

  /* 信息素脉冲环 */
  let pi = 0;
  for (const f of W.flies) {
    if (pi >= R.pulses.length) break;
    if (f.dead || f.pulse <= 0.02 || f.state !== 'trapped') continue;
    const [wx, wz] = px2world(f.x, f.y);
    const m = R.pulses[pi++];
    const rr = 6 + (1 - f.pulse) * CFG.pher.emitR * 2.4;
    m.visible = true; m.position.set(wx, 4.0, wz); m.scale.set(rr * 1.6, 1, rr * 1.6);
    m.material.opacity = f.pulse * 0.5;
  }
  for (let i = pi; i < R.pulses.length; i++) R.pulses[i].visible = false;

  /* 火花粒子 */
  const pos = R.points.geometry.attributes.position, col = R.points.geometry.attributes.color;
  let pi2 = 0;
  for (const p of particles) {
    if (pi2 >= 240) break;
    const [wx, wz] = px2world(p.x, p.y);
    pos.setXYZ(pi2, wx, 4 + p.t * 30, wz);
    const a = 1 - p.t / p.life;
    col.setXYZ(pi2, p.c[0] / 255 * a, p.c[1] / 255 * a, p.c[2] / 255 * a);
    pi2++;
  }
  pos.needsUpdate = true; col.needsUpdate = true;
  R.points.geometry.setDrawRange(0, pi2);
}

/* ----------------------------- 气味云 ----------------------------- */
function updateFieldTextures() {
  if (!W.showField) return;
  const fs = [fFood, fFerm, fAlarm];
  for (let i = 0; i < 3; i++) {
    const fld = fs[i], tex = R.fields[i].tex, data = tex.image.data;
    const mx = Math.max(fld.max, 0.4);
    for (let k = 0; k < fld.cur.length; k++) {
      const t = clamp(fld.cur[k] / mx, 0, 1);
      const o = k * 4;
      const a = Math.pow(t, 0.7);
      data[o] = 255 * a; data[o + 1] = 255 * a; data[o + 2] = 255 * a;
      data[o + 3] = 255 * a * 0.60;
    }
    tex.needsUpdate = true;
  }
  R.fields[0].mesh.material.color.setRGB(1.0, 0.62, 0.25);
  R.fields[1].mesh.material.color.setRGB(1.0, 0.86, 0.35);
  R.fields[2].mesh.material.color.setRGB(1.0, 0.32, 0.42);
}

/* ----------------------------- 主渲染 ----------------------------- */
function render(dt) {
  if (!glOK) return;
  updateFlyInstances();
  updatePropInstances();
  updateFieldTextures();
  /* 近距取景（追踪/放大）时淡出气味云，避免挡住视线 */
  const fade = clamp((cam.r - 300) / 420, 0, 1);
  for (let i = 0; i < 3; i++) {
    const m = R.fields[i].mesh;
    m.visible = W.showField && fade > 0.02;
    m.material.opacity = [0.22, 0.20, 0.18][i] * fade;
  }
  updateCamera(dt);
  renderer.render(scene, camera);
}

/* 供 UI 使用的通用圆角矩形（脑活动面板绘制） */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* 屏幕坐标 → 仿真坐标（射线打到箱底） */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function screenToSim(px, py) {
  const r = cv.getBoundingClientRect();
  ndc.x = ((px - r.left) / r.width) * 2 - 1;
  ndc.y = -((py - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  return { x: clamp(hit.x + ARENA / 2, 0, ARENA), y: clamp(hit.z + ARENA / 2, 0, ARENA) };
}
/* 最近的果蝇（屏幕空间距离） */
function pickFly(px, py) {
  const r = cv.getBoundingClientRect();
  let best = null, bd = 52;
  for (const f of W.flies) {
    if (f.dead) continue;
    const [wx, wz] = px2world(f.x, f.y);
    _vC.set(wx, 4, wz).project(camera);
    const sx = (_vC.x * 0.5 + 0.5) * r.width + r.left;
    const sy = (-_vC.y * 0.5 + 0.5) * r.height + r.top;
    const d = Math.hypot(sx - px, sy - py);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
