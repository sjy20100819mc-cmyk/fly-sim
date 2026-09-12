#!/bin/sh
# 把分块源码组装成单文件 3D 版（three.js 内联）
# 用法：sh build.sh            → 生成 /var/minis/workspace/fly-sim-3d.html
cd /var/minis/workspace/fly-sim || exit 1
python3 - <<'PYEOF'
src = open('brain.js').read()
MR = '/* ----------------------------- 渲染 ----------------------------- */'
MB = '/* ----------------------------- 脑活动视图 -----------------------------'
MI = '/* ----------------------------- 交互 ----------------------------- */'
MS = '/* ----------------------------- 启动 ----------------------------- */'
js = (src[:src.index(MR)]
      + open('render3d.js').read() + '\n'
      + src[src.index(MB):src.index(MI)]
      + open('interact3d.js').read() + '\n'
      + src[src.index(MS):])

reps = [
("  paused: false, showField: false, showBrain: false, mode: 'food'\n};",
 "  paused: false, showField: false, showBrain: false, mode: 'food',\n  follow: null, inspect: null, userZoom: false\n};"),
("resize();\nbuildSliders();", "buildFields();\ninitGL();\nbuildSliders();"),
("""  btnPause.textContent = W.paused ? '▶ 继续' : '⏸ 暂停';
  btnPause.classList.toggle('on', W.paused);""",
 """  btnPause.textContent = W.paused ? '▶ 继续' : '⏸ 暂停';
  btnPause.classList.toggle('on', W.paused);
  const po = document.getElementById('paused');
  if (po) po.style.display = W.paused ? 'flex' : 'none';"""),
("const btnParam = document.getElementById('btnParam');",
 """const btnView = document.getElementById('btnView');
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
const btnParam = document.getElementById('btnParam');"""),
("      if (Math.hypot(o.x - this.x, o.y - this.y) < 6) { mech += 1.0; break; }",
 "      if (Math.hypot(o.x - this.x, o.y - this.y) < 9) { mech += 1.0; break; }"),
]
for a, b in reps:
    assert a in js, '模式未匹配: ' + a[:40]
    js = js.replace(a, b, 1)
open('fly3d.js', 'w').write(js)

head = open('head3d.html').read().replace('</body>\n</html>\n', '')
three = open('/tmp/three-147.min.js').read()
out = (head + '\n<script>/* three.js r147 MIT (c) three.js authors */\n' + three
       + '\n</script>\n<script>\n' + js + '\n</script>\n</body>\n</html>\n')
open('/var/minis/workspace/fly-sim-3d.html', 'w').write(out)
print('组装完成: fly-sim-3d.html  %.0f KB' % (len(out.encode()) / 1024))
PYEOF
node --check fly3d.js && echo "语法检查通过"
