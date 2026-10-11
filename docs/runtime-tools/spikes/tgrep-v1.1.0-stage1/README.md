# tgrep v1.1.0 阶段 1 取证（gate D09 / G1 / G3 预览 / G5）

取证日期：2026-10-10。主机：macOS (darwin 27.2.0, arm64, Apple Silicon)。工具：tgrep 1.1.0
（归档 SHA-256 与契约一致）、随包 ripgrep 14.1.1（rev 4649aa9700）、随包 ugrep 7.8.4。所有
结论只针对 pinned v1.1.0；结果文件为 `results/*.json`，机器可读。

## 复现

```bash
node scripts/tgrep-stage1/run-freshness.mjs   # 6000 文件语料, 25 迭代
node scripts/tgrep-stage1/run-benchmark.mjs   # 12000 文件语料, 7 次重复
node scripts/tgrep-stage1/run-benchmark.mjs --out /tmp/tgrep-large --files 50000 --reps 5
```

语料由 `scripts/tgrep-stage1/lib/corpus.mjs` 以固定 seed 生成（已提交 git 仓库）；tgrep 归档
按 SHA-256 固定下载校验，rg/ugrep 从仓库内置归档解包，保证对照对象就是发行产物。

## 新鲜度（freshness-darwin-arm64.json）

| 测试                                                  | 结果                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| S1 shared `--no-watch` + `refresh --changed` 确认后读 | **25/25 通过**；未 refresh 前 25/25 立即 miss；refresh 中位 272 ms（p95 316 ms）              |
| S1b 修改已提交文件（追加/删除 token）                 | 25/25 通过；确认后新增可见、删除不残留（无 stale 假阳性）                                     |
| S1c 删除已确认文件                                    | 5/5 通过                                                                                      |
| S1M 多路径 `--changed a --changed b`                  | 支持，双路径均确认可见                                                                        |
| S2 同尺寸 + 还原 mtime 的隐蔽编辑                     | `--no-watch` 下 ready 保持 true（假 ready）且查询陈旧；仅 `refresh --full`（中位 543 ms）恢复 |
| S3 native watch 外部写入                              | ready 在 21 ms 内关闭；**关闭窗口内查询仍返回正确结果**（扫描回退）；539 ms 后恢复 ready      |
| S4 链接 worktree 隔离                                 | 同一 daemon 两个 view 无泄漏；`--full` 不把 A 的未提交文件带进 B                              |
| O1 普通 serve（auto watch）                           | 24/25 写后立即查询 miss；可见延迟中位 47 ms（max 67 ms）——异步窗口实测存在                    |
| O2 普通 serve `--no-watch`                            | 确认永久陈旧                                                                                  |

结论：**gate D09 的机制在 pinned v1.1.0 上成立**——shared daemon 的
`refresh --changed → processed_epoch` 是可判定的读后写确认；native watch 的 readiness 关闭
是外部写入的安全信号，且关闭期间查询退化为扫描、不产生假阴性。普通 `serve` 没有显式
refresh 确认命令，不能用于加速态。

资源占用（6000 文件 / 35 MB）：attach→ready 1.87 s；shared storage 33 MB；daemon RSS ~61 MB。
（12000 文件 / 70 MB：attach→ready 3.6 s；storage 66 MB；RSS ~156 MB。）

## 查询延迟与 parity（benchmark-darwin-arm64.json，12000 文件）

| 查询                   | 命中规模  | tgrep 中位 | rg 中位 | ugrep 中位 | tgrep/rg | 输出 parity |
| ---------------------- | --------- | ---------: | ------: | ---------: | -------: | ----------- |
| rare_literal（1 文件） | 1 行      |  **17 ms** |   80 ms |      87 ms |    0.21x | ✅          |
| glob_ts                | 268 行    |      41 ms |   39 ms |      40 ms |      ~1x | ✅          |
| regex_alternation      | 1782 行   |     767 ms |   91 ms |      85 ms |  8.4x 慢 | ✅          |
| filenames_only（-l）   | 11984 行  |     736 ms |  166 ms |      88 ms |  4.4x 慢 | ✅          |
| count（-c）            | 11984 行  |     976 ms |  167 ms |     137 ms |  5.8x 慢 | ✅          |
| common_literal         | 140336 行 |    1010 ms |  174 ms |      99 ms |  5.8x 慢 | ✅          |
| case_insensitive       | 138741 行 |    1051 ms |  171 ms |      95 ms |  6.1x 慢 | ✅          |
| broad_count            | 12003 行  |    1242 ms |  169 ms |      89 ms |  7.4x 慢 | ✅          |

全部 8 个 pattern 的排序输出与退出码与随包 rg 完全一致（G3 预览通过；完整 parity 语料
按 TG10 在实现阶段扩展）。ugrep 使用 agent 的嵌入式默认参数（`-G` BRE 等），其
`regex_alternation`/`broad_count` 计时与 rg 语义不同，**仅作参考**；parity 只在 tgrep 与 rg
之间成立。延迟与资源测量均在 shared daemon `--no-watch` 模式下取得（静态语料，阶段 1 取证
许可；产品模式按契约必须 watch-on，其常驻开销不在本表内）。

**「每次编辑后搜索」循环**（agent 的主导用法，15 循环）：tgrep `refresh --changed` + 查询
中位 **519 ms**，对照纯 rg 查询中位 **84 ms**——编辑后加速路径比 baseline 慢 6.2x。

## 结论

1. 新鲜度 gate（D09）机制成立：阶段 3 可以按 shared-daemon 契约实现确定性新鲜度。
2. **性能前提（G5）在中等规模语料上被证伪**：索引只在选择性强的查询（罕见字面量）上
   赢（~4.7x）；agent 常见的高命中查询与编辑后循环全面慢于现有路径（4.4–8.4x）。
   早前会话 8.6–18.3x 的结论基于 filenames-only、暖索引、无编辑成本的窄集合，不成立为
   产品依据。
3. 50k 文件补充测量见 `results/benchmark-darwin-arm64-large.json`（规模外推，下节）。
4. 在取得「目标规模语料 + 真实查询组合」的正向测量之前，阶段 2（随包分发）不启动；
   default-on 永远不在本计划范围内。

## 规模外推（benchmark-darwin-arm64-large.json，50000 文件 / 295 MB，5 次重复）

| 查询              | tgrep 中位 | rg 中位 | ugrep 中位 | tgrep/rg              |
| ----------------- | ---------: | ------: | ---------: | :-------------------- |
| rare_literal      |  **21 ms** |  315 ms |     377 ms | **0.07x（15x 加速）** |
| glob_ts           |      82 ms |  139 ms |     173 ms | 0.59x（1.7x 加速）    |
| regex_alternation |    3444 ms |  374 ms |     451 ms | 9.2x 慢               |
| filenames_only    |    3395 ms |  681 ms |     441 ms | 5.0x 慢               |
| count             |    4331 ms |  686 ms |     480 ms | 6.3x 慢               |
| common_literal    |    5274 ms |  698 ms |     503 ms | 7.6x 慢               |
| case_insensitive  |    4124 ms |  695 ms |     450 ms | 5.9x 慢               |
| broad_count       |    3061 ms |  689 ms |     434 ms | 4.4x 慢               |

编辑循环：tgrep `refresh --changed` + 查询中位 **2305 ms** vs 纯 rg **336 ms**（6.9x 慢）。
attach→ready 14.1 s；storage 277 MB；daemon RSS ~409 MB。parity 8/8 与 12k 运行一致。

外推结论：选择性查询的加速随语料规模放大（12k 时 4.7x → 50k 时 15x），宽查询的相对劣势
基本不变，而 `refresh --changed` 的单次成本随语料规模线性增长（6k≈272 ms → 50k≈2.2 s），
「编辑后即搜索」的加速路径在大仓库上进一步恶化。

## 结果文件

- `results/freshness-darwin-arm64.json`：S0–S4、O1、O2、gate 判定。
- `results/benchmark-darwin-arm64.json`：延迟、parity、编辑循环、attach/资源。
- `results/benchmark-darwin-arm64-large.json`：50000 文件补充测量（5 次重复）。
