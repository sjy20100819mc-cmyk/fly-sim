# 果蝇自主行为模拟器 · FlyWire FAFB v783 连接组约简脉冲脑

单文件网页游戏：`/var/minis/workspace/fly-sim.html`（双击/直接打开即可，无后端、无外部依赖）

---

## 一、行为内核用的是哪个模型（2026-09 最新基线）

| 来源 | 用到的部分 |
|---|---|
| **FlyWire FAFB v783 (Codex)** — 成虫全脑连接组，139,255 神经元 / 2.7–3.7M 边<br>Dorkenwald, Matsliah, Sterling et al., *Nature* 634:124–138 (2024) | 细胞类型命名与接线逻辑；**≥5 突触才建边**的惯例 |
| **brandoncho369/flybench (2026)** — 全脑仿真的反射基准套件（11 项 cited tasks） | 参考 LIF 参数 `w_syn=0.275`、全局 `gain≈0.42`（0.40–0.45 为反射通过区）；反射判据（静默→静默、糖→MN9、苦/警戒抑制糖、突现→巨纤维） |
| **philshiu/Drosophila_brain_model** — 首个全脑 LIF 模型（Brian2）<br>Shiu et al., *Nature* (2024) | LIF 神经元模型与"刺激感觉神经元→读运动神经元"的实验范式 |
| **Neuromorphicism/fly-brain-snntorch** | 稀疏脉冲实现与多感官刺激通道（嗅觉/味觉/视觉/机械） |
| **snedea/flybrain** — 浏览器端 139K LIF 实时仿真 | 神经元按 **Sensory / Central / Drives / Motor** 分组、以放电率读出行为的范式 |
| **NeLy-EPFL/flygym（NeuroMechFly v2）** | 具身观：下行神经元(DN)下达指令 + 腹神经索(VNC)局部反射环 |

> 手机浏览器跑不动 13.9 万神经元 × 每只果蝇，因此做**连接组约简**：
> 保留行为关键回路的细胞类型、递质符号和接线，每只果蝇一副 **71 神经元的 LIF 脉冲网**
> （cuLIF，τm=20 ms，τsyn=5 ms，2 ms 不应期，含放电频率适应）。
> 权重公式：`w = w_syn · gain · K · (每对突触数)`，K=5，`gain` 可在参数面板实时调。

## 二、回路 → 行为 映射

| 行为 | 通路 |
|---|---|
| 饥饿驱动觅食 | Hugin(SEZ) → LHON↑ / MN_walk↑ / 抑制 MBON_av（饿则冒险） |
| 气味吸引 | ORN_food → PN → LHON → DN_walk；PN → KC → MBON_app |
| 发酵气味（粘板诱饵） | ORN_ferm → PN → …；靠近粘板时 DAN_PPL1 发放（非条件刺激） |
| 惩罚性学习 | 气味(CS，KC 活动) × DAN_PPL1(PPL1 多巴胺，超过阈值才门控) → **KC→MBON_av 权重↑** → 之后闻到该气味即回避 |
| 奖赏性学习 | GRN_sugar → DAN_PAM → KC→MBON_app 权重↑ |
| 记忆消退 | 闻到气味但无惩罚 → KC→MBON_av 权重缓慢回落（extinction） |
| 信息素避害 | 被粘个体持续释放报警信息素 → 同伴 ORN_alarm → MBON_av / DN_escape → 回避+逃逸 |
| 逃逸反射 | 突现刺激 visual / 机械冲击 → DN_escape(DNa01/02，巨纤维) → MN_walk 爆发 |
| 取食 | GRN_sugar → MN_feed(MN9 喙伸展)；FB_energy(饱足) 抑制 |
| 转向 | ring_EB → PFN → MN_steerL/R；DN 转向偏置 |
| 产卵 | 能量 + 累计摄食(蛋白) → MN_oviposit 放电 > 阈值 |
| 稀疏编码 | KC→APL→KC 反馈抑制（蘑菇体前侧成对侧神经元） |

## 三、内建反射自检（对照 flybench 判据，实测全通过）

- 静默→静默：0.00 Hz（判据 <0.5 Hz）
- 糖 → MN9：21 Hz（判据 >5 Hz）
- 警戒抑制糖：8 Hz（判据 < 糖反应一半）
- 突现 → 巨纤维：29 Hz（判据 >10 Hz）
- 气味 → 行进：29 Hz

## 四、可调参数（网页「⚙︎ 参数」内实时可调；默认值在代码 `CFG` 对象里）

### 脑 / 网络
| 参数 | 含义 | 默认 |
|---|---|---|
| `brain.gain` | 全局增益（反射通过区 0.40–0.45） | 0.42 |
| `brain.wSyn` | 单突触权重基准 (mV) | 0.275 |
| `brain.K` | 权重换算常数 | 5 |
| `brain.lr` | 多巴胺学习率（PPL1→MB 权重增速） | 0.15 |
| `brain.daThresh` | 多巴胺门控阈值 (Hz) | 3.0 |
| `brain.wMax` | 可塑权重上限（倍数） | 3.2 |
| `brain.extinct` | 记忆消退系数 | 0.5 |
| `brain.dt` / `stepsPerFrame` | 脑步长 / 每帧步数 | 0.01 s / 2 |
| `brain.tauM` / `tauSyn` / `tauR` | 膜、突触、放电率估计时间常数 | 20 / 5 / 200 ms |
| `brain.adapt` / `tauAdapt` | 放电频率适应强度 / 时间常数 | 0.12 / 0.1 s |
| `brain.noise` | 自发噪声 | 0.028 |

### 运动与能量
| 参数 | 含义 | 默认 |
|---|---|---|
| `fly.cruise` / `fly.surge` | 巡航 / 气味冲刺速度 (px/s) | 58 / 132 |
| `fly.turnRate` | 转向速率 (rad/s) | 5.0 |
| `fly.noise` | 随机游走强度 (rad/s) | 2.4 |
| `fly.cast` | 气味丢失时 zig-zag 搜索幅度 | 5.2 |
| `fly.eMax` / `eStart` | 能量上限 / 出生能量 | 145 / 115 |
| `fly.drainBase` / `drainMove` | 基础代谢 / 运动代谢 | 0.95 / 0.60 |
| `fly.hungryAt` / `desperateAt` | 饥饿 / 极饿阈值 | 62 / 26 |
| `food.feedRate` | 进食回能 (能量/s) | 30 |

### 嗅觉 / 信息素 / 粘板
| 参数 | 含义 | 默认 |
|---|---|---|
| `fly.seekGain` | 食物气味吸引强度 | 1.7 |
| `fly.fermentGain` | 发酵气味（粘板诱惑）吸引强度 | 1.2 |
| `fly.alarmGain` | 报警信息素回避强度 | 1.15 |
| `env.alarmTau` / `alarmDiff` | 信息素残留时间(s) / 扩散 | 2.8 / 0.11 |
| `pher.emit` / `emitDur` / `emitR` | 释放强度 / 时长(s) / 半径 | 2.0 / 20 / 20 |
| `pher.drain` / `escape` | 被粘时能量流失 / 挣脱概率 | 2.2 / 0.03 |
| `trap.emit` | 粘板发酵气味强度 | 2.3 |
| `trap.capture` / `bounce` | 接触捕获概率 / 弹开受惊时长 | 0.8 / 0.35 |
| `trap.usR` | 惩罚信号（US）半径 (px) | 32 |
| `trap.avoidR` / `avoidGain` | 学会后的回避半径 / 强度 | 90 / 3.4 |

### 繁殖 / 种群
| 参数 | 含义 | 默认 |
|---|---|---|
| `fly.reproChance` | 繁殖率系数 | 0.16 |
| `fly.reproEnergy` / `reproCost` | 繁殖能量门槛 / 消耗 | 102 / 30 |
| `fly.feedNeed` | 产卵前需累计摄食(s) | 4 |
| `fly.reproCool` / `eggTime` | 繁殖冷却 / 卵孵化 | 24 / 13 s |
| `fly.lifespan` | 寿命 | 165 s |
| `pop.start` / `pop.max` | 初始数量 / 种群上限 | 16 / 90 |

### 行为读出阈值（运动神经元 → 行为）
`fly.feedThr` 6 Hz（MN9 取食）、`fly.escapeThr` 20 Hz（逃逸）、`fly.ovipThr` 8 Hz（产卵）、`fly.steerGain` 18

## 五、想改造/扩展

- **加一种神经元**：在 `CTYPE` 里加一行 `[名字, 分组, 符号, 数量, 说明]`（分组只能是 Sensory/Drives/Central/Motor，脑视图按此分列），再在 `CONNECTIONS` 里按 `[前, 后, 突触总数]` 接线；突触总数 /(前群数×后群数) 就是"每对突触数"，参考 FAFB 量级：强连接 5–20、弱连接 1–4。
- **改可塑性**：连接项第四个字段填 `'av'`（惩罚性，DAN_PPL1 门控）或 `'app'`（食欲性，DAN_PAM 门控）。
- **多巴胺是纯调质**：`DAN_PPL1/DAN_PAM` 的出边权重被设为 0，只门控可塑性（符合神经调质的事实）。
- **性能**：每帧仿真约 0.25–0.3 ms（90 只果蝇时）；果蝇数 >70 会自动把脑步数降为每帧 1 步。老设备可下调 `pop.max`。

## 六、玩法

- 🍎 食物：果蝇被气味吸引，落到食物上才会取食（MN9 放电 → 喙伸展）
- 🟨 粘板：发酵气味诱惑 > 接触后被粘住（挣扎→释放报警信息素→同伴回避）> 侥幸弹开者把"这里危险"写进蘑菇体，从此绕行
- 🪰 投蝇 / 🧽 清除 / 🧠 脑活动（看某只果蝇此刻神经元的放电与已学到的危险权重）/ 👃 气味场（三种气味云）/ ⏸ ⚙︎ ↺
- 悬停任意果蝇可看它的内部状态（饥饿度、活跃细胞类型、学习指数、读出放电率）
- 快捷键：1食物 2粘板 3投蝇 4清除 · B脑活动 · D气味场 · 空格暂停 · R重置

---

# 3D 版（three.js）· 可在 QQ 里打开

文件：`/var/minis/workspace/fly-sim-3d.html`（691 KB 单文件，three.js r147 已内联，**完全离线**）

## 怎么在 QQ 里跑

| 方式 | 做法 | 说明 |
|---|---|---|
| **A. 传文件** | 把这个 .html 发到 QQ 好友/群 → 对方点开 → 选「用浏览器打开」 | iOS 建议选 Safari；安卓 QQ 内置 X5 浏览器一般可直接跑 WebGL |
| **B. 发链接（体验最好）** | 传到任意静态托管（GitHub Pages / Gitee Pages / 自己的服务器）→ 把 https 链接发到 QQ | QQ 内置浏览器直接打开就能玩，无需额外操作 |
| **C. QQ 小程序** | 需 QQ 开发者工具 + appid，并把 three.js 换成小程序适配版（threejs-miniprogram） | 需要 PC 打包上传，本环境无法验证；需要的话我可以生成工程骨架 |

> 若内置浏览器禁用了 WebGL，页面会显示明确提示（不会白屏），换 Safari/Chrome 打开即可。

## 3D 版做了什么

- **世界 = 600×600 培养箱**（与 2D 版标定过的生态密度一致：面积 360k px² vs 2D 的 329k px²）
- **果蝇**：实例化网格拼装 —— 腹部/胸部/头/复眼/双翅（按 wingPhase 扇动）/六足/接触阴影，按真实比例（体长≈箱体 4%）
- **气味**：三种气味场烘成 DataTexture，贴在叠加混合的半透明平面上悬在箱内 → 真正 3D 的"气味云"；近距取景自动淡出以免挡视线
- **粘板/食物/卵/残骸/火花/信息素脉冲环**：全部 3D 实例化
- **相机**：单指拖动环绕、双指捏合缩放、轻点地面放置、轻点果蝇追踪（🎥 视角：自由 → 追踪 → 俯视）
- **📷 快照**：一键把当前画面导成图片，长按保存后可分享到 QQ
- 行为内核与 2D 版**完全同一套脉冲脑**（71 神经元/只，FAFB v783 细胞类型，flybench 口径参数）

## 踩过的坑（改 3D 时容易再犯）

1. `scene.fog` 的 near/far 必须随相机距离缩放，否则远距离取景整场景被雾吞掉 → 全黑。
2. three.js 的 Lambert 光照要除以 π，深色调色板 + 低强度光会黑到看不见；同时**必须给 CanvasTexture 标 `encoding = sRGBEncoding`**，否则颜色被当线性数据 → 过曝发白。
3. 移动端/内置浏览器切后台会清空 WebGL 缓冲 → 用 `preserveDrawingBuffer: true` + `visibilitychange` 补帧，否则回前台一片黑。
4. 果蝇视觉尺度要按真实比例（体长 ≈ 培养箱的 4%）才看得清；按物理单位 1:1 会小到 4px。
5. 三层气味云都用叠加混合时，重叠区域会把三个颜色相加后**饱和成白色** → 单层不透明度要压到 0.2 左右（总叠加仍会偏亮）。
6. 应用内 WebView 截图抓不到 WebGL 图层，验证 3D 画面请用页面内的「📷 快照」（把 canvas.toDataURL 画到 DOM `<img>` 上再截图）。

## 食物会耗尽（可调）

食物不再是永久场景物件：每块食物带一个"总能量"，被取食即消耗，没人吃也会缓慢变质，归零后消失并留下一块残迹（约 22 秒淡去）。

| 参数 | 含义 | 默认 |
|---|---|---|
| `food.energy` | 一块新鲜食物的总能量 | 12000 |
| `food.decay` | 自然变质损耗（能量/s） | 6 |
| `food.maxFeeders` | 同时"满速取食"的只数，人多了每只都变慢（拥挤效应） | 4 |
| `food.consume` | 消耗系数：果蝇获得 1 能量 = 食物减少多少 | 1.0 |
| `food.minR` | 吃剩最后一点时的视觉最小半径比例 | 0.42 |

实测节奏（16 只起）：**放着不管约 4 分钟吃光 → 之后种群逐渐饿死**；**每分钟左右补一块食物可长期维持种群在 60~90 只**。
食物缩小、颜色由鲜橙转干枯棕，气味强度与扩散范围也随剩余量同步减弱。食物吃光时页面会提示补食。
