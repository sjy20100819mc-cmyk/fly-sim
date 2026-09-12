/* flybench 协议复现脚本 —— 粘到浏览器控制台即可跑，对本模型逐项对照 */
(function () {
  const PB = new Brain({ speed:1, sense:1, brainGain:1, learn:1, size:1, noise:1 });
  const setIn = (nm,v) => { const c = NET.ct[nm]; for (let i=0;i<c.n;i++) PB.ext[c.start+i]=v; };
  const reset = () => { PB.ext.fill(0);PB.v.fill(0);PB.I.fill(0);PB.r.fill(0);PB.refr.fill(0);PB.a.fill(0);PB.kcTrace.fill(0);PB.w.set(PB.w0); };
  const phase = (ms, ins) => {
    PB.ext.fill(0); (ins||[]).forEach(kv => setIn(kv[0], kv[1]));
    const n = Math.round(ms/1000/0.01); let sp = 0; const seen = {};
    for (let i=0;i<n;i++){ PB.step(0.01); for(let k=0;k<PB.n;k++) if(PB.raster[k]){ sp++; seen[k]=1; } }
    return { sp, act: Object.keys(seen).length/PB.n, rate: sp/PB.n/(ms/1000) };
  };
  const R = n => { const c=NET.ct[n]; let s=0; for(let i=0;i<c.n;i++) s+=PB.r[c.start+i]; return +(s/c.n).toFixed(1); };
  const o = {};
  reset(); let p = phase(300, []); o.baseRate = +p.rate.toFixed(3); o.baseAct = +p.act.toFixed(3);
  reset(); p = phase(500, [['GRN_sugar',2.4]]); o.sugarMN9 = R('MN_feed'); o.sugarGF = R('DN_escape');
  o.sugarAct = +p.act.toFixed(3); o.sugarSpPerNeuron = +(p.sp/PB.n).toFixed(2);
  reset(); phase(500, [['GRN_sugar',2.4],['ORN_alarm',2.25]]); o.sugarBitterMN9 = R('MN_feed');
  reset(); phase(500, [['ORN_alarm',2.25]]); o.bitterOnlyMN9 = R('MN_feed');
  reset(); phase(300, [['mechano',2.1]]); o.loomGF = R('DN_escape'); o.loomMN9 = R('MN_feed');
  p = phase(200, [['mechano',2.1]]); o.loomSpPerNeuron = +(p.sp/PB.n).toFixed(2);
  reset(); phase(500, [['GRN_sugar',1.2]]); o.weakMN9 = R('MN_feed');
  reset(); phase(500, [['GRN_sugar',2.4]]); o.strongMN9 = R('MN_feed');
  reset(); phase(400, [['GRN_sugar',2.4]]); o.adaptFirst = R('MN_feed'); phase(300, []); phase(400, [['GRN_sugar',2.4]]); o.adaptSecond = R('MN_feed');
  reset(); phase(500, [['GRN_sugar',2.4]]); phase(300, []); p = phase(200, []); o.restNetRate = +p.rate.toFixed(3);
  console.table(o); console.log('对照阈值见 docs/validation.md'); return o;
})();
