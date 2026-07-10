# goldbaton

本機優先的 AI 協作控制台。這個 repo 已完成 macOS 上的 Phase 1 provider
風險 spike，並保留可重跑的 Codex app-server 與 Claude Agent SDK harness。
Windows live gate 尚未執行，因此整體 Phase 1 仍未完成。

Provider、server、資料持久化與 Web UI 會依實作計畫在後續 Phase 加入；
目前仍不提供模擬 Provider 或提早落地 Phase 2 抽象。

## 開始使用

```bash
npm install
npm run check
npm run build
npm start
```

成功啟動目前 entrypoint 時會輸出：

```text
goldbaton: phase-1 risk spikes ready
```

Live provider 驗證會消耗少量 token，且需要兩個 CLI/SDK 已有可用的驗證
方式：

```bash
npm run spike:codex
npm run spike:claude
```

Windows 實機完成互動登入後，可用 `npm run verify:phase1` 一次跑完 Node、
Bun 與兩個 provider 的完整矩陣；不需要 GitHub Actions API-key secrets。

完整契約、Windows 重跑方式與目前證據見
[`docs/PHASE_1_SPIKES.md`](docs/PHASE_1_SPIKES.md)。

## 專案結構

```text
src/
├── index.ts  # 無副作用的專案 metadata export
└── main.ts   # 目前可執行 entrypoint
spikes/
├── claude/   # Agent SDK 串流、approval、interrupt probe
└── codex/    # app-server 串流與 approval round-trip probe
scripts/      # bindings codegen 與 repo 自有 gate
```
