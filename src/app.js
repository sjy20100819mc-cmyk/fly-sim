/* ============================================================================
   果蝇自主行为模拟器  ·  Drosophila melanogaster Autonomous Behavior Sim
   行为规则参考开源果蝇全脑模型 / 连接组研究的概念映射：
     · FlyWire 全脑连接组 (flywire.ai)      —— 回路即行为
     · philshiu/Drosophila_brain_model      —— 全脑 LIF 脉冲网络
     · fly-brain-snntorch                   —— SNN 行为读出
   本作把下列神经回路抽象成了参数化的行为模块（非生理级仿真，是可解释的简化）：
     AL 触角叶 → LH 侧角      : 气味识别与吸引（食物气味 / 发酵气味）
     SEZ 食管下区 (Hugin/NPF) : 饥饿驱动，能量低 → 觅食增益升高
     MB 蘑菇体 (γ 叶)         : 惩罚性记忆（被粘板附近"学会"回避）
     PPL1 多巴胺能神经元      : 惩罚信号，写入 MB 记忆
     EB 椭球体 (heading)      : 航向保持 / 气味丢失时的 zig-zag 搜索(casting)
     FB 扇形体               : 能量稳态与睡眠-觉醒（能量耗尽 → 死亡）
     AL→LH 报警信息素 (Z11-18:OAc 类比) : 同类被粘 → 释放警戒信息素 → 同伴回避
   ========================================================================== */
'use strict';

/* ----------------------------- 工具函数 ----------------------------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const randn = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
const TAU = Math.PI * 2;
function angDiff(a, b) {           // 归一化到 [-π, π]
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
function getPath(o, p) { return p.split('.').reduce((a, k) => a[k], o); }
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }

/* ----------------------------- 全局参数 -----------------------------
   所有可调参数集中在这里；网页「⚙︎ 参数」面板改的就是这个对象。 */
const CFG = {
  /* 环境 / 气味场 */
  env: {
    cell: 20,             // 气味场格子边长(px)，越小越精细、越慢
    odorTau: 3.4,         // 食物气味衰减时间常数(s)
    odorDiff: 0.20,       // 食物气味扩散混合系数(0~0.25)
    fermTau: 4.2,         // 发酵气味(粘板)衰减时间常数(s)
    fermDiff: 0.22,
    alarmTau: 5.5,        // 报警信息素衰减时间常数(s)，挥发越慢警戒范围越大
    alarmDiff: 0.18,
    senseThresh: 0.035,   // 气味感知阈值：低于此值视为"闻不到"
    visionRange: 96       // 近距视觉/直接趋源范围(px)
  },
  /* 食物 */
  food: {
    r: 15,              // 半径(px)
    emit: 4.2,          // 气味沉积速率(单位/s)
    feedRate: 30,       // 停食时能量回复(能量/s)
    feedRange: 4,       // 判定进食的额外容差(px)
    satiated: 0.82      // 能量恢复到该比例后离开食物
  },
  /* 苍蝇粘 */
  trap: {
    w: 52, h: 34,        // 尺寸(px)
    emit: 2.4,           // 发酵气味沉积速率（吸引源）
    learnR: 52,          // 进入该范围即开始"学习"危险（PPL1 惩罚信号）
    nearR: 74            // 学会后产生的主动绕行距离
  },
  /* 报警信息素 */
  pher: {
    emit: 2.0,           // 被粘果蝇释放强度(单位/s)
    emitR: 20,           // 释放半径(px)
    emitDur: 20,         // 持续释放时长(s)：挣扎久了就力竭，不再报警
    interval: 0.28,      // 释放间隔(s)
    escape: 0.012,       // 被粘后每秒挣脱概率(0 = 永不脱身)
    drain: 2.2           // 被粘住时能量流失(能量/s)，挣扎到死
  },
  /* 果蝇本体 */
  fly: {
    cruise: 58,          // 巡航速度(px/s)
    surge: 132,          // 追踪气味时的冲刺速度(px/s)
    turnRate: 5.0,       // 最大转向速率(rad/s)
    noise: 2.4,          // 随机游走强度(rad/s)
    cast: 5.2,           // 气味丢失后的 zig-zag 搜索幅度(rad/s)
    size: 1.0,           // 体型缩放
    eMax: 145,           // 能量上限
    eStart: 115,         // 出生能量
    drainBase: 0.85,     // 基础代谢(能量/s)
    drainMove: 0.60,     // 运动代谢系数
    hungryAt: 62,        // 低于该能量 → 饥饿态（觅食增益上升）
    desperateAt: 26,     // 极饿：冒险，主动靠近粘板
    odorGain: 1.6,       // 食物气味吸引权重
    fermGain: 1.25,      // 发酵气味吸引权重（粘板的诱惑）
    alarmGain: 1.6,      // 报警信息素回避权重
    learnRate: 0.60,     // 避害学习速率(PPL1→MB)
    forgetTau: 26,       // 记忆衰减时间常数(s)
    memMax: 5,           // 空间记忆点上限
    reproChance: 0.10,   // 繁殖概率系数(每秒)
    reproCost: 32,       // 繁殖消耗能量
    reproEnergy: 105,    // 触发繁殖的能量阈值
    feedNeed: 5,         // 产卵前需累计的摄食时间(s)：模拟产卵需要蛋白质
    reproCool: 30,       // 繁殖冷却(s)
    eggTime: 13,         // 卵孵化时间(s)
    lifespan: 165,       // 寿命(s)
    wallPad: 34,         // 靠近边界的转向缓冲(px)
    mutate: 0.10         // 子代基因突变比例
  },
  /* 种群 */
  pop: { start: 16, max: 160 }
};

/* ----------------------------- 世界状态 ----------------------------- */
const W = {
  w: 0, h: 0,          // 画布逻辑尺寸(CSS px)
  cols: 0, rows: 0,    // 气味场格数
  foods: [], traps: [], eggs: [], corpses: [],
  flies: [],
  time: 0, tick: 0,
  deaths: 0, births: 0,
  paused: false,
  showField: false,
  mode: 'food'
};

/* ----------------------------- 气味场 -----------------------------
   标量场：沉积 → 各向同性扩散 → 指数挥发。
   近似"气味云"的空间分布，果蝇通过梯度导航（真实果蝇用触角叶做时空
   对比计算，这里用空间梯度代替）。 */
class Field {
  constructor(cols, rows, tau, diff, color) {
    this.cols = cols; this.rows = rows;
    this.tau = tau; this.k = diff; this.color = color;
    this.cur = new Float32Array(cols * rows);
    this.nxt = new Float32Array(cols * rows);
    this.max = 1;
    this.cv = document.createElement('canvas');
    this.cv.width = cols; this.cv.height = rows;
    this.cx = this.cv.getContext('2d');
    this.img = this.cx.createImageData(cols, rows);
  }
  clear() { this.cur.fill(0); this.nxt.fill(0); this.max = 1; }
  deposit(x, y, amt, rad) {                 // amt: 每秒沉积量；调用方需乘 dt
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
        const l = cur[x > 0 ? i - 1 : i];
        const r = cur[x < cols - 1 ? i + 1 : i];
        const u = cur[y > 0 ? i - cols : i];
        const d = cur[y < rows - 1 ? i + cols : i];
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
  grad(x, y) {                               // 返回未归一化梯度 (dx, dy)
    const cs = CFG.env.cell, h = 1;
    return [
      (this.at(x + cs * h, y) - this.at(x - cs * h, y)) / (2 * cs * h),
      (this.at(x, y + cs * h) - this.at(x, y - cs * h)) / (2 * cs * h)
    ];
  }
  render(ctx) {                              // 用低分辨率 canvas 放大成"气味云"
    const d = this.img.data;
    const mx = Math.max(this.max, 0.35);
    const [r, g, b] = this.color;
    for (let i = 0; i < this.cur.length; i++) {
      const t = clamp(this.cur[i] / mx, 0, 1);
      const a = t === 0 ? 0 : Math.pow(t, 0.65) * 235;
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

let fFood, fFerm, fAlarm;   // 三个场：食物气味 / 发酵气味 / 报警信息素

function buildFields() {
  const cs = CFG.env.cell;
  W.cols = Math.max(1, Math.ceil(W.w / cs));
  W.rows = Math.max(1, Math.ceil(W.h / cs));
  fFood = new Field(W.cols, W.rows, CFG.env.odorTau, CFG.env.odorDiff, [255, 168, 74]);
  fFerm = new Field(W.cols, W.rows, CFG.env.fermTau, CFG.env.fermDiff, [255, 224, 96]);
  fAlarm = new Field(W.cols, W.rows, CFG.env.alarmTau, CFG.env.alarmDiff, [255, 74, 110]);
}

/* ----------------------------- 果蝇个体 -----------------------------
   每只果蝇是一个自主 agent：内部状态机 + 基因权重 + 空间记忆。
   状态：cruise(巡航) / seek(追踪气味) / feed(进食) / cast(zig-zag 搜索) /
         alarm(惊逃) / trapped(被粘住) / dead */
let flyId = 1;
class Fly {
  constructor(x, y, gene) {
    const F = CFG.fly;
    this.id = flyId++;
    this.x = x; this.y = y;
    this.dir = rand(0, TAU);
    this.gene = gene || {
      speed: rand(0.85, 1.15), odor: rand(0.8, 1.2), ferment: rand(0.75, 1.25),
      alarm: rand(0.8, 1.2), learn: rand(0.75, 1.25), size: rand(0.9, 1.1), noise: rand(0.8, 1.2)
    };
    this.energy = F.eStart * rand(0.85, 1.0);
    this.age = 0;
    this.eating = false;
    this.state = 'cruise';
    this.speed = F.cruise;
    this.wingPhase = rand(0, TAU);
    this.castSeed = rand(0, TAU);
    this.trapAvoid = 0;         // MB 惩罚记忆强度 0~1
    this.mem = [];              // 空间记忆点 {x,y,s}
    this.cool = 0;              // 繁殖冷却
    this.pherT = rand(0, 0.3);
    this.feedAcc = 0;          // 累计摄食时间（产卵需要）
    this.pulse = 0;             // 释放信息素的视觉脉冲
    this.stuckT = 0;            // 被粘住时长
    this.trap = null;
    this.jitter = rand(0, TAU);
    this.odSat = 0; this.alSat = 0;
    this.dead = false; this.deadT = 0; this.cause = '';
    // 神经抽象层的当前"读数"，仅用于展示（tooltip）
    this.notes = [];
  }

  /* ---- 感知：AL→LH 气味通路 + 报警信息素 ---- */
  sense() {
    const E = CFG.env;
    const oA = fFood.at(this.x, this.y);
    const oB = fFerm.at(this.x, this.y);
    const al = fAlarm.at(this.x, this.y);
    this.odSat = oA / (oA + 0.45);          // 食物气味饱和响应
    this.fermSat = oB / (oB + 0.45);
    this.alSat = al / (al + 0.35);          // 报警信息素响应

    let vx = 0, vy = 0;
    const seen = { food: 0, ferm: 0 };

    // 1) 气味梯度趋向（浓度升高方向 = 源头方向）
    if (oA > E.senseThresh) {
      const [gx, gy] = fFood.grad(this.x, this.y);
      const n = Math.hypot(gx, gy);
      if (n > 1e-6) { vx += gx / n * this.odSat; vy += gy / n * this.odSat; seen.food = 1; }
    }
    if (oB > E.senseThresh) {
      const [gx, gy] = fFerm.grad(this.x, this.y);
      const n = Math.hypot(gx, gy);
      if (n > 1e-6) { vx += gx / n * this.fermSat; vy += gy / n * this.fermSat; seen.ferm = 1; }
    }
    // 2) 近距直接趋源（视觉 + 近场气味）
    const V = E.visionRange;
    for (const f of W.foods) {
      const dx = f.x - this.x, dy = f.y - this.y, d = Math.hypot(dx, dy);
      if (d < V && d > 1) { const w = (1 - d / V) * 1.6; vx += dx / d * w; vy += dy / d * w; seen.food = 1; }
    }
    for (const t of W.traps) {
      const cx = t.x + CFG.trap.w / 2, cy = t.y + CFG.trap.h / 2;
      const dx = cx - this.x, dy = cy - this.y, d = Math.hypot(dx, dy);
      if (d < V && d > 1) { const w = (1 - d / V) * 1.3; vx += dx / d * w; vy += dy / d * w; seen.ferm = 1; }
    }
    // 3) 报警信息素回避（梯度上升方向的反方向）
    if (al > E.senseThresh) {
      const [gx, gy] = fAlarm.grad(this.x, this.y);
      const n = Math.hypot(gx, gy);
      if (n > 1e-6) { vx -= gx / n * this.alSat * 2.0; vy -= gy / n * this.alSat * 2.0; }
    }
    // 4) MB 惩罚记忆点回避
    for (const m of this.mem) {
      const dx = this.x - m.x, dy = this.y - m.y, d = Math.hypot(dx, dy) || 1;
      if (d < CFG.trap.nearR) { const w = (1 - d / CFG.trap.nearR) * m.s * 1.8; vx += dx / d * w; vy += dy / d * w; }
    }
    // 5) 学会后主动绕开粘板（PPL1→MB 输出的运动抑制）
    if (this.trapAvoid > 0.15) {
      for (const t of W.traps) {
        const cx = t.x + CFG.trap.w / 2, cy = t.y + CFG.trap.h / 2;
        const dx = this.x - cx, dy = this.y - cy, d = Math.hypot(dx, dy) || 1;
        if (d < CFG.trap.nearR) {
          const w = (1 - d / CFG.trap.nearR) * this.trapAvoid * 2.4;
          vx += dx / d * w; vy += dy / d * w;
        }
      }
    }
    return { vx, vy, seen, oA, oB, al };
  }

  update(dt) {
    const F = CFG.fly;
    if (this.dead) { this.deadT += dt; return; }
    this.age += dt;
    this.cool = Math.max(0, this.cool - dt);
    this.pulse = Math.max(0, this.pulse - dt * 3);
    this.jitter += dt * 9;

    if (this.state === 'trapped') { this.updateTrapped(dt); return; }

    /* ---------- 饥饿驱动（SEZ: Hugin / NPF 神经元） ---------- */
    const hunger = clamp(1 - this.energy / F.hungryAt, 0, 1);        // 0 饱 ~ 1 极饿
    const desperate = this.energy < F.desperateAt;
    // 饥饿 → 觅食增益上升；极饿时"铤而走险"，对粘板的戒心下降
    const seekGain = 0.45 + 1.75 * hunger;
    const risk = desperate ? 0.45 + 0.55 * (1 - this.trapAvoid) : (1 - 0.85 * this.trapAvoid);

    const s = this.sense();
    const want = { x: 0, y: 0 };

    if (s.seen.food) {
      const [gx, gy] = fFood.grad(this.x, this.y);
      const n = Math.hypot(gx, gy) || 1;
      const direct = this.nearSourceVec('food');
      const ux = (gx / n) * 0.6 + direct.x, uy = (gy / n) * 0.6 + direct.y;
      const m = Math.hypot(ux, uy) || 1;
      want.x += ux / m * this.odSat * F.odorGain * this.gene.odor * seekGain;
      want.y += uy / m * this.odSat * F.odorGain * this.gene.odor * seekGain;
    }
    if (s.seen.ferm) {
      const [gx, gy] = fFerm.grad(this.x, this.y);
      const n = Math.hypot(gx, gy) || 1;
      const direct = this.nearSourceVec('trap');
      const ux = (gx / n) * 0.6 + direct.x, uy = (gy / n) * 0.6 + direct.y;
      const m = Math.hypot(ux, uy) || 1;
      const w = this.fermSat * F.fermGain * this.gene.ferment * seekGain * risk;
      want.x += ux / m * w; want.y += uy / m * w;
    }
    // 报警信息素 + 记忆 + 绕行（已在 sense 里并入 vx/vy 的一部分，这里再加一次总量）
    if (s.al > CFG.env.senseThresh || this.mem.length || this.trapAvoid > 0.15) {
      const rep = this.repelVec();
      const w = F.alarmGain * this.gene.alarm * (1 - 0.45 * hunger);
      want.x += rep.x * w;
      want.y += rep.y * w;
    }
    // 边界回避
    const wp = F.wallPad;
    if (this.x < wp) want.x += (1 - this.x / wp) * 1.2;
    if (this.x > W.w - wp) want.x -= (1 - (W.w - this.x) / wp) * 1.2;
    if (this.y < wp) want.y += (1 - this.y / wp) * 1.2;
    if (this.y > W.h - wp) want.y -= (1 - (W.h - this.y) / wp) * 1.2;

    /* ---------- 航向决策（EB 椭球体：heading） ---------- */
    const wm = Math.hypot(want.x, want.y);
    if (wm > 0.08) {
      const desired = Math.atan2(want.y, want.x);
      const d = angDiff(desired, this.dir);
      this.dir += clamp(d, -F.turnRate * dt, F.turnRate * dt);
    }
    /* 气味丢失时的 zig-zag 搜索（真实果蝇的 casting 行为） */
    const lost = wm < 0.08;
    if (lost) {
      this.dir += Math.sin(this.age * 13 + this.castSeed) * F.cast * dt * 0.55;
    }
    /* 随机游走噪声：气味越强噪声越小（注意力聚焦） */
    const focus = clamp(this.odSat + this.fermSat * 0.7, 0, 1);
    this.dir += F.noise * this.gene.noise * (1 - 0.75 * focus) * randn() * dt;

    /* ---------- 速度策略 ---------- */
    const tracking = wm > 0.35;
    const target = tracking
      ? F.surge * (0.75 + 0.35 * hunger) * this.gene.speed
      : F.cruise * (0.75 + 0.5 * hunger) * this.gene.speed;
    this.speed += (target - this.speed) * clamp(dt * 6, 0, 1);

    /* ---------- 状态标签 ---------- */
    if (this.alSat > 0.25 && s.al > 0.2) this.state = 'alarm';
    else if (tracking) this.state = 'seek';
    else if (wm < 0.08 && this.age > 1) this.state = 'cast';
    else this.state = 'cruise';

    /* ---------- 移动 + 转向抖动（飞行姿态） ---------- */
    const jr = 0.06;
    this.x += Math.cos(this.dir) * this.speed * dt + randn() * jr;
    this.y += Math.sin(this.dir) * this.speed * dt + randn() * jr;
    this.x = clamp(this.x, 2, W.w - 2); this.y = clamp(this.y, 2, W.h - 2);

    /* ---------- 翅膀扇动：速度越快频率越高 ---------- */
    this.wingPhase += dt * (16 + this.speed * 0.07);

    /* ---------- 代谢（FB 扇形体：能量稳态） ---------- */
    let cost = F.drainBase + F.drainMove * (this.speed / F.surge) * 2;
    if (desperate) cost *= 0.7;              // 濒死节能：降低活动强度
    this.energy -= cost * dt;

    /* ---------- 进食 ---------- */
    let eating = false;
    for (const f of W.foods) {
      if (Math.hypot(f.x - this.x, f.y - this.y) < CFG.food.r + CFG.food.feedRange) {
        eating = true;
        this.state = 'feed';
        this.energy = Math.min(F.eMax, this.energy + CFG.food.feedRate * dt);
        this.speed *= 0.82;
        // 在食物上小幅逗留/转圈（真实果蝇取食时步态食探）
        this.dir += Math.sin(this.age * 6) * 1.2 * dt;
        break;
      }
    }
    this.eating = eating;

    /* ---------- 繁殖：能量 + 摄食积累 + 冷却 三重门槛 ---------- */
    if (eating) this.feedAcc = Math.min(F.feedNeed, (this.feedAcc || 0) + dt);
    if (this.energy > F.reproEnergy && this.cool <= 0 && this.age > 5 &&
      (this.feedAcc || 0) >= F.feedNeed && W.flies.length < CFG.pop.max &&
      Math.random() < F.reproChance * dt) {
      this.feedAcc = 0;
      this.layEgg();
    }

    /* ---------- 记忆衰减（遗忘曲线） ---------- */
    for (const m of this.mem) m.s -= dt / (F.forgetTau * this.gene.learn) + 0.004 * dt;
    this.mem = this.mem.filter(m => m.s > 0.03);
    if (this.mem.length > F.memMax) this.mem.shift();

    /* ---------- 粘板：捕获判定 + 惩罚学习 ---------- */
    for (const t of W.traps) {
      const inside = this.x > t.x && this.x < t.x + CFG.trap.w && this.y > t.y && this.y < t.y + CFG.trap.h;
      if (inside) { this.getStuck(t); break; }
      // 靠近但未粘上 → PPL1 多巴胺惩罚信号写入 MB 记忆
      const cx = t.x + CFG.trap.w / 2, cy = t.y + CFG.trap.h / 2;
      const d = Math.hypot(this.x - cx, this.y - cy);
      if (d < CFG.trap.learnR) {
        const before = this.trapAvoid;
        this.trapAvoid = Math.min(1, this.trapAvoid + F.learnRate * this.gene.learn * dt * (1 - d / CFG.trap.learnR));
        if (before < 0.25 && this.trapAvoid >= 0.25) this.remember(cx, cy, 0.9);
        else if (Math.random() < dt * 0.5) this.remember(cx, cy, 0.6 + 0.4 * this.trapAvoid);
      }
    }

    /* ---------- 死亡判定 ---------- */
    if (this.energy <= 0) { this.energy = 0; this.die('energy'); return; }
    if (this.age > F.lifespan) { this.die('age'); return; }
  }

  nearSourceVec(kind) {                     // 近距直接趋源的单位向量
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

  repelVec() {                              // 报警信息素 + 记忆 + 粘板绕行的合力
    let vx = 0, vy = 0;
    if (fAlarm.at(this.x, this.y) > CFG.env.senseThresh) {
      const [gx, gy] = fAlarm.grad(this.x, this.y);
      const n = Math.hypot(gx, gy);
      // 饥饿会压制对危险的回避（越饿越冒险）——真实果蝇饥饿时风险承受度上升
      const hunger = clamp(1 - this.energy / CFG.fly.hungryAt, 0, 1);
      const w = this.alSat * 1.25 * (1 - 0.45 * hunger);
      if (n > 1e-6) { vx -= gx / n * w; vy -= gy / n * w; }
    }
    for (const m of this.mem) {
      const dx = this.x - m.x, dy = this.y - m.y, d = Math.hypot(dx, dy) || 1;
      if (d < CFG.trap.nearR) { const w = (1 - d / CFG.trap.nearR) * m.s * 1.8; vx += dx / d * w; vy += dy / d * w; }
    }
    if (this.trapAvoid > 0.15) {
      for (const t of W.traps) {
        const cx = t.x + CFG.trap.w / 2, cy = t.y + CFG.trap.h / 2;
        const dx = this.x - cx, dy = this.y - cy, d = Math.hypot(dx, dy) || 1;
        if (d < CFG.trap.nearR) { const w = (1 - d / CFG.trap.nearR) * this.trapAvoid * 2.4; vx += dx / d * w; vy += dy / d * w; }
      }
    }
    return { x: vx, y: vy };
  }

  remember(x, y, s) {
    this.mem.push({ x, y, s });
    if (this.mem.length > CFG.fly.memMax) this.mem.shift();
  }

  getStuck(t) {
    this.state = 'trapped';
    this.trap = t;
    this.stuckT = 0;
    this.speed = 0;
    this.trapAvoid = 1;                    // 这一次经历直接写满惩罚记忆
    this.remember(t.x + CFG.trap.w / 2, t.y + CFG.trap.h / 2, 1.0);
    sparks(this.x, this.y, [255, 138, 120], 8);
  }

  updateTrapped(dt) {
    const P = CFG.pher;
    this.stuckT += dt;
    this.speed = 0;
    this.wingPhase += dt * 62;              // 疯狂振翅
    this.energy -= P.drain * dt;
    this.pherT += dt;
    if (this.pherT >= P.interval && this.energy > 0 && this.stuckT < P.emitDur) {
      this.pherT = 0;
      fAlarm.deposit(this.x, this.y, P.emit * P.interval, P.emitR);
      this.pulse = 1;
    }
    // 挣脱（低概率）：脱身后成为"有记忆的老蝇"，会强烈回避所有粘板
    if (Math.random() < 1 - Math.exp(-P.escape * dt)) {
      this.state = 'cruise';
      this.trap = null;
      this.trapAvoid = 1;
      this.energy = Math.max(this.energy, 12);
      sparks(this.x, this.y, [180, 255, 220], 10);
    }
    if (this.energy <= 0) { this.energy = 0; this.die('stuck'); }
    if (this.age > CFG.fly.lifespan) this.die('age');
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
    W.deaths++;
    this.state = 'dead';
    for (const t of W.traps) {              // 死在粘板上的会留下尸体
      if (this.x > t.x && this.x < t.x + CFG.trap.w && this.y > t.y && this.y < t.y + CFG.trap.h) {
        t.bodies = t.bodies || [];
        t.bodies.push({ x: this.x, y: this.y, dir: this.dir });
        this.onTrap = t;
        break;
      }
    }
  }
}

/* 子代基因突变（可遗传的行为倾向） */
function mutate(g) {
  const m = CFG.fly.mutate;
  const n = {};
  for (const k in g) n[k] = clamp(g[k] * (1 + randn() * m), 0.5, 1.6);
  return n;
}

/* ----------------------------- 粒子（视觉反馈） ----------------------------- */
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
        // 清掉粘板 → 上面粘住的果蝇一起被清走
        for (const f of W.flies) if (f.trap === t) { f.dead = true; f.onTrap = null; f.deadT = 99; }
        W.traps.splice(i, 1); return true;
      }
    }
    for (let i = W.flies.length - 1; i >= 0; i--) if (!W.flies[i].dead && Math.hypot(W.flies[i].x - x, W.flies[i].y - y) < 22) { W.flies[i].die('removed'); W.flies[i].onTrap = null; return true; }
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

/* ----------------------------- 初始化 / 重置 ----------------------------- */
function resetWorld(keepParams = true) {
  W.foods = []; W.traps = []; W.eggs = []; W.corpses = []; W.flies = [];
  particles.length = 0;
  W.time = 0; W.deaths = 0; W.births = 0;
  if (!keepParams) { /* 预留 */ }
  buildFields();
  const n = Math.round(CFG.pop.start);
  for (let i = 0; i < n; i++) spawnFly(rand(40, W.w - 40), rand(40, W.h - 40));
  // 初始给两块食物，保证开局有戏
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
  dt = Math.min(dt, 1 / 30);               // 卡顿保护：步长上限
  if (!W.paused) simulate(dt);
  render(dt < 0.5 ? dt : 0.016);
  uiTick();
}

function simulate(dt) {
  W.time += dt;
  /* --- 气味场：沉积 → 扩散/挥发 --- */
  for (const f of W.foods) fFood.deposit(f.x, f.y, CFG.food.emit * dt, CFG.food.r * 1.3);
  for (const t of W.traps) fFerm.deposit(t.x + CFG.trap.w / 2, t.y + CFG.trap.h / 2, CFG.trap.emit * dt, Math.max(CFG.trap.w, CFG.trap.h) * 0.8);
  for (const f of W.flies) if (f.state === 'trapped' && !f.dead) fAlarm.deposit(f.x, f.y, CFG.pher.emit * dt * 0.5, CFG.pher.emitR);
  fFood.step(dt); fFerm.step(dt); fAlarm.step(dt);

  /* --- 果蝇 --- */
  for (const f of W.flies) f.update(dt);
  for (let i = W.flies.length - 1; i >= 0; i--) {
    const f = W.flies[i];
    if (f.dead && f.deadT > 2.2 && !f.onTrap) {
      W.corpses.push({ x: f.x, y: f.y, dir: f.dir, t: 0 });
      if (W.corpses.length > 60) W.corpses.shift();
      W.flies.splice(i, 1);
    }
  }
  /* --- 尸体淡出 --- */
  for (let i = W.corpses.length - 1; i >= 0; i--) {
    W.corpses[i].t += dt;
    if (W.corpses[i].t > 22) W.corpses.splice(i, 1);
  }
  /* --- 卵孵化 --- */
  for (let i = W.eggs.length - 1; i >= 0; i--) {
    const e = W.eggs[i];
    e.t += dt;
    if (e.t >= e.ttl) {
      const f = spawnFly(e.x, e.y, e.gene);
      if (f) sparks(e.x, e.y, [255, 255, 200], 6);
      W.eggs.splice(i, 1);
    }
  }
  updateParticles(dt);
}

/* ----------------------------- 渲染 ----------------------------- */
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W.w = window.innerWidth; W.h = window.innerHeight;
  cv.width = Math.floor(W.w * dpr); cv.height = Math.floor(W.h * dpr);
  cv.style.width = W.w + 'px'; cv.style.height = W.h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  buildFields();
}
window.addEventListener('resize', resize);

function render(dt) {
  const w = W.w, h = W.h;
  ctx.setTransform(Math.min(window.devicePixelRatio || 1, 2), 0, 0, Math.min(window.devicePixelRatio || 1, 2), 0, 0);
  // 背景
  const g = ctx.createRadialGradient(w * 0.5, h * 0.45, 40, w * 0.5, h * 0.45, Math.max(w, h) * 0.75);
  g.addColorStop(0, '#101a22'); g.addColorStop(1, '#070b0f');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  // 淡网格（培养皿/实验箱质感）
  ctx.save();
  ctx.strokeStyle = '#16222c'; ctx.lineWidth = 1;
  const gs = 64;
  ctx.beginPath();
  for (let x = 0; x < w; x += gs) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = 0; y < h; y += gs) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke(); ctx.restore();

  // 气味场可视化
  if (W.showField) { fFood.render(ctx); fFerm.render(ctx); fAlarm.render(ctx); }

  // 食物
  for (const f of W.foods) drawFood(ctx, f);
  // 粘板
  for (const t of W.traps) drawTrap(ctx, t);
  // 卵
  for (const e of W.eggs) drawEgg(ctx, e);
  // 尸体
  for (const c of W.corpses) drawCorpse(ctx, c);
  // 果蝇（死的先画）
  for (const f of W.flies) if (f.dead) drawFly(ctx, f);
  for (const f of W.flies) if (!f.dead) drawFly(ctx, f);
  // 粒子
  for (const p of particles) {
    const a = 1 - p.t / p.life;
    ctx.fillStyle = `rgba(${p.c[0]},${p.c[1]},${p.c[2]},${a * 0.8})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.8 * a + 0.4, 0, TAU); ctx.fill();
  }
  // 暂停遮罩
  if (W.paused) {
    ctx.fillStyle = 'rgba(4,8,12,0.45)'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#cfe6ff'; ctx.font = '600 22px -apple-system,sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('⏸ 已暂停', w / 2, h / 2);
    ctx.font = '12px -apple-system,sans-serif'; ctx.fillStyle = '#8fa5b8';
    ctx.fillText('按空格 / 点「暂停」继续', w / 2, h / 2 + 24);
    ctx.textAlign = 'left';
  }
}

function drawFood(ctx, f) {
  const r = CFG.food.r;
  const g = ctx.createRadialGradient(f.x - r * 0.3, f.y - r * 0.3, 1, f.x, f.y, r);
  g.addColorStop(0, '#ffd9a0'); g.addColorStop(0.55, '#e39b4e'); g.addColorStop(1, '#8a4b18');
  ctx.save();
  ctx.shadowColor = 'rgba(255,170,80,0.5)'; ctx.shadowBlur = 16;
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, TAU); ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(90,50,20,0.5)';
  for (let i = 0; i < 5; i++) {
    const a = f.ph + i * 1.35, d = r * (0.35 + 0.28 * ((i * 7) % 3) / 2);
    ctx.beginPath(); ctx.arc(f.x + Math.cos(a) * d, f.y + Math.sin(a) * d, 1.5, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,190,110,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(f.x, f.y, r + 4 + Math.sin(W.time * 2 + f.ph) * 1.6, 0, TAU); ctx.stroke();
}

function drawTrap(ctx, t) {
  const { w, h } = CFG.trap;
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.fillStyle = 'rgba(196,152,42,0.30)';
  ctx.strokeStyle = 'rgba(255,214,102,0.85)'; ctx.lineWidth = 1.6;
  roundRect(ctx, 0, 0, w, h, 6); ctx.fill(); ctx.stroke();
  // 斜纹（诱饵胶的质感）
  ctx.save(); roundRect(ctx, 0, 0, w, h, 6); ctx.clip();
  ctx.strokeStyle = 'rgba(255,225,140,0.22)'; ctx.lineWidth = 5;
  for (let i = -h; i < w; i += 11) { ctx.beginPath(); ctx.moveTo(i, h); ctx.lineTo(i + h, 0); ctx.stroke(); }
  // 表面高光
  const gg = ctx.createLinearGradient(0, 0, 0, h);
  gg.addColorStop(0, 'rgba(255,255,255,0.16)'); gg.addColorStop(0.5, 'rgba(255,255,255,0)');
  ctx.fillStyle = gg; ctx.fillRect(0, 0, w, h);
  ctx.restore();
  // 表面诱饵颗粒
  ctx.fillStyle = 'rgba(255,236,170,0.5)';
  for (let i = 0; i < 6; i++) {
    const a = t.ph + i * 2.3;
    ctx.beginPath(); ctx.arc(w / 2 + Math.cos(a) * w * 0.3, h / 2 + Math.sin(a * 1.7) * h * 0.26, 1.2, 0, TAU); ctx.fill();
  }
  // 黏在板上的果蝇尸体
  if (t.bodies) {
    for (const b of t.bodies) {
      ctx.save(); ctx.translate(b.x - t.x, b.y - t.y); ctx.rotate(b.dir);
      ctx.fillStyle = 'rgba(60,40,30,0.95)';
      ctx.beginPath(); ctx.ellipse(0, 0, 5, 2.4, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(120,80,50,0.8)';
      ctx.beginPath(); ctx.arc(4.5, 0, 1.6, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawEgg(ctx, e) {
  const t = e.t / e.ttl;
  const pulse = 1 + Math.sin(W.time * 4 + e.ph) * 0.12;
  ctx.save();
  ctx.translate(e.x, e.y); ctx.scale(pulse, pulse);
  ctx.fillStyle = 'rgba(255,255,235,0.94)';
  ctx.beginPath(); ctx.ellipse(0, 0, 3.4, 1.8, 0.5, 0, TAU); ctx.fill();
  // 幼虫轮廓（临近孵化）
  ctx.globalAlpha = Math.max(0, (t - 0.6) / 0.4) * 0.85;
  ctx.strokeStyle = '#d8c8a0'; ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (let i = 0; i <= 12; i++) {
    const a = i / 12 * TAU;
    const rr = 2.6 + Math.sin(a * 3 + W.time * 6) * 0.5;
    const px = Math.cos(a) * rr, py = Math.sin(a) * rr * 0.55;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

function drawCorpse(ctx, c) {
  const a = clamp(1 - (c.t - 14) / 8, 0, 1) * 0.55;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(c.x, c.y); ctx.rotate(c.dir);
  ctx.strokeStyle = '#6a5a4a'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.ellipse(0, 0, 4.5, 1.6, 0, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-5, -3); ctx.lineTo(-2, 0); ctx.moveTo(-5, 3); ctx.lineTo(-2, 0); ctx.stroke();
  ctx.restore();
}

function drawFly(ctx, f) {
  const F = CFG.fly;
  const s = F.size * (f.gene.size || 1);
  const energyR = clamp(f.energy / F.eMax, 0, 1);
  const hunger = clamp(1 - f.energy / F.hungryAt, 0, 1);
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(f.dir);
  if (f.state === 'trapped') {                 // 被粘住：抖动 + 侧倾
    ctx.rotate(Math.sin(f.jitter * 3) * 0.25);
    ctx.translate(Math.sin(f.jitter * 7) * 0.8, Math.cos(f.jitter * 5) * 0.8);
  }
  // 翅膀（半透明，扇动相位）
  const flap = Math.sin(f.wingPhase);
  const wingLen = 6.2 * s, wingW = 2.6 * s;
  ctx.save();
  ctx.globalAlpha = f.state === 'trapped' ? 0.5 : 0.62;
  for (const side of [-1, 1]) {
    // 被粘住时画多重残影表示高频振翅
    const ghosts = f.state === 'trapped' ? 3 : 1;
    for (let gi = 0; gi < ghosts; gi++) {
      const ph = flap + gi * 0.5;
      ctx.save();
      ctx.translate(-0.6 * s, side * 1.1 * s);
      ctx.rotate(side * (0.5 + 0.75 * ph) + gi * 0.12 * side);
      ctx.fillStyle = `rgba(206,228,244,${gi ? 0.16 : 0.5})`;
      ctx.beginPath(); ctx.ellipse(wingLen * 0.45, 0, wingLen * 0.55, wingW * 0.5, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
  // 身体
  const bodyG = ctx.createLinearGradient(-5 * s, 0, 5 * s, 0);
  if (f.state === 'trapped') { bodyG.addColorStop(0, '#4a3324'); bodyG.addColorStop(1, '#c98b3a'); }
  else if (hunger > 0.55) { bodyG.addColorStop(0, '#3a2c26'); bodyG.addColorStop(1, '#7a4a3a'); }
  else { bodyG.addColorStop(0, '#2a2f38'); bodyG.addColorStop(1, '#4a5260'); }
  ctx.fillStyle = bodyG;
  ctx.beginPath(); ctx.ellipse(-0.4 * s, 0, 4.6 * s, 2.5 * s, 0, 0, TAU); ctx.fill();
  // 腹部横纹
  ctx.strokeStyle = 'rgba(15,18,22,0.55)'; ctx.lineWidth = 0.7;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo((-3.2 + i * 1.5) * s, -1.9 * s);
    ctx.lineTo((-3.2 + i * 1.5) * s, 1.9 * s);
    ctx.stroke();
  }
  // 头 + 复眼
  ctx.fillStyle = '#3b4350';
  ctx.beginPath(); ctx.arc(4.0 * s, 0, 1.9 * s, 0, TAU); ctx.fill();
  ctx.fillStyle = f.state === 'trapped' ? '#c0392b' : '#a03040';
  ctx.beginPath(); ctx.arc(4.6 * s, -1.0 * s, 1.05 * s, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(4.6 * s, 1.0 * s, 1.05 * s, 0, TAU); ctx.fill();
  // 足（被粘住时张开挣扎）
  ctx.strokeStyle = 'rgba(20,24,30,0.75)'; ctx.lineWidth = 0.7;
  for (let i = 0; i < 3; i++) {
    const bx = (-3 + i * 2.4) * s;
    for (const side of [-1, 1]) {
      const wig = f.state === 'trapped' ? Math.sin(f.jitter * 9 + i) * 1.2 : 0;
      ctx.beginPath();
      ctx.moveTo(bx, side * 2 * s);
      ctx.lineTo(bx + wig - 0.8 * side, side * (4.4 * s + wig));
      ctx.stroke();
    }
  }
  ctx.restore();

  // 能量条（细）
  const bx = f.x - 7, by = f.y - 10;
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(bx, by, 14, 2.2);
  ctx.fillStyle = energyR > 0.6 ? '#5fe0a8' : energyR > 0.3 ? '#ffd479' : '#ff6f8a';
  ctx.fillRect(bx, by, 14 * energyR, 2.2);

  // 被粘住：警示环 + 信息素脉冲
  if (f.state === 'trapped') {
    const rr = 7 + Math.sin(W.time * 8 + f.id) * 1.5;
    ctx.strokeStyle = `rgba(255,90,120,${0.5 + 0.3 * Math.sin(W.time * 9 + f.id)})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, TAU); ctx.stroke();
    if (f.pulse > 0) {
      ctx.strokeStyle = `rgba(255,80,120,${f.pulse * 0.55})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(f.x, f.y, 8 + (1 - f.pulse) * CFG.pher.emitR, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(f.x, f.y, 4 + (1 - f.pulse) * CFG.pher.emitR * 0.6, 0, TAU); ctx.stroke();
    }
  } else if (f.trapAvoid > 0.35) {           // 学过教训的老蝇：脑内记忆标记
    ctx.strokeStyle = 'rgba(140,180,255,0.28)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(f.x, f.y, 8.5, -0.5, 0.9); ctx.stroke();
  }
  // 记忆点
  if (W.showField) {
    for (const m of f.mem) {
      ctx.fillStyle = `rgba(140,180,255,${m.s * 0.35})`;
      ctx.beginPath(); ctx.arc(m.x, m.y, 2 + m.s * 2, 0, TAU); ctx.fill();
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ----------------------------- UI：统计面板 ----------------------------- */
const statsEl = document.getElementById('stats');
let statsAcc = 0;
function uiTick(dt) {
  statsAcc += dt || 0.016;
  if (statsAcc < 0.2) return;
  statsAcc = 0;
  const alive = W.flies.filter(f => !f.dead);
  const stuck = alive.filter(f => f.state === 'trapped').length;
  const hungry = alive.filter(f => f.energy < CFG.fly.hungryAt).length;
  const learned = alive.filter(f => f.trapAvoid > 0.5).length;
  const avgE = alive.length ? alive.reduce((a, f) => a + f.energy, 0) / alive.length : 0;
  statsEl.innerHTML =
    `<div><span class="k">果蝇</span> <b class="ok">${alive.length}</b>` +
    ` <span class="k">/ 上限 ${CFG.pop.max}</span></div>` +
    `<div><span class="k">被粘住</span> <b class="bad">${stuck}</b>` +
    ` <span class="k">｜饥饿</span> <b class="hi">${hungry}</b>` +
    ` <span class="k">｜已避险</span> <b>${learned}</b></div>` +
    `<div><span class="k">食物</span> <b>${W.foods.length}</b>` +
    ` <span class="k">｜粘板</span> <b>${W.traps.length}</b>` +
    ` <span class="k">｜卵</span> <b>${W.eggs.length}</b></div>` +
    `<div><span class="k">累计出生</span> <b>${W.births}</b>` +
    ` <span class="k">｜死亡</span> <b class="bad">${W.deaths}</b></div>` +
    `<div><span class="k">平均能量</span> <b>${avgE.toFixed(0)}</b>` +
    ` <span class="k">｜时间</span> <b>${W.time.toFixed(0)}s</b>` +
    ` <span class="k">｜FPS</span> <b>${fps.toFixed(0)}</b></div>`;
}

/* ----------------------------- UI：参数面板 ----------------------------- */
const PARAM_SPEC = [
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
  ['fly.odorGain', '食物气味吸引强度', 0, 4, 0.05],
  ['fly.fermGain', '发酵气味吸引强度(粘板诱惑)', 0, 4, 0.05],
  ['fly.alarmGain', '报警信息素回避强度', 0, 6, 0.05],
  ['pher.emit', '信息素释放强度', 0, 8, 0.1],
  ['env.alarmTau', '信息素残留时间 (s)', 1, 30, 0.5],
  ['env.visionRange', '近距趋源范围 (px)', 0, 220, 5],
  ['g', '学习 / 记忆'],
  ['fly.learnRate', '避害学习速率 (PPL1→MB)', 0, 2, 0.05],
  ['fly.forgetTau', '记忆遗忘时间 (s)', 2, 120, 1],
  ['fly.memMax', '空间记忆点上限', 0, 10, 1],
  ['g', '繁殖 / 种群'],
  ['fly.reproChance', '繁殖率 (每秒概率系数)', 0, 1, 0.01],
  ['fly.reproEnergy', '繁殖所需能量', 50, 145, 1],
  ['fly.reproCost', '繁殖消耗能量', 5, 100, 1],
  ['fly.reproCool', '繁殖冷却 (s)', 0.5, 40, 0.5],
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
function buildSliders() {
  slidersEl.innerHTML = '';
  for (const spec of PARAM_SPEC) {
    if (spec[0] === 'g') {
      const h = document.createElement('h3');
      h.textContent = spec[1];
      h.style.marginTop = '12px';
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
      if (path === 'env.visionRange') { /* 即时生效 */ }
      if (path.startsWith('env.') || path === 'trap.learnR') { /* 场参数即时生效 */ }
    });
    slidersEl.appendChild(row);
  }
}
const fmt = v => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));

/* ----------------------------- UI：按钮 ----------------------------- */
const modeBtns = [...document.querySelectorAll('[data-mode]')];
function setMode(m) {
  W.mode = m;
  for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === m);
  hint(m === 'food' ? '点击/拖动放置食物（果蝇会被气味吸引）'
    : m === 'trap' ? '放置粘板：发酵气味会吸引果蝇，但靠近会被粘住'
      : m === 'fly' ? '点击投放果蝇'
        : '点击/拖动清除食物、粘板或果蝇');
}
for (const b of modeBtns) b.addEventListener('click', () => setMode(b.dataset.mode));

const btnPause = document.getElementById('btnPause');
btnPause.addEventListener('click', () => {
  W.paused = !W.paused;
  btnPause.textContent = W.paused ? '▶ 继续' : '⏸ 暂停';
  btnPause.classList.toggle('on', W.paused);
});
const btnField = document.getElementById('btnField');
btnField.addEventListener('click', () => {
  W.showField = !W.showField;
  btnField.classList.toggle('on', W.showField);
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
  else if (k === 'r') resetWorld();
  else if (e.code === 'Space') { e.preventDefault(); btnPause.click(); }
});

/* ----------------------------- 交互：指针绘制 ----------------------------- */
let down = false, lastP = { x: 0, y: 0 };
function pos(e) {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  down = true;
  const p = pos(e);
  lastP = p;
  const ok = place(p.x, p.y);
  if (ok && W.mode === 'food') sparks(p.x, p.y, [255, 200, 120], 6);
  hideHint();
});
cv.addEventListener('pointermove', e => {
  const p = pos(e);
  if (down) {
    if (Math.hypot(p.x - lastP.x, p.y - lastP.y) > 22) { place(p.x, p.y); lastP = p; }
  } else {
    showTipAt(p.x, p.y, e.clientX, e.clientY);
  }
});
window.addEventListener('pointerup', () => { down = false; });
cv.addEventListener('pointerleave', () => { down = false; hideTip(); });

/* 悬停某只果蝇 → 显示它的"内部状态" */
const tipEl = document.getElementById('tip');
function nearestFly(x, y) {
  let best = null, bd = 22;
  for (const f of W.flies) {
    if (f.dead) continue;
    const d = Math.hypot(f.x - x, f.y - y);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
const MODE_CN = { cruise: '巡航', seek: '追踪气味', feed: '进食', cast: 'zig-zag 搜索', alarm: '惊逃', trapped: '被粘住' };
function showTipAt(x, y, cx, cy) {
  const f = nearestFly(x, y);
  if (!f) { hideTip(); return; }
  const hunger = clamp(1 - f.energy / CFG.fly.hungryAt, 0, 1);
  const notes = [];
  if (f.energy < CFG.fly.desperateAt) notes.push('SEZ 极饿：降低风险规避');
  else if (hunger > 0.4) notes.push('SEZ(Hugin) 饥饿驱动↑');
  if (f.fermSat > 0.3) notes.push('AL/LH 闻到发酵气味');
  if (f.odSat > 0.3) notes.push('AL/LH 闻到食物气味');
  if (f.trapAvoid > 0.5) notes.push('MB 记忆：回避粘板');
  else if (f.trapAvoid > 0.1) notes.push('PPL1 惩罚信号写入中');
  if (f.alSat > 0.3) notes.push('报警信息素 → 回避');
  tipEl.innerHTML =
    `<b>果蝇 #${f.id}</b> · ${MODE_CN[f.state] || f.state}<br>` +
    `能量 ${f.energy.toFixed(0)}/${CFG.fly.eMax} · 饥饿度 ${(hunger * 100).toFixed(0)}%<br>` +
    `年龄 ${f.age.toFixed(1)}s · 避险记忆 ${(f.trapAvoid * 100).toFixed(0)}%<br>` +
    `基因 速度${f.gene.speed.toFixed(2)} 嗅觉${f.gene.odor.toFixed(2)} 学习${f.gene.learn.toFixed(2)}<br>` +
    (notes.length ? `<span style="color:#ffd479">${notes.join('；')}</span>` : '');
  tipEl.style.display = 'block';
  const w = 210;
  tipEl.style.left = clamp(cx + 14, 6, window.innerWidth - w - 8) + 'px';
  tipEl.style.top = clamp(cy + 14, 46, window.innerHeight - 110) + 'px';
}
function hideTip() { tipEl.style.display = 'none'; }

let hintHidden = false;
function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  document.getElementById('hint').style.opacity = 0;
}
setTimeout(hideHint, 9000);

/* ----------------------------- 启动 ----------------------------- */
resize();
buildSliders();
resetWorld();
setMode('food');
requestAnimationFrame(frame);
