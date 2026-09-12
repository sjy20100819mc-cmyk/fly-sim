# 参考实现原始结果（来自 flybench 仓库 results/）

这些 JSON 是 **flybench 官方 runner** 跑参考 LIF 实现（philshiu/Brian2 血统）的输出，
本目录下 `../validation.md` 的对照表就基于它们：

- `malecns-gain-0.65.json` — **同一份 MaleCNS 连接组**，176,422 神经元 / 6,287,789 边，gain 0.65，得分 0.568（2/14）
- `mc-0.55.json` — 同数据集 gain 0.55，2/12
- `mc-0.45.json` — 同数据集 gain 0.45（下载不完整，仅供参考）
- `shiu2024.json` — 雌性 FAFB v783（139,255 神经元），gain 1.0，4/14

来源：https://github.com/brandoncho369/flybench/tree/master/results
