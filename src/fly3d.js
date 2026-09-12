/* ============================================================================
   果蝇自主行为模拟器 v2  ·  Drosophila Autonomous Behavior Sim
   ── 行为内核：连接组约简的脉冲神经网络（connectome-reduced spiking brain）
   ─────────────────────────────────────────────────────────────────────────
   【数据与模型出处】最新一代开源果蝇全脑工作（2024 连接组 → 2026 全脑仿真栈）
     1. FlyWire FAFB v783 (Codex) —— 成虫全脑连接组：139,255 神经元 / 2.7–3.7M 边
        Dorkenwald, Matsliah, Sterling et al., Nature 634:124-138 (2024)
        建边规则：Princeton-filtered，突触数 ≥5 才算一条边（本作沿用该规则）
     2. philshiu/Drosophila_brain_model —— 首个全脑 LIF 模型（Brian2）
        Shiu et al., "A Drosophila computational brain model reveals sensorimotor
        processing", Nature (2024)
     3. Neuromorphicism/fly-brain-snntorch —— snnTorch 稀疏实现，糖/嗅觉/视觉/听觉刺激实验
     4. snedea/flybrain —— 浏览器端 139K LIF 实时仿真（神经元按 Sensory/Central/
        Drives/Motor 分组读出）—— 本作的分组与"由放电率读出行为"即沿用此范式
     5. brandoncho369/flybench (2026) —— 全脑仿真的反射基准套件：静默→静默(基线
        <0.5 Hz)、糖→MN9 喙伸展(>5 Hz)、苦味抑制糖反应、突现→巨纤维逃逸、
        全局 gain≈0.40–0.45 才全部通过。本作的 gain / w_syn / 突触阈值即取此口径。
     6. NeLy-EPFL/flygym (NeuroMechFly v2) —— 具身感觉运动闭环（本作的导航反射层）

   【本作如何"用"这个模型】手机浏览器跑不动 13.9 万神经元 × 每只果蝇。
   所以做"连接组约简"：保留 FAFB v783 中行为关键回路的**细胞类型、递质符号与
   接线逻辑**，每只果蝇一个 70 神经元的 LIF 脉冲网（cuLIF，τm=20ms，τsyn=5ms，
   2ms 不应期，权重 w = w_syn·gain·K·(突触数/5)，w_syn=0.275，gain 可调 0.4 上下）。
   中枢脑（MB/LH/CX/SEZ）负责动机与价值，导航反射（气味梯度、casting、避障）
   由 VNC 局部回路完成 —— 与"DN 下达指令 + VNC 局部控制环"的组织方式一致。

   【回路映射】刺激 → 感觉神经元 → 中枢 → 下行神经元(DN) → 运动神经元读出 → 行为
     · 嗅觉： ORN_food/ORN_ferm → PN → LHON → DN_walk       (趋源 / 上风冲刺)
                              PN → KC → MBON_app/av          (蘑菇体价值输出)
     · 惩罚： ORN_alarm / 粘板接触 → DAN_PPL1 → MBON_av 权重↑ (PPL1→MB 厌恶性学习)
     · 奖赏： GRN_sugar → DAN_PAM → MBON_app 权重↑            (PAM→MB 食欲性学习)
     · 饥饿： Hugin(SEZ) → LHON↑ / MN_walk↑ / MBON_av 抑制    (饿则冒险觅食)
     · 饱足： FB_energy(扇形体) → 抑制 MN_feed                (饱则停止取食)
     · 警觉： 报警信息素(被粘同伴释放) → ORN_alarm → 回避 + 逃逸
     · 逃逸： 突现(looming)/机械冲击 → DN_escape(巨纤维) → 爆发逃逸
     · 中央复合体：ring_EB → PFN → 转向运动神经元 (航向与转弯)
     · 产卵： 摄食积累(蛋白) + 能量 → MN_oviposit
   ========================================================================== */
'use strict';

/* ----------------------------- 工具函数 ----------------------------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const randn = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
const TAU = Math.PI * 2;
function angDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
function rectDist(x, y, t) {                 // 点到粘板矩形的距离（0 = 贴在表面）
  const dx = Math.max(t.x - x, 0, x - (t.x + CFG.trap.w));
  const dy = Math.max(t.y - y, 0, y - (t.y + CFG.trap.h));
  return Math.hypot(dx, dy);
}
function getPath(o, p) { return p.split('.').reduce((a, k) => a[k], o); }
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }

/* ----------------------------- 全局参数 ----------------------------- */
const CFG = {
  env: {
    cell: 20, odorTau: 3.4, odorDiff: 0.20,
    fermTau: 4.2, fermDiff: 0.22,
    alarmTau: 2.8, alarmDiff: 0.11,
    senseThresh: 0.035, visionRange: 96
  },
  food: { r: 15, emit: 5.2, feedRate: 30, feedRange: 4, odorSens: 0.9 },
  trap: { w: 52, h: 34, emit: 2.3, learnR: 52, nearR: 74, avoidR: 90, avoidGain: 3.4, usR: 32, capture: 0.8, bounce: 0.35 },
  pher: { emit: 2.0, emitR: 20, interval: 0.28, emitDur: 20, escape: 0.03, drain: 2.2 },
  /* ---- 脑（LIF 网络）参数：与 flybench/Shiu2024 口径一致 ---- */
  brain: {
    dt: 0.01,          // 仿真步长(s) 10ms
    stepsPerFrame: 2,  // 每帧最多推进的脑步数
    wSyn: 0.275,       // 单突触权重基准 (mV)，flybench 默认值
    gain: 0.42,        // 全局增益：flybench 实测 0.40–0.45 才能通过全部反射
    K: 5,              // 单位换算常数：w = w_syn·gain·K·(每对突触数)，标定到 vThr=1
    adapt: 0.12,       // 放电频率适应强度（钙激活钾电流类比）
    tauAdapt: 0.10,    // 适应电流时间常数 (s)
    synMin: 5,         // 建边阈值：突触数 <5 的边丢弃（FAFB v783 惯例）
    tauM: 0.020,       // 膜时间常数 (s)
    tauSyn: 0.005,     // 突触电流衰减 (s)
    tauR: 0.20,        // 放电率估计低通 (s)：r 直接读出 Hz
    vThr: 1.0, vReset: 0.0, vRefrac: 0.002,
    noise: 0.028,      // 自发/噪声驱动（静默时脑仍有个别神经元活动）
    lr: 0.15,          // 多巴胺依赖可塑性学习率 (DAN→MB)
    extinct: 0.5,      // 消退系数：闻到气味但没有惩罚时，记忆缓慢消退
    daThresh: 3.0,     // 多巴胺门控阈值(Hz)：只有惩罚/奖赏引起的 DA 发放才写入记忆
    wMax: 3.2,         // 突触权重上限（相对基准的倍数）
    plasticTau: 0.35   // KC 资格迹时间常数(s)
  },
  fly: {
    cruise: 58, surge: 132, turnRate: 5.0, noise: 2.4, cast: 5.2, size: 1.0,
    eMax: 145, eStart: 115, drainBase: 0.95, drainMove: 0.60,
    hungryAt: 62, desperateAt: 26,
    seekGain: 1.7, fermentGain: 1.2, alarmGain: 1.15,
    forgetTau: 40, memMax: 5,
    reproChance: 0.16, reproCost: 30, reproEnergy: 102, feedNeed: 4, reproCool: 24,
    eggTime: 13, lifespan: 165, wallPad: 34, mutate: 0.10,
    /* 运动神经元 → 行为 的读出阈值 */
    walkGain: 1.0,     // MN_walk 放电率 → 速度
    feedThr: 6,        // MN_feed 放电率(Hz) 超过则伸展口器取食
    steerGain: 18,     // MN_steer 差 → 转向偏好 (rad/s per Hz)
    escapeThr: 20,     // DN_escape 放电率(Hz) 触发逃逸
    ovipThr: 8         // MN_oviposit 放电率(Hz) 触发产卵
  },
  pop: { start: 16, max: 90 },
  view: { showField: false, showBrain: false }
};

/* ----------------------------- 世界状态 ----------------------------- */
const W = {
  w: 0, h: 0, cols: 0, rows: 0,
  foods: [], traps: [], eggs: [], corpses: [], flies: [],
  time: 0, deaths: 0, births: 0, deathsByCause: {},
  paused: false, showField: false, showBrain: false, mode: 'food',
  follow: null, inspect: null, userZoom: false
};

/* ----------------------------- 气味场 ----------------------------- */
class Field {
  constructor(cols, rows, tau, diff, color) {
    this.cols = cols; this.rows = rows; this.tau = tau; this.k = diff; this.color = color;
    this.cur = new Float32Array(cols * rows);
    this.nxt = new Float32Array(cols * rows);
    this.max = 1;
    this.cv = document.createElement('canvas');
    this.cv.width = cols; this.cv.height = rows;
    this.cx = this.cv.getContext('2d');
    this.img = this.cx.createImageData(cols, rows);
  }
  deposit(x, y, amt, rad) {
    const cs = CFG.env.cell;
    const cx = Math.floor(x / cs), cy = Math.floor(y / cs);
    const r = Math.max(1, Math.round(rad / cs));
    for (let j = -r; j <= r; j++) {
      const gy = cy + j; if (gy < 0 || gy >= this.rows) continue;
      for (let i = -r; i <= r; i++) {
        const gx = cx + i; if (gx < 0 || gx >= this.cols) continue;
        const d = Math.sqrt(i * i + j * j); if (d > r) continue;
        this.cur[gy * this.cols + gx] += amt * (1 - d / (r + 1));
      }
    }
  }
  step(dt) {
    const { cols, rows, cur, nxt, k } = this;
    for (let y = 0; y < rows; y++) {
      const row = y * cols;
      for (let x = 0; x < cols; x++) {
        const i = row + x;
        const l = cur[x > 0 ? i - 1 : i], r = cur[x < cols - 1 ? i + 1 : i];
        const u = cur[y > 0 ? i - cols : i], d = cur[y < rows - 1 ? i + cols : i];
        nxt[i] = cur[i] * (1 - k) + (l + r + u + d) * 0.25 * k;
      }
    }
    const dec = Math.exp(-dt / this.tau);
    let mx = 1e-6;
    for (let i = 0; i < cur.length; i++) {
      const v = nxt[i] * dec;
      cur[i] = v < 1e-5 ? 0 : v;
      if (cur[i] > mx) mx = cur[i];
    }
    this.max = this.max * 0.9 + mx * 0.1;
  }
  at(x, y) {
    const cs = CFG.env.cell;
    const cx = clamp(Math.floor(x / cs), 0, this.cols - 1);
    const cy = clamp(Math.floor(y / cs), 0, this.rows - 1);
    return this.cur[cy * this.cols + cx];
  }
  grad(x, y) {
    const cs = CFG.env.cell, h = 1;
    return [(this.at(x + cs * h, y) - this.at(x - cs * h, y)) / (2 * cs * h),
    (this.at(x, y + cs * h) - this.at(x, y - cs * h)) / (2 * cs * h)];
  }
  render(ctx) {
    const d = this.img.data, mx = Math.max(this.max, 0.35), [r, g, b] = this.color;
    for (let i = 0; i < this.cur.length; i++) {
      const t = clamp(this.cur[i] / mx, 0, 1);
      const a = t === 0 ? 0 : Math.pow(t, 0.65) * 230;
      const o = i * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
    }
    this.cx.putImageData(this.img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.cv, 0, 0, W.w, W.h);
    ctx.restore();
  }
}
let fFood, fFerm, fAlarm;
function buildFields() {
  const cs = CFG.env.cell;
  W.cols = Math.max(1, Math.ceil(W.w / cs));
  W.rows = Math.max(1, Math.ceil(W.h / cs));
  fFood = new Field(W.cols, W.rows, CFG.env.odorTau, CFG.env.odorDiff, [255, 168, 74]);
  fFerm = new Field(W.cols, W.rows, CFG.env.fermTau, CFG.env.fermDiff, [255, 224, 96]);
  fAlarm = new Field(W.cols, W.rows, CFG.env.alarmTau, CFG.env.alarmDiff, [255, 74, 110]);
}

/* ============================================================================
   细胞类型表（取自 FAFB v783 的注释体系；group 分组沿用社区全脑仿真的读出面）
   sign: +1 兴奋（胆碱能 ACh）/ -1 抑制（GABA、谷氨酸——注意在果蝇中 Glu 多为抑制性）
   ========================================================================== */
const CTYPE = [
  /* name, group, sign, count, note */
  ['ORN_food', 'Sensory', 1, 4, '食物气味感受神经元（酵母/发酵酯类 glomeruli）'],
  ['ORN_ferm', 'Sensory', 1, 3, '发酵气味感受神经元（乙醇/乙酸类，粘板诱饵）'],
  ['ORN_alarm', 'Sensory', 1, 2, '报警信息素感受神经元（同伴被粘时释放）'],
  ['GRN_sugar', 'Sensory', 1, 2, '糖味觉感受神经元（跗节/唇瓣 GR）'],
  ['mechano', 'Sensory', 1, 3, '机械感觉（触碰/碰撞/风）'],
  ['visual', 'Sensory', 1, 2, '视觉（突现 looming / 光流）'],
  ['Hugin', 'Drives', 1, 2, 'SEZ 饥饿驱动神经元（Hugin，饥饿信号）'],
  ['NPF', 'Drives', 1, 2, 'SEZ NPF 取食促进神经元'],
  ['FB_energy', 'Drives', -1, 2, '扇形体 FB 能量稳态（饱足信号，抑制取食）'],
  ['LN_al', 'Central', -1, 3, '触角叶局部中间神经元（GABA 增益控制）'],
  ['PN', 'Central', 1, 6, '触角叶投射神经元（气味信息主通道）'],
  ['LHON', 'Central', 1, 4, '侧角输出神经元（气味吸引/趋源）'],
  ['KC', 'Central', 1, 8, '蘑菇体 Kenyon 细胞（稀疏编码，稀疏激活）'],
  ['APL', 'Central', -1, 1, '蘑菇体前侧成对侧神经元 APL（GABA 反馈：维持 KC 稀疏码）'],
  ['MBON_app', 'Central', 1, 2, 'MBON γ5β′2a（食欲性价值输出）'],
  ['MBON_av', 'Central', -1, 2, 'MBON α3（厌恶性价值输出，谷氨酸能抑制）'],
  ['DAN_PPL1', 'Central', 1, 2, 'PPL1 多巴胺能神经元（惩罚信号）'],
  ['DAN_PAM', 'Central', 1, 2, 'PAM 多巴胺能神经元（奖赏信号）'],
  ['ring_EB', 'Central', 1, 3, '椭球体 ring 神经元 R1–R4（航向/地标记忆）'],
  ['PFN', 'Central', 1, 2, '扇形体-椭球体桥神经元（转向输出）'],
  ['DN_escape', 'Central', 1, 2, '下行神经元 DNa01/DNa02（巨纤维逃逸）'],
  ['DN_walk', 'Central', 1, 2, '下行神经元 DNp09/DNg11（行进驱动）'],
  ['MN_feed', 'Motor', 1, 2, '运动神经元 MN9（喙伸展/取食）'],
  ['MN_walk', 'Motor', 1, 2, '行进运动神经元（腿/翅）'],
  ['MN_steerL', 'Motor', 1, 2, '左转运动神经元'],
  ['MN_steerR', 'Motor', 1, 2, '右转运动神经元'],
  ['MN_oviposit', 'Motor', 1, 2, '产卵运动神经元（腹部运动程序）']
];

/* 连接表 [前, 后, 突触数, 可塑性标记]
   nSyn = 两群神经元之间的突触总数；每对神经元的平均突触数 spp = nSyn/(nPre·nPost)。
   FAFB 实测中"强连接"约 5–20 个突触/对、弱连接 1–4 个，本表按该量级设定，
   <5 突触的边按惯例丢弃（synMin）。可塑性：'av' 惩罚性，'app' 食欲性。 */
const CONNECTIONS = [
  /* --- 感觉 → 触角叶 / 食管下区 / 下行神经元 --- */
  ['ORN_food', 'PN', 192], ['ORN_food', 'LN_al', 60],
  ['ORN_ferm', 'PN', 144], ['ORN_ferm', 'LN_al', 45],
  ['ORN_alarm', 'DAN_PPL1', 40],
  ['ORN_alarm', 'DN_escape', 40], ['ORN_alarm', 'MBON_av', 70],
  ['GRN_sugar', 'MN_feed', 40], ['GRN_sugar', 'NPF', 40], ['GRN_sugar', 'DAN_PAM', 24],
  ['mechano', 'DN_escape', 60], ['mechano', 'MN_walk', 18],
  ['visual', 'DN_escape', 48], ['visual', 'ring_EB', 24],
  /* --- 触角叶：局部抑制 + 投射 --- */
  ['LN_al', 'PN', 72],
  ['PN', 'LHON', 120], ['PN', 'KC', 288], ['PN', 'PFN', 36],
  ['PN', 'DAN_PAM', 24], ['PN', 'DAN_PPL1', 24],
  ['LHON', 'DN_walk', 64], ['LHON', 'MN_feed', 32], ['LHON', 'DAN_PAM', 24],
  /* --- 蘑菇体：KC 稀疏编码、APL 反馈、价值读出、多巴胺学习 --- */
  ['KC', 'APL', 80], ['APL', 'KC', 80],
  ['KC', 'MBON_app', 48, 'app'], ['KC', 'MBON_av', 48, 'av'],
  ['MBON_app', 'DN_walk', 48], ['MBON_app', 'PFN', 24],
  ['MBON_av', 'DN_walk', 48], ['MBON_av', 'MN_feed', 90], ['MBON_av', 'LHON', 64],
  ['DAN_PPL1', 'MBON_av', 40], ['DAN_PAM', 'MBON_app', 40],
  /* --- 饥饿 / 饱足（SEZ·FB）调制 --- */
  ['Hugin', 'LHON', 40], ['Hugin', 'MN_walk', 48], ['Hugin', 'MBON_av', 24],
  ['Hugin', 'NPF', 24], ['NPF', 'MN_feed', 32], ['NPF', 'DN_walk', 12], ['NPF', 'MN_oviposit', 32],
  ['FB_energy', 'MN_feed', 48], ['FB_energy', 'Hugin', 32], ['FB_energy', 'MN_oviposit', 24],
  /* --- 中央复合体（航向 / 转向） --- */
  ['ring_EB', 'PFN', 30], ['PFN', 'DN_walk', 24],
  ['PFN', 'MN_steerL', 24], ['PFN', 'MN_steerR', 24],
  /* --- 下行指令 → 运动神经元 --- */
  ['DN_escape', 'MN_walk', 40], ['DN_escape', 'MN_steerL', 24],
  ['DN_walk', 'MN_walk', 48], ['DN_walk', 'MN_steerR', 12]
];

/* ------------------- 编译网络（全局拓扑，各脑共享） ------------------- */
function compileNet() {
  const ct = {}, names = [], groups = [], sig = [];
  let idx = 0;
  for (const [name, group, sign, count] of CTYPE) {
    ct[name] = { start: idx, n: count, group, sign };
    for (let k = 0; k < count; k++) { names.push(name); groups.push(group); sig.push(sign); }
    idx += count;
  }
  const n = idx;
  const S = [], D = [], W0 = [], PL = [], SYN = [];
  const B = CFG.brain;
  let dropped = 0, totalSyn = 0, modEdges = 0;
  for (const [a, b, ns, pl] of CONNECTIONS) {
    totalSyn += ns;
    if (ns < B.synMin) { dropped++; continue; }   // ≥5 突触规则
    const A = ct[a], Bq = ct[b];
    const per = ns / (A.n * Bq.n);
    // 多巴胺是神经调质而非快速递质：DAN 的出边不产生突触电流，只门控可塑性
    const isMod = (a === 'DAN_PPL1' || a === 'DAN_PAM');
    if (isMod) modEdges++;
    const w = isMod ? 0 : B.wSyn * B.gain * B.K * (per / 5) * A.sign;
    for (let i = 0; i < A.n; i++) {
      for (let j = 0; j < Bq.n; j++) {
        S.push(A.start + i); D.push(Bq.start + j);
        W0.push(w); SYN.push(ns);
        PL.push(pl === 'av' ? 1 : pl === 'app' ? 2 : 0);
      }
    }
  }
  const E = S.length;
  // CSR：按前神经元聚合出边
  const outStart = new Int32Array(n + 1);
  for (let e = 0; e < E; e++) outStart[S[e] + 1]++;
  for (let i = 0; i < n; i++) outStart[i + 1] += outStart[i];
  const cursor = outStart.slice(0, n);
  const oDst = new Int32Array(E), oW = new Int32Array(E), oE = new Int32Array(E);
  for (let e = 0; e < E; e++) {
    const p = cursor[S[e]]++;
    oDst[p] = D[e]; oW[p] = e; oE[p] = e;
  }
  return { n, ct, names, groups, sig, S, D, W0: Float32Array.from(W0), PL: Uint8Array.from(PL),
    SYN, outStart, oDst, oW, E, totalSyn, dropped, modEdges };
}
let NET = compileNet();

/* ----------------------------- 单个果蝇脑 -----------------------------
   cuLIF（电流型泄漏积分发放）网络，参数与 flybench/Shiu2024 口径一致：
   τm=20ms, τsyn=5ms, vThr=1, vReset=0, 2ms 不应期。
   放电率估计 r[i] 以 Hz 直接读出（低通 τR=200ms）——行为即“读出运动神经元”。 */
class Brain {
  constructor(gene) {
    const n = NET.n;
    this.n = n;
    this.v = new Float32Array(n);
    this.I = new Float32Array(n);      // 突触电流
    this.ext = new Float32Array(n);    // 外部（感觉/驱动）电流
    this.r = new Float32Array(n);      // 放电率 (Hz)
    this.refr = new Float32Array(n);
    this.a = new Float32Array(n);      // 适应电流（spike-frequency adaptation）
    this.w = NET.W0.slice();           // 本脑可塑权重副本
    this.w0 = NET.W0.slice();
    this.gene = gene || {};
    this.kcBase = NET.ct.KC.start;
    this.kcN = NET.ct.KC.n;
    this.kcTrace = new Float32Array(this.kcN);
    this.daTrace = new Float32Array(NET.ct.DAN_PPL1.n);
    this.popRate = 0;
    this.popRateSlow = 0;
    this.lastSpikes = 0;
    this.raster = new Uint8Array(n);   // 供脑活动视图闪烁
  }
  rate(name) {
    const c = NET.ct[name];
    let s = 0;
    for (let i = 0; i < c.n; i++) s += this.r[c.start + i];
    return s / c.n;
  }
  step(dt) {
    const B = CFG.brain, n = this.n;
    const v = this.v, I = this.I, ext = this.ext, r = this.r, refr = this.refr, ad = this.a;
    const decI = Math.exp(-dt / B.tauSyn);
    const decR = Math.exp(-dt / B.tauR);
    const decA = Math.exp(-dt / B.tauAdapt);
    for (let i = 0; i < n; i++) { I[i] *= decI; r[i] *= decR; ad[i] *= decA; this.raster[i] = 0; }
    /* 自发噪声：低概率给单个神经元瞬时驱动（静默输入 → 稀疏自发活动） */
    if (B.noise > 0) {
      const kicks = B.noise * n * dt * 3;
      let k = Math.floor(kicks) + (Math.random() < (kicks % 1) ? 1 : 0);
      while (k-- > 0) I[(Math.random() * n) | 0] += 1.25;
    }
    /* 积分 + 发放 + 传导 */
    const dtM = dt / B.tauM, rGain = 1 / B.tauR;
    let spikeCount = 0;
    for (let i = 0; i < n; i++) {
      if (refr[i] > 0) { refr[i] -= dt; v[i] = 0; continue; }
      const vi = v[i] + dtM * (-v[i] + I[i] + ext[i] - ad[i]);
      if (vi >= B.vThr) {
        v[i] = B.vReset; refr[i] = B.vRefrac; ad[i] += B.adapt;
        spikeCount++;
        r[i] += rGain;
        this.raster[i] = 1;
        if (i >= this.kcBase && i < this.kcBase + this.kcN) this.kcTrace[i - this.kcBase] += 1;
        const s0 = NET.outStart[i], s1 = NET.outStart[i + 1];
        for (let e = s0; e < s1; e++) I[NET.oDst[e]] += this.w[NET.oW[e]];
      } else v[i] = vi;
    }
    /* 资格迹衰减 */
    const decK = Math.exp(-dt / B.plasticTau);
    for (let i = 0; i < this.kcN; i++) this.kcTrace[i] *= decK;
    /* 多巴胺依赖可塑性：PPL1 → MBON_av 权重↑（惩罚学习）/ PAM → MBON_app 权重↑（奖赏学习）*/
    const daP = this.rate('DAN_PPL1'), daR = this.rate('DAN_PAM');
    // 只有超过阈值的多巴胺才"教会"记忆（多巴胺门控），并做饱和归一化
    const dopP = clamp((daP - B.daThresh) / 25, 0, 1.5);
    const dopR = clamp((daR - B.daThresh) / 25, 0, 1.5);
    if (dopP > 0 || dopR > 0) {
      const kP = B.lr * dopP * dt, kR = B.lr * dopR * dt;
      for (let e = 0; e < NET.E; e++) {
        const pl = NET.PL[e]; if (!pl) continue;
        const tr = Math.min(1.2, this.kcTrace[NET.S[e] - this.kcBase] / 6);   // 归一化资格迹
        if (tr < 0.03) continue;
        const w0 = this.w0[e];
        if (pl === 1 && kP > 0) this.w[e] = clamp(this.w[e] + kP * tr * w0, 0, w0 * B.wMax);
        else if (pl === 2 && kR > 0) this.w[e] = clamp(this.w[e] + kR * tr * w0, 0, w0 * B.wMax);
      }
    } else {
      /* 消退（extinction）：闻到气味但这种气味不再带惩罚 → KC→MBON_av 权重缓慢回落 */
      const kE = B.lr * B.extinct * dt;
      for (let e = 0; e < NET.E; e++) {
        if (NET.PL[e] !== 1) continue;
        const tr = Math.min(1.2, this.kcTrace[NET.S[e] - this.kcBase] / 6);
        if (tr < 0.03) continue;
        const w0 = this.w0[e];
        this.w[e] = clamp(this.w[e] - kE * tr * w0, w0 * 0.35, w0 * B.wMax);
      }
    }
    /* 遗忘：可塑权重缓慢回到基线 */
    for (let e = 0; e < NET.E; e++) {
      if (!NET.PL[e]) continue;
      const w0 = this.w0[e];
      this.w[e] += (w0 - this.w[e]) * dt * 0.03;
    }
    this.lastSpikes = spikeCount;
    this.popRate = spikeCount / n / dt;
    this.popRateSlow += (this.popRate - this.popRateSlow) * Math.min(1, dt / 1.5);
  }
  /* 各行为读出（运动/下行神经元放电率 → 行为量） */
  aversion() { return clamp(this.rate('MBON_av') / 20, 0, 1); }
  attraction() { return clamp(this.rate('MBON_app') / 8, 0, 1); }
  walkDrive() { return this.rate('MN_walk') / 25; }
  feedDrive() { return this.rate('MN_feed'); }
  steerBias() { return (this.rate('MN_steerR') - this.rate('MN_steerL')) / 25; }
  escapeDrive() { return this.rate('DN_escape'); }
  ovipDrive() { return this.rate('MN_oviposit'); }
  /* 学习强度：KC→MBON_av 权重相对基线的平均倍数（1 = 未学习） */
  learnIndex() {
    let s = 0, c = 0;
    for (let e = 0; e < NET.E; e++) {
      if (NET.PL[e] !== 1) continue;
      s += this.w[e] / this.w0[e]; c++;
    }
    return c ? s / c : 1;
  }
  /* 供 UI：最活跃的若干细胞类型（其实只有 name → 索引统一，无性能问题） */
  topTypes(k) {
    const arr = [];
    for (const name in NET.ct) {
      const c = NET.ct[name];
      let s = 0;
      for (let i = 0; i < c.n; i++) s += this.r[c.start + i];
      arr.push([name, s / c.n]);
    }
    arr.sort((a, b) => b[1] - a[1]);
    return arr.slice(0, k || 5);
  }
}

/* ----------------------------- 果蝇个体 -----------------------------
   感觉编码 → 脉冲脑 → 运动读出 → 行为。
   中枢脑决定“要不要/去哪里/风险”，导航反射（气味梯度、zig-zag 搜索、避障）
   由 VNC 局部回路补全 —— 对应“DN 下达指令 + VNC 局部控制环”。 */
let flyId = 1;
const GROUPS = ['Sensory', 'Drives', 'Central', 'Motor'];

class Fly {
  constructor(x, y, gene) {
    this.id = flyId++;
    this.x = x; this.y = y;
    this.dir = rand(0, TAU);
    this.gene = gene || {
      speed: rand(0.85, 1.15), sense: rand(0.85, 1.15), brainGain: rand(0.85, 1.15),
      learn: rand(0.8, 1.2), size: rand(0.9, 1.1), noise: rand(0.8, 1.2)
    };
    this.brain = new Brain(this.gene);
    const g = this.gene.brainGain;
    for (let e = 0; e < NET.E; e++) this.brain.w[e] *= g;    // 个体兴奋性差异（≈全局 gain 变异）
    this.energy = CFG.fly.eStart * rand(0.85, 1.0);
    this.age = 0; this.eating = false; this.feedAcc = 0;
    this.state = 'cruise';
    this.speed = CFG.fly.cruise;
    this.wingPhase = rand(0, TAU);
    this.castSeed = rand(0, TAU);
    this.mem = [];
    this.cool = 0; this.pherT = rand(0, 0.3); this.pulse = 0;
    this.stuckT = 0; this.trap = null; this.onTrap = null;
    this.jitter = rand(0, TAU);
    this.brainAcc = 0;
    this.odSat = 0; this.fermSat = 0; this.alSat = 0;
    this.trapNear = 0; this.trapDist = 1e9; this.peakAversion = 0; this.usContact = 0;
    this.escapeT = 0;
    this.dead = false; this.deadT = 0; this.cause = '';
    this.pheromone = 0;                 // 本个体释放的信息素强度（视觉用）
  }

  /* ---- 感觉编码：把环境量写成各感觉神经元的外部驱动电流 ---- */
  encode(dt) {
    const b = this.brain, ext = b.ext;
    ext.fill(0);
    const E = CFG.env, F = CFG.fly;
    const hunger = clamp(1 - this.energy / F.hungryAt, 0, 1);
    this.hunger = hunger;

    const oA = fFood.at(this.x, this.y);
    const oB = fFerm.at(this.x, this.y);
    const al = fAlarm.at(this.x, this.y);
    let onFood = false;
    for (const f of W.foods) {
      if (Math.hypot(f.x - this.x, f.y - this.y) < CFG.food.r + CFG.food.feedRange) { onFood = true; break; }
    }
    this.onFood = onFood;
    this.odSat = oA / (oA + 0.45);
    this.fermSat = oB / (oB + 0.45);
    this.alSat = al / (al + 0.75);
    const alW = onFood ? 0.25 : 1;      // 已经在取食的个体，警戒信号优先度下调

    /* 嗅觉（AL 增益受饥饿调制：饿则嗅觉更灵） */
    const oGain = this.gene.sense * (0.7 + 1.3 * hunger);
    this.setExt('ORN_food', 2.45 * this.odSat * oGain);
    this.setExt('ORN_ferm', 2.25 * this.fermSat * oGain);
    this.setExt('ORN_alarm', 2.25 * this.alSat * alW);

    /* 味觉：落在食物上 → 糖 GRN 强驱动（喙伸展反射） */
    this.setExt('GRN_sugar', onFood ? 2.40 : 0);

    /* 机械感觉：贴壁 / 与同伴相撞 */
    let mech = 0;
    const wp = F.wallPad;
    if (this.x < wp * 0.4 || this.x > W.w - wp * 0.4 || this.y < wp * 0.4 || this.y > W.h - wp * 0.4) mech += 1.2;
    for (const o of W.flies) {
      if (o === this || o.dead) continue;
      if (Math.hypot(o.x - this.x, o.y - this.y) < 9) { mech += 1.0; break; }
    }
    this.setExt('mechano', mech);

    /* 视觉：粘板/被粘同伴构成的"突现"刺激（looming）→ 巨纤维逃逸通路 */
    let loom = 0.2;
    this.trapNear = 0; this.trapDist = 1e9;
    for (const t of W.traps) {
      const d = rectDist(this.x, this.y, t);          // 到粘板表面的距离
      this.trapDist = Math.min(this.trapDist, d);
      if (d < CFG.trap.nearR) this.trapNear = Math.max(this.trapNear, 1 - d / CFG.trap.nearR);
    }
    loom += 1.9 * this.trapNear;
    this.setExt('visual', loom);

    /* 内部驱动：饥饿 / 取食 / 饱足（SEZ·FB） */
    this.setExt('Hugin', 2.05 * hunger);
    this.setExt('NPF', this.eating ? 2.10 : 0.45 + 0.8 * this.odSat * (onFood ? 1 : 0.3));
    // 饱足（FB 扇形体）是非线性的：只有接近满能量时才强烈抑制取食
    this.setExt('FB_energy', 2.05 * clamp((this.energy / F.eMax - 0.8) / 0.2, 0, 1));

    /* 非条件刺激（US）：粘板表面的挥发性刺激 → PPL1 多巴胺惩罚信号
       —— 这是"气味(CS) + 惩罚(US) → MB 记忆"的 US 端 */
    const us = 2.20 * clamp(1 - this.trapDist / CFG.trap.usR, 0, 1) + 2.40 * (this.usContact > 0 ? 1 : 0);
    this.setExt('DAN_PPL1', us + 1.5 * this.alSat * alW);

    /* 产卵运动程序：能量 + 蛋白（摄食）积累足够时的内部驱动 */
    const ready = (this.energy > F.reproEnergy && this.feedAcc >= F.feedNeed) ? 1 : 0;
    this.setExt('MN_oviposit', ready * 2.10);
    this.reproReady = ready;
  }
  setExt(name, v) {
    const c = NET.ct[name], ext = this.brain.ext;
    for (let i = 0; i < c.n; i++) ext[c.start + i] = v;
  }

  update(dt) {
    const F = CFG.fly;
    if (this.dead) { this.deadT += dt; return; }
    this.age += dt;
    this.cool = Math.max(0, this.cool - dt);
    this.pulse = Math.max(0, this.pulse - dt * 3);
    this.jitter += dt * 9;
    this.escapeT = Math.max(0, this.escapeT - dt);
    this.usContact = Math.max(0, this.usContact - dt);

    if (this.state === 'trapped') { this.updateTrapped(dt); return; }

    /* ---------- 感觉编码 + 脑推进 ---------- */
    this.encode(dt);
    this.brainAcc += dt;
    const stepDt = CFG.brain.dt;
    let steps = 0;
    const maxSteps = W.flies.length > 70 ? 1 : CFG.brain.stepsPerFrame;
    while (this.brainAcc >= stepDt && steps < maxSteps) {
      this.brain.step(stepDt); this.brainAcc -= stepDt; steps++;
    }
    if (this.brainAcc > 0.06) this.brainAcc = 0;

    const b = this.brain;
    const hunger = this.hunger;
    const aversion = b.aversion();          // MBON_av：学到的"这东西危险"
    if (aversion > this.peakAversion) this.peakAversion = aversion;
    const walkD = clamp(b.walkDrive(), 0, 2.5);
    const escape = b.escapeDrive();
    this.aversion = aversion;

    /* ---------- 逃逸（巨纤维 / DN_escape 爆发） ---------- */
    if (escape > F.escapeThr && this.escapeT <= 0) {
      this.escapeT = 0.45;
      this.dir += (Math.random() < 0.5 ? -1 : 1) * rand(1.2, 2.4);
      sparks(this.x, this.y, [255, 210, 140], 6);
      this.state = 'alarm';
    }

    /* ---------- 导航反射（VNC 局部回路） ---------- */
    const want = { x: 0, y: 0 };
    const seenFood = this.odSat > CFG.env.senseThresh;
    const seenFerm = this.fermSat > CFG.env.senseThresh;
    const risk = clamp(1 - 0.85 * aversion, 0.12, 1);   // 学到的回避 → 抑制趋源
    if (seenFood) {
      const [gx, gy] = fFood.grad(this.x, this.y);
      const n = Math.hypot(gx, gy) || 1;
      const dirv = this.nearSourceVec('food');
      const ux = gx / n * 0.6 + dirv.x, uy = gy / n * 0.6 + dirv.y;
      const m = Math.hypot(ux, uy) || 1;
      const w = this.odSat * F.seekGain * this.gene.sense * (0.45 + 1.75 * hunger);
      want.x += ux / m * w; want.y += uy / m * w;
    }
    if (seenFerm) {
      const [gx, gy] = fFerm.grad(this.x, this.y);
      const n = Math.hypot(gx, gy) || 1;
      const dirv = this.nearSourceVec('trap');
      const ux = gx / n * 0.6 + dirv.x, uy = gy / n * 0.6 + dirv.y;
      const m = Math.hypot(ux, uy) || 1;
      const w = this.fermSat * F.fermentGain * (0.45 + 1.75 * hunger) * risk;
      want.x += ux / m * w; want.y += uy / m * w;
    }
    /* 报警信息素 + 记忆 + 学会后的粘板绕行 */
    if (this.alSat > CFG.env.senseThresh) {
      const [gx, gy] = fAlarm.grad(this.x, this.y);
      const n = Math.hypot(gx, gy) || 1;
      const w = this.alSat * F.alarmGain * (1 - 0.5 * hunger);   // 饿则冒险
      want.x -= gx / n * w; want.y -= gy / n * w;
    }
    if (aversion > 0.1) {
      let rx = 0, ry = 0;
      const A = CFG.trap.avoidR, G = CFG.trap.avoidGain;
      for (const t of W.traps) {
        const cx = t.x + CFG.trap.w / 2, cy = t.y + CFG.trap.h / 2;
        const dx = this.x - cx, dy = this.y - cy, d = Math.hypot(dx, dy) || 1;
        const surf = rectDist(this.x, this.y, t);
        if (surf > A) continue;
        const w = (1 - surf / A) * aversion * G;
        rx += dx / d * w; ry += dy / d * w;
        /* 侧向规避：若正朝粘板飞（前进方向与"指向粘板"夹角小），加一个垂直分量把它推开 */
        const toTrap = Math.atan2(cy - this.y, cx - this.x);
        if (Math.abs(angDiff(toTrap, this.dir)) < 1.0) {
          const side = angDiff(toTrap, this.dir) > 0 ? -1 : 1;
          const px = Math.cos(this.dir + Math.PI / 2 * side), py = Math.sin(this.dir + Math.PI / 2 * side);
          const k = (1 - surf / A) * aversion * G * 0.8;
          rx += px * k; ry += py * k;
        }
      }
      want.x += rx; want.y += ry;
    }
    for (const m of this.mem) {
      const dx = this.x - m.x, dy = this.y - m.y, d = Math.hypot(dx, dy) || 1;
      if (d < CFG.trap.nearR) { const w = (1 - d / CFG.trap.nearR) * m.s * 1.6; want.x += dx / d * w; want.y += dy / d * w; }
    }
    /* 边界回避 */
    const wp = F.wallPad;
    if (this.x < wp) want.x += (1 - this.x / wp) * 1.2;
    if (this.x > W.w - wp) want.x -= (1 - (W.w - this.x) / wp) * 1.2;
    if (this.y < wp) want.y += (1 - this.y / wp) * 1.2;
    if (this.y > W.h - wp) want.y -= (1 - (W.h - this.y) / wp) * 1.2;

    /* ---------- 航向：反射 + 中央复合体/转向运动神经元的偏置 ---------- */
    const wm = Math.hypot(want.x, want.y);
    if (wm > 0.08) {
      const desired = Math.atan2(want.y, want.x);
      this.dir += clamp(angDiff(desired, this.dir), -F.turnRate * dt, F.turnRate * dt);
    } else {
      this.dir += Math.sin(this.age * 13 + this.castSeed) * F.cast * dt * 0.55;   // casting
    }
    this.dir += clamp(b.steerBias() * F.steerGain, -3, 3) * dt;                   // 脑的转向偏置
    const focus = clamp(this.odSat + this.fermSat * 0.7, 0, 1);
    this.dir += F.noise * this.gene.noise * (1 - 0.75 * focus) * randn() * dt;

    /* ---------- 速度：由 MN_walk 放电率驱动 ---------- */
    const tracking = wm > 0.35;
    const base = tracking ? F.surge : F.cruise;
    let target = base * (0.75 + 0.5 * hunger) * this.gene.speed * clamp(0.45 + 0.85 * walkD, 0.3, 2.3);
    if (this.escapeT > 0) target *= 1.9;
    if (this.eating) target *= 0.25;
    if (aversion > 0.45 && this.trapDist < 45) target *= 0.55;   // 学会后靠近粘板会减速悬停
    this.speed += (target - this.speed) * clamp(dt * 6, 0, 1);

    if (this.escapeT > 0) this.state = 'alarm';
    else if (this.eating) this.state = 'feed';
    else if (tracking) this.state = 'seek';
    else this.state = 'cast';

    /* ---------- 移动 ---------- */
    this.x += Math.cos(this.dir) * this.speed * dt + randn() * 0.06;
    this.y += Math.sin(this.dir) * this.speed * dt + randn() * 0.06;
    this.x = clamp(this.x, 2, W.w - 2); this.y = clamp(this.y, 2, W.h - 2);
    this.wingPhase += dt * (16 + this.speed * 0.07);

    /* ---------- 代谢（FB 扇形体：能量稳态） ---------- */
    let cost = F.drainBase + F.drainMove * (this.speed / F.surge) * 2;
    if (this.energy < F.desperateAt) cost *= 0.7;
    this.energy -= cost * dt;

    /* ---------- 取食：MN_feed（MN9）放电率 > 阈值 → 喙伸展取食 ---------- */
    this.eating = false;
    if (this.onFood) {
      const feed = b.feedDrive();
      if (feed > F.feedThr) {
        this.eating = true;
        this.state = 'feed';
        this.energy = Math.min(F.eMax, this.energy + CFG.food.feedRate * dt);
        this.feedAcc = Math.min(F.feedNeed, this.feedAcc + dt);
        this.dir += Math.sin(this.age * 6) * 1.2 * dt;
      }
    }

    /* ---------- 产卵：MN_oviposit 放电率 > 阈值 ---------- */
    if (this.reproReady && this.cool <= 0 && this.age > 5 && b.ovipDrive() > F.ovipThr &&
      W.flies.length < CFG.pop.max && Math.random() < F.reproChance * dt * 3) {
      this.feedAcc = 0;
      this.layEgg();
    }

    /* ---------- 记忆衰减 ---------- */
    for (const m of this.mem) m.s -= dt / F.forgetTau + 0.004 * dt;
    this.mem = this.mem.filter(m => m.s > 0.03);
    if (this.mem.length > F.memMax) this.mem.shift();

    /* ---------- 粘板：捕获 + 惩罚学习（MB 记忆由 DAN 驱动） ---------- */
    for (const t of W.traps) {
      const inside = this.x > t.x && this.x < t.x + CFG.trap.w && this.y > t.y && this.y < t.y + CFG.trap.h;
      if (inside) {
        if (Math.random() < CFG.trap.capture) { this.getStuck(t); break; }
        /* 接触胶面但没被粘住：挣扎弹开，同时受到强烈的伤害性刺激（学习信号） */
        const cx = t.x + CFG.trap.w / 2, cy = t.y + CFG.trap.h / 2;
        let dx = this.x - cx, dy = this.y - cy;
        if (Math.abs(dx) / CFG.trap.w > Math.abs(dy) / CFG.trap.h) {
          this.x = clamp(t.x + (dx > 0 ? CFG.trap.w + 3 : -3), 2, W.w - 2);
        } else {
          this.y = clamp(t.y + (dy > 0 ? CFG.trap.h + 3 : -3), 2, W.h - 2);
        }
        this.dir += rand(1.2, 2.6) * (Math.random() < 0.5 ? -1 : 1);
        this.escapeT = CFG.trap.bounce;
        this.usContact = 1.6;                  // 强惩罚信号（几秒内持续放电）
        this.peakAversion = Math.max(this.peakAversion, 0.4);
        sparks(this.x, this.y, [255, 200, 120], 5);
        break;
      }
      const cx = t.x + CFG.trap.w / 2, cy = t.y + CFG.trap.h / 2;
      const d = Math.hypot(this.x - cx, this.y - cy);
      if (d < CFG.trap.learnR && aversion > 0.25 && Math.random() < dt * 0.6) {
        this.mem.push({ x: cx, y: cy, s: 0.5 + 0.5 * aversion });
        if (this.mem.length > F.memMax) this.mem.shift();
      }
    }

    if (this.energy <= 0) { this.energy = 0; this.die('energy'); return; }
    if (this.age > F.lifespan) { this.die('age'); return; }
  }

  nearSourceVec(kind) {
    const V = CFG.env.visionRange;
    let vx = 0, vy = 0;
    const list = kind === 'food'
      ? W.foods.map(f => [f.x, f.y])
      : W.traps.map(t => [t.x + CFG.trap.w / 2, t.y + CFG.trap.h / 2]);
    for (const [px, py] of list) {
      const dx = px - this.x, dy = py - this.y, d = Math.hypot(dx, dy);
      if (d < V && d > 1) { const w = (1 - d / V) * 1.4; vx += dx / d * w; vy += dy / d * w; }
    }
    return { x: vx, y: vy };
  }

  updateTrapped(dt) {
    const P = CFG.pher;
    this.stuckT += dt;
    this.speed = 0;
    this.wingPhase += dt * 62;
    this.energy -= P.drain * dt;

    /* 被粘住时：强烈的伤害性刺激持续激活 PPL1 多巴胺系统
       → 与当时的气味表征（KC 活动）配对，写入 MB 厌恶性记忆 */
    this.brain.ext.fill(0);
    this.setExt('DAN_PPL1', 4.0);
    this.setExt('mechano', 2.2);
    this.setExt('ORN_ferm', 2.25 * this.fermSat);
    this.setExt('ORN_alarm', 2.25 * this.alSat);
    const maxSteps = W.flies.length > 70 ? 1 : CFG.brain.stepsPerFrame;
    let steps = 0;
    this.brainAcc += dt;
    while (this.brainAcc >= CFG.brain.dt && steps < maxSteps) {
      this.brain.step(CFG.brain.dt); this.brainAcc -= CFG.brain.dt; steps++;
    }
    this.aversion = this.brain.aversion();
    if (this.aversion > this.peakAversion) this.peakAversion = this.aversion;

    /* 释放警报信息素（同伴会回避）—— 由挣扎强度决定 */
    this.pherT += dt;
    const emitting = this.stuckT < P.emitDur && this.energy > 0;
    if (emitting && this.pherT >= P.interval) {
      this.pherT = 0;
      fAlarm.deposit(this.x, this.y, P.emit * P.interval, P.emitR);
      this.pulse = 1;
    }
    this.pheromone = emitting ? 1 : 0;

    if (Math.random() < 1 - Math.exp(-P.escape * dt)) {
      this.state = 'cruise';
      this.trap = null;
      this.energy = Math.max(this.energy, 12);
      this.escapeT = 0.6;
      sparks(this.x, this.y, [180, 255, 220], 10);
    }
    if (this.energy <= 0) { this.energy = 0; this.die('stuck'); }
    else if (this.age > CFG.fly.lifespan) this.die('age');
  }

  getStuck(t) {
    this.state = 'trapped';
    this.trap = t; this.onTrap = t;
    this.stuckT = 0;
    this.speed = 0;
    sparks(this.x, this.y, [255, 138, 120], 8);
  }

  layEgg() {
    const F = CFG.fly;
    this.energy -= F.reproCost;
    this.cool = F.reproCool;
    const ang = rand(0, TAU), r = rand(4, 14);
    W.eggs.push({
      x: clamp(this.x + Math.cos(ang) * r, 6, W.w - 6),
      y: clamp(this.y + Math.sin(ang) * r, 6, W.h - 6),
      t: 0, ttl: F.eggTime * rand(0.85, 1.15), ph: rand(0, TAU),
      gene: mutate(this.gene)
    });
    W.births++;
  }

  die(cause) {
    this.dead = true; this.cause = cause; this.deadT = 0;
    this.state = 'dead';
    W.deaths++;
    W.deathsByCause[cause] = (W.deathsByCause[cause] || 0) + 1;
    this.pheromone = 0;
    if (this.onTrap) {
      this.onTrap.bodies = this.onTrap.bodies || [];
      this.onTrap.bodies.push({ x: this.x, y: this.y, dir: this.dir });
    }
  }
}
function mutate(g) {
  const m = CFG.fly.mutate, n = {};
  for (const k in g) n[k] = clamp(g[k] * (1 + randn() * m), 0.5, 1.6);
  return n;
}

/* ----------------------------- 粒子 ----------------------------- */
const particles = [];
function sparks(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU), sp = rand(20, 90);
    particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.3, 0.8), t: 0, c: color });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.95; p.vy *= 0.95;
    if (p.t > p.life) particles.splice(i, 1);
  }
}

/* ----------------------------- 放置 / 清除 ----------------------------- */
function place(x, y) {
  const m = W.mode;
  if (m === 'food') {
    if (W.foods.some(f => Math.hypot(f.x - x, f.y - y) < CFG.food.r * 1.6)) return false;
    W.foods.push({ x, y, ph: rand(0, TAU) });
    return true;
  }
  if (m === 'trap') {
    const t = { x: clamp(x - CFG.trap.w / 2, 0, W.w - CFG.trap.w), y: clamp(y - CFG.trap.h / 2, 0, W.h - CFG.trap.h), ph: rand(0, TAU), bodies: [] };
    if (W.traps.some(o => Math.abs(o.x - t.x) < CFG.trap.w * 0.6 && Math.abs(o.y - t.y) < CFG.trap.h * 0.6)) return false;
    W.traps.push(t);
    return true;
  }
  if (m === 'fly') {
    if (spawnFly(x, y)) { sparks(x, y, [150, 200, 255], 8); return true; }
    return false;
  }
  if (m === 'erase') {
    for (let i = W.foods.length - 1; i >= 0; i--) if (Math.hypot(W.foods[i].x - x, W.foods[i].y - y) < 34) { W.foods.splice(i, 1); return true; }
    for (let i = W.traps.length - 1; i >= 0; i--) {
      const t = W.traps[i];
      if (x > t.x - 12 && x < t.x + CFG.trap.w + 12 && y > t.y - 12 && y < t.y + CFG.trap.h + 12) {
        for (const f of W.flies) if (f.trap === t) { f.dead = true; f.onTrap = null; f.deadT = 99; }
        W.traps.splice(i, 1); return true;
      }
    }
    for (let i = W.flies.length - 1; i >= 0; i--) if (!W.flies[i].dead && Math.hypot(W.flies[i].x - x, W.flies[i].y - y) < 22) { W.flies[i].onTrap = null; W.flies[i].die('removed'); return true; }
    return false;
  }
  return false;
}
function spawnFly(x, y, gene) {
  if (W.flies.filter(f => !f.dead).length >= CFG.pop.max) return null;
  const f = new Fly(clamp(x, 10, W.w - 10), clamp(y, 10, W.h - 10), gene);
  W.flies.push(f);
  return f;
}
function resetWorld() {
  W.foods = []; W.traps = []; W.eggs = []; W.corpses = []; W.flies = [];
  W.deathsByCause = {};
  particles.length = 0;
  W.time = 0; W.deaths = 0; W.births = 0;
  buildFields();
  const n = Math.round(CFG.pop.start);
  for (let i = 0; i < n; i++) spawnFly(rand(40, W.w - 40), rand(40, W.h - 40));
  W.foods.push({ x: W.w * 0.28, y: W.h * 0.35, ph: 0 });
  W.foods.push({ x: W.w * 0.7, y: W.h * 0.68, ph: 1.7 });
}

/* ----------------------------- 主循环 ----------------------------- */
let last = 0, fps = 60, fpsAcc = 0, fpsN = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!last) last = ts;
  let dt = (ts - last) / 1000;
  last = ts;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  dt = Math.min(dt, 1 / 30);
  if (!W.paused) simulate(dt);
  render(dt);
  if (W.showBrain) drawBrainPanel();
  probeAcc += dt;
  if (probeAcc > 2) { probeAcc = 0; probeRes = reflexProbe(); }
  uiTick(dt);
}
function simulate(dt) {
  W.time += dt;
  for (const f of W.foods) fFood.deposit(f.x, f.y, CFG.food.emit * dt, CFG.food.r * 1.3);
  for (const t of W.traps) fFerm.deposit(t.x + CFG.trap.w / 2, t.y + CFG.trap.h / 2, CFG.trap.emit * dt, Math.max(CFG.trap.w, CFG.trap.h) * 0.8);
  for (const f of W.flies) if (f.state === 'trapped' && !f.dead) fAlarm.deposit(f.x, f.y, CFG.pher.emit * dt * 0.5, CFG.pher.emitR);
  fFood.step(dt); fFerm.step(dt); fAlarm.step(dt);

  for (const f of W.flies) f.update(dt);
  for (let i = W.flies.length - 1; i >= 0; i--) {
    const f = W.flies[i];
    if (f.dead && f.deadT > 2.2 && !f.onTrap) {
      W.corpses.push({ x: f.x, y: f.y, dir: f.dir, t: 0 });
      if (W.corpses.length > 60) W.corpses.shift();
      W.flies.splice(i, 1);
    }
  }
  for (let i = W.corpses.length - 1; i >= 0; i--) { W.corpses[i].t += dt; if (W.corpses[i].t > 22) W.corpses.splice(i, 1); }
  for (let i = W.eggs.length - 1; i >= 0; i--) {
    const e = W.eggs[i]; e.t += dt;
    if (e.t >= e.ttl) { const f = spawnFly(e.x, e.y, e.gene); if (f) sparks(e.x, e.y, [255, 255, 200], 6); W.eggs.splice(i, 1); }
  }
  updateParticles(dt);
}

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

/* ----------------------------- 脑活动视图 -----------------------------
   展示被观察果蝇的 66 个神经元（按 Sensory/Drives/Central/Motor 分组）：
   节点亮度 = 放电率，颜色 = 兴奋(青绿)/抑制(品红)，KC→MBON 的可塑突触
   按其权重着色（红=厌恶性已增强，蓝=食欲性已增强）。 */
const LAY = (() => {
  const colOf = {
    ORN_food: 0, ORN_ferm: 0, ORN_alarm: 0, GRN_sugar: 0, mechano: 0, visual: 0,
    Hugin: 1, NPF: 1, FB_energy: 1,
    LN_al: 2, PN: 2, LHON: 2, KC: 2, APL: 2, MBON_app: 2, MBON_av: 2,
    DAN_PPL1: 3, DAN_PAM: 3, ring_EB: 3, PFN: 3, DN_escape: 3, DN_walk: 3,
    MN_feed: 4, MN_walk: 4, MN_steerL: 4, MN_steerR: 4, MN_oviposit: 4
  };
  const COLX = [34, 100, 168, 232, 296];
  const byCol = [[], [], [], [], []];
  for (let i = 0; i < NET.n; i++) byCol[colOf[NET.names[i]]].push(i);
  const pos = new Array(NET.n);
  for (let c = 0; c < 5; c++) {
    const arr = byCol[c], n = arr.length;
    for (let k = 0; k < n; k++) {
      const y = 50 + (n === 1 ? 108 : k * (216 / (n - 1)));   // 节点区 50~266，下方留给读出条
      pos[arr[k]] = { x: COLX[c], y };
    }
  }
  return pos;
})();
const COLN = ['Sensory', 'Drives', 'Central', 'Central', 'Motor'];

const bcv = document.getElementById('braincv');
const bctx = bcv ? bcv.getContext('2d') : null;
let bDPR = 1;
if (bcv) {
  bDPR = Math.min(window.devicePixelRatio || 1, 2);
  const Wp = 330, Hp = 372;
  bcv.width = Wp * bDPR; bcv.height = Hp * bDPR;
  bcv.style.width = Wp + 'px'; bcv.style.height = Hp + 'px';
}
function inspectedFly() {
  if (W.inspect && W.inspect.dead === false) return W.inspect;
  let best = null, bi = 0;
  for (const f of W.flies) {
    if (f.dead) continue;
    const li = f.brain.learnIndex();
    if (!best || li > bi) { best = f; bi = li; }
  }
  return best;
}
function drawBrainPanel() {
  if (!bctx) return;
  const f = inspectedFly();
  const Wp = 330, Hp = 372;
  bctx.setTransform(bDPR, 0, 0, bDPR, 0, 0);
  bctx.clearRect(0, 0, Wp, Hp);
  bctx.fillStyle = 'rgba(9,14,19,0.93)';
  roundRect(bctx, 0, 0, Wp, Hp, 12); bctx.fill();
  bctx.strokeStyle = '#1d2833'; bctx.lineWidth = 1; bctx.stroke();
  bctx.fillStyle = '#8fa5b8'; bctx.font = '10px -apple-system,sans-serif';
  const heads = ['Sensory', 'Drives', 'Central', 'Central', 'Motor'];
  const hx = [34, 100, 168, 232, 296];
  for (let i = 0; i < 5; i++) {
    bctx.textAlign = 'center';
    bctx.fillText(heads[i], hx[i], 42);
  }
  bctx.textAlign = 'left';
  if (!f) { bctx.fillText('（暂无果蝇）', 14, 70); return; }

  /* 边（先画，避免压住节点） */
  for (let e = 0; e < NET.E; e++) {
    const a = LAY[NET.S[e]], b = LAY[NET.D[e]];
    const pl = NET.PL[e];
    const wAbs = Math.abs(f.brain.w[e]);
    if (pl) {
      const rel = f.brain.w[e] / f.brain.w0[e];
      if (rel > 1.05) {
        bctx.strokeStyle = pl === 1 ? `rgba(255,90,110,${clamp((rel - 1) * 1.4, 0.15, 0.95)})`
          : `rgba(90,180,255,${clamp((rel - 1) * 1.4, 0.15, 0.95)})`;
        bctx.lineWidth = 1.6;
        bctx.beginPath(); bctx.moveTo(a.x, a.y); bctx.lineTo(b.x, b.y); bctx.stroke();
      }
      continue;
    }
    bctx.strokeStyle = `rgba(120,150,180,${clamp(wAbs * 0.05, 0.03, 0.3)})`;
    bctx.lineWidth = 0.6;
    bctx.beginPath(); bctx.moveTo(a.x, a.y); bctx.lineTo(b.x, b.y); bctx.stroke();
  }
  /* 节点 */
  for (let i = 0; i < NET.n; i++) {
    const p = LAY[i], r = f.brain.r[i];
    const act = clamp(r / 22, 0, 1);
    const exc = NET.sig[i] > 0;
    if (act > 0.02) {
      bctx.fillStyle = exc ? `rgba(90,225,175,${act * 0.35})` : `rgba(255,110,150,${act * 0.35})`;
      bctx.beginPath(); bctx.arc(p.x, p.y, 3 + act * 7, 0, TAU); bctx.fill();
    }
    bctx.fillStyle = exc ? `rgba(110,240,190,${0.35 + act * 0.65})` : `rgba(255,120,160,${0.35 + act * 0.65})`;
    bctx.beginPath(); bctx.arc(p.x, p.y, 3.1, 0, TAU); bctx.fill();
  }
  /* 读出条 */
  const bar = (label, val, max, color, y, unit) => {
    bctx.fillStyle = '#7e8fa0'; bctx.font = '9.5px -apple-system,sans-serif';
    bctx.fillText(label, 12, y - 2);
    bctx.textAlign = 'right';
    bctx.fillStyle = color;
    bctx.fillText(unit ? val.toFixed(1) + unit : val.toFixed(0), Wp - 12, y - 2);
    bctx.textAlign = 'left';
    bctx.fillStyle = 'rgba(255,255,255,0.07)';
    bctx.fillRect(12, y, Wp - 24, 4);
    bctx.fillStyle = color;
    bctx.fillRect(12, y, (Wp - 24) * clamp(val / max, 0, 1), 4);
  };
  let y0 = 372 - 96;
  const mbAv = f.brain.learnIndex();
  bar('MBON_av 厌恶性权重（学到的"粘板危险"）', (mbAv - 1) / (CFG.brain.wMax - 1) * 100, 100, '#ff7a92', y0, '%');
  bar('MN_walk 行进驱动', f.brain.rate('MN_walk'), 40, '#6fe0b0', y0 + 20, 'Hz');
  bar('MN_feed 喙伸展（取食）', f.brain.rate('MN_feed'), 40, '#ffd479', y0 + 40, 'Hz');
  bar('DN_escape 逃逸', f.brain.rate('DN_escape'), 40, '#ff9a6f', y0 + 60, 'Hz');
  bctx.fillStyle = '#cfe0ee'; bctx.font = '11px -apple-system,sans-serif';
  bctx.fillText(`观察对象：果蝇 #${f.id}`, 12, 16);
  bctx.textAlign = 'right';
  bctx.fillStyle = '#8fa5b8';
  bctx.fillText(`全脑 ${f.brain.popRateSlow.toFixed(2)} Hz · ${NET.n} 神经元 / ${NET.E} 突触`, Wp - 12, 16);
  bctx.fillStyle = '#8fa5b8'; bctx.font = '10px -apple-system,sans-serif';
  bctx.fillText(`状态 ${MODE_CN[f.state] || f.state} · 能量 ${f.energy.toFixed(0)} · 饥饿 ${(f.hunger * 100 || 0).toFixed(0)}%`, Wp - 12, 30);
  bctx.textAlign = 'left';
}

/* ----------------------------- UI：统计 ----------------------------- */
const statsEl = document.getElementById('stats');
let statsAcc = 0;
function uiTick(dt) {
  statsAcc += dt || 0.016;
  if (statsAcc < 0.25) return;
  statsAcc = 0;
  const alive = W.flies.filter(f => !f.dead);
  const stuck = alive.filter(f => f.state === 'trapped').length;
  const hungry = alive.filter(f => f.energy < CFG.fly.hungryAt).length;
  const feeding = alive.filter(f => f.eating).length;
  const learned = alive.filter(f => (f.peakAversion || 0) > 0.35).length;
  const avgE = alive.length ? alive.reduce((a, f) => a + f.energy, 0) / alive.length : 0;
  const brainRate = alive.length ? alive.reduce((a, f) => a + f.brain.popRateSlow, 0) / alive.length : 0;
  statsEl.innerHTML =
    `<div><span class="k">果蝇</span> <b class="ok">${alive.length}</b> <span class="k">/ 上限 ${CFG.pop.max}</span></div>` +
    `<div><span class="k">被粘住</span> <b class="bad">${stuck}</b>` +
    ` <span class="k">｜饥饿</span> <b class="hi">${hungry}</b>` +
    ` <span class="k">｜取食中</span> <b>${feeding}</b></div>` +
    `<div><span class="k">食物</span> <b>${W.foods.length}</b>` +
    ` <span class="k">｜粘板</span> <b>${W.traps.length}</b>` +
    ` <span class="k">｜卵</span> <b>${W.eggs.length}</b></div>` +
    `<div><span class="k">出生</span> <b>${W.births}</b> <span class="k">｜死亡</span> <b class="bad">${W.deaths}</b>` +
    ` <span class="k">｜平均能量</span> <b>${avgE.toFixed(0)}</b></div>` +
    `<div><span class="k">全脑放电率</span> <b>${brainRate.toFixed(2)} Hz</b>` +
    ` <span class="k">｜已学习</span> <b class="hi">${learned}</b></div>` +
    `<div><span class="k">反射自检</span> ${reflexLine()}</div>` +
    `<div><span class="k">时间</span> <b>${W.time.toFixed(0)}s</b> <span class="k">｜FPS</span> <b>${fps.toFixed(0)}</b>` +
    ` <span class="k">｜dpr ${DPR}</span></div>`;
}

/* ----------------------------- UI：参数面板 ----------------------------- */
const PARAM_SPEC = [
  ['g', '脑 / 网络（flybench 口径）'],
  ['brain.gain', '全局增益 gain（0.40–0.45 为反射通过区）', 0.1, 1.2, 0.01],
  ['brain.wSyn', '单突触权重基准 w_syn (mV)', 0.05, 1, 0.005],
  ['brain.lr', '多巴胺学习率（PPL1→MB 权重）', 0, 3, 0.05],
  ['brain.noise', '自发噪声强度', 0, 0.6, 0.01],
  ['brain.wMax', '可塑权重上限（倍数）', 1.2, 6, 0.1],
  ['brain.dt', '脑步长 (s)', 0.002, 0.03, 0.001],
  ['brain.stepsPerFrame', '每帧脑步数', 1, 5, 1],
  ['g', '运动 / 飞行'],
  ['fly.cruise', '巡航速度 (px/s)', 10, 160, 1],
  ['fly.surge', '气味冲刺速度 (px/s)', 20, 300, 1],
  ['fly.turnRate', '转向速率 (rad/s)', 0.5, 12, 0.1],
  ['fly.noise', '随机游走强度 (rad/s)', 0, 8, 0.1],
  ['fly.cast', '气味丢失时搜索幅度', 0, 12, 0.1],
  ['fly.size', '体型缩放', 0.5, 2, 0.05],
  ['g', '能量 / 饥饿驱动'],
  ['fly.eMax', '能量上限', 60, 300, 5],
  ['fly.drainBase', '基础代谢 (能量/s)', 0, 4, 0.05],
  ['fly.drainMove', '运动代谢系数', 0, 3, 0.05],
  ['fly.hungryAt', '饥饿阈值 (能量)', 10, 120, 1],
  ['fly.desperateAt', '极饿阈值 (冒险)', 0, 80, 1],
  ['food.feedRate', '进食回复 (能量/s)', 0, 80, 1],
  ['g', '嗅觉 / 信息素'],
  ['fly.seekGain', '食物气味吸引强度', 0, 4, 0.05],
  ['fly.fermentGain', '发酵气味吸引强度(粘板诱惑)', 0, 4, 0.05],
  ['fly.alarmGain', '报警信息素回避强度', 0, 6, 0.05],
  ['pher.emit', '信息素释放强度', 0, 8, 0.1],
  ['pher.emitDur', '信息素释放时长 (s)', 0, 60, 1],
  ['env.alarmTau', '信息素残留时间 (s)', 1, 30, 0.5],
  ['env.visionRange', '近距趋源范围 (px)', 0, 220, 5],
  ['g', '行为读出阈值（运动神经元 → 行为）'],
  ['fly.feedThr', '取食阈值 MN9 (Hz)', 0, 30, 0.5],
  ['fly.escapeThr', '逃逸阈值 DN_escape (Hz)', 0, 40, 1],
  ['fly.ovipThr', '产卵阈值 MN_oviposit (Hz)', 0, 30, 0.5],
  ['fly.steerGain', '转向偏置增益', 0, 40, 1],
  ['g', '繁殖 / 种群'],
  ['fly.reproChance', '繁殖率系数', 0, 1, 0.01],
  ['fly.reproEnergy', '繁殖所需能量', 50, 145, 1],
  ['fly.reproCost', '繁殖消耗能量', 5, 100, 1],
  ['fly.feedNeed', '产卵前需累计摄食 (s)', 0, 30, 0.5],
  ['fly.reproCool', '繁殖冷却 (s)', 0.5, 60, 0.5],
  ['fly.eggTime', '卵孵化时间 (s)', 2, 40, 1],
  ['fly.lifespan', '寿命 (s)', 20, 600, 5],
  ['pop.start', '初始果蝇数(重置后生效)', 0, 80, 1],
  ['pop.max', '种群上限', 10, 400, 5],
  ['g', '粘板'],
  ['trap.emit', '粘板发酵气味强度', 0, 8, 0.1],
  ['trap.learnR', '危险学习半径 (px)', 0, 200, 5],
  ['pher.drain', '被粘住能量流失 (能量/s)', 0, 10, 0.1],
  ['pher.escape', '挣脱概率 (每秒)', 0, 0.2, 0.002]
];
const slidersEl = document.getElementById('sliders');
const fmt = v => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
function buildSliders() {
  slidersEl.innerHTML = '';
  for (const spec of PARAM_SPEC) {
    if (spec[0] === 'g') {
      const h = document.createElement('h3');
      h.textContent = spec[1]; h.style.marginTop = '12px';
      slidersEl.appendChild(h);
      continue;
    }
    const [path, label, min, max, step] = spec;
    const row = document.createElement('div');
    row.className = 'row';
    const cur = getPath(CFG, path);
    row.innerHTML = `<label>${label}<span id="v_${path}">${fmt(cur)}</span></label>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${cur}">`;
    const inp = row.querySelector('input');
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      setPath(CFG, path, v);
      document.getElementById('v_' + path).textContent = fmt(v);
      if (path === 'brain.gain' || path === 'brain.wSyn') retuneNet();
      if (path === 'fly.size' || path === 'env.visionRange') { /* 即时生效 */ }
    });
    slidersEl.appendChild(row);
  }
}
/* 改变全局 gain / w_syn → 重编译连接拓扑并同步各脑权重（可塑性记忆会重置） */
function retuneNet() {
  NET = compileNet();
  for (const f of W.flies) {
    f.brain.w0 = NET.W0.slice();
    f.brain.w = NET.W0.slice();
    const g = f.gene.brainGain;
    for (let e = 0; e < NET.E; e++) f.brain.w[e] *= g;
  }
}

/* ----------------------------- UI：按钮 ----------------------------- */
const modeBtns = [...document.querySelectorAll('[data-mode]')];
function setMode(m) {
  W.mode = m;
  for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === m);
  hint(m === 'food' ? '点击/拖动放置食物（果蝇会被气味吸引，落到食物上才会取食）'
    : m === 'trap' ? '放置粘板：发酵气味会吸引果蝇；靠近会被粘住——它们会把这段经历学进蘑菇体'
      : m === 'fly' ? '点击投放果蝇'
        : '点击/拖动清除食物、粘板或果蝇');
}
for (const b of modeBtns) b.addEventListener('click', () => setMode(b.dataset.mode));
const btnPause = document.getElementById('btnPause');
btnPause.addEventListener('click', () => {
  W.paused = !W.paused;
  btnPause.textContent = W.paused ? '▶ 继续' : '⏸ 暂停';
  btnPause.classList.toggle('on', W.paused);
  const po = document.getElementById('paused');
  if (po) po.style.display = W.paused ? 'flex' : 'none';
});
const btnField = document.getElementById('btnField');
btnField.addEventListener('click', () => {
  W.showField = !W.showField;
  btnField.classList.toggle('on', W.showField);
});
const btnBrain = document.getElementById('btnBrain');
btnBrain.addEventListener('click', () => {
  W.showBrain = !W.showBrain;
  btnBrain.classList.toggle('on', W.showBrain);
  document.getElementById('brainwrap').style.display = W.showBrain ? 'block' : 'none';
  document.body.classList.toggle('brainon', W.showBrain);
});
const btnView = document.getElementById('btnView');
let viewMode = 0;
function cycleView() {
  viewMode = (viewMode + 1) % 3;
  if (viewMode === 0) { W.follow = null; W.userZoom = false; camReset(); hint('自由环绕视角'); }
  else if (viewMode === 1) toggleFollow(); else toggleTopView();
  btnView.classList.toggle('on', viewMode !== 0);
}
btnView.addEventListener('click', cycleView);
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === 'v') cycleView(); else if (k === 'f') toggleFollow();
});
const btnParam = document.getElementById('btnParam');
btnParam.addEventListener('click', () => {
  document.getElementById('panel').classList.toggle('show');
  btnParam.classList.toggle('on');
});
document.getElementById('btnReset').addEventListener('click', () => resetWorld());
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === '1') setMode('food');
  else if (k === '2') setMode('trap');
  else if (k === '3') setMode('fly');
  else if (k === '4') setMode('erase');
  else if (k === 'd') btnField.click();
  else if (k === 'b') btnBrain.click();
  else if (k === 'r') resetWorld();
  else if (e.code === 'Space') { e.preventDefault(); btnPause.click(); }
});

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
      cam.theta -= dx * 0.007;
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

/* ----------------------------- 启动 ----------------------------- */
buildFields();
initGL();
buildSliders();
resetWorld();
setMode('food');
requestAnimationFrame(frame);

/* ============================================================================
   flybench 式反射自检：用一个"探针脑"（不参与游戏）在纯刺激条件下测读出，
   逐项对照社区公布的反射判据（阈值取自 flybench 的 reference LIF 口径）。
   ========================================================================== */
let probeBrain = null, probeRes = null, probeAcc = 99;
function reflexProbe() {
  if (!probeBrain) probeBrain = new Brain({ speed: 1, sense: 1, brainGain: 1, learn: 1, size: 1, noise: 1 });
  const dt = CFG.brain.dt, steps = 30;
  const set = (nm, v) => { const c = NET.ct[nm]; for (let i = 0; i < c.n; i++) probeBrain.ext[c.start + i] = v; };
  const run = (setup) => {
    const pb = probeBrain;
    pb.ext.fill(0); pb.v.fill(0); pb.I.fill(0); pb.r.fill(0); pb.refr.fill(0); pb.kcTrace.fill(0);
    pb.w.set(pb.w0);
    if (setup) setup();
    let acc = 0;
    for (let i = 0; i < steps; i++) { pb.step(dt); if (i >= steps - 10) acc += pb.popRate; }
    return acc / 10;
  };
  const r0 = { base: run(null) };
  r0.sugarFeed = run(() => set('GRN_sugar', 2.4)) >= 0 ? probeBrain.rate('MN_feed') : 0;
  r0.bitterFeed = run(() => { set('GRN_sugar', 2.4); set('ORN_alarm', 2.25); }) >= 0 ? probeBrain.rate('MN_feed') : 0;
  r0.loomGF = run(() => set('visual', 2.1)) >= 0 ? probeBrain.rate('DN_escape') : 0;
  r0.odorWalk = run(() => set('ORN_food', 2.45)) >= 0 ? probeBrain.rate('MN_walk') : 0;
  r0.checks = [
    ['静默→静默', r0.base < 0.5, r0.base.toFixed(2) + 'Hz'],
    ['糖→MN9', r0.sugarFeed > 5, r0.sugarFeed.toFixed(0) + 'Hz'],
    ['警戒抑制糖', r0.bitterFeed < Math.max(5, r0.sugarFeed * 0.5), r0.bitterFeed.toFixed(0) + 'Hz'],
    ['突现→巨纤维', r0.loomGF > 10, r0.loomGF.toFixed(0) + 'Hz'],
    ['气味→行进', r0.odorWalk > 5, r0.odorWalk.toFixed(0) + 'Hz']
  ];
  return r0;
}
function reflexLine() {
  if (!probeRes) return '<span class="k">测量中…</span>';
  return probeRes.checks.map(c =>
    `<b style="color:${c[1] ? '#6fe0b0' : '#ff8fa3'}">${c[1] ? '✓' : '✗'}${c[0]}</b>`).join(' ');
}
