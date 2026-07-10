# goldbaton

本機優先的 AI 協作控制台。Phase 2 已提供正式、provider-neutral 的
`Provider` 契約、`ClaudeProvider`、`CodexProvider`，以及會先移除敏感資料、
再按 run 寫入 append-only JSONL 的 `EvidenceLog`。

Phase 1 的可重跑風險 spike 仍隔離在 `spikes/`，不作為正式 Provider
實作。Windows live gate 尚未執行，因此目前不宣稱 Windows provider
鏈路已驗證。

## 開始使用

```bash
npm install
npm run check
npm run build
npm start
```

成功啟動目前 entrypoint 時會輸出：

```text
goldbaton: Phase 2 provider adapters ready
```

## Provider API

```ts
import {
  ClaudeProvider,
  CodexProvider,
  EvidenceLog,
  recordProviderEvents,
} from './src/index.js';

const providers = [new ClaudeProvider(), new CodexProvider()];
const capabilities = providers.map((provider) => ({
  id: provider.id,
  ...provider.capabilities(),
}));
```

`Provider.createSession()` 建立 provider-neutral session；session 提供
`send()`、`respondToApproval()`、`interrupt()` 與 `close()`。`send()` 只吐
統一事件，不會把 Claude SDK 或 Codex app-server wire payload 洩漏給上層。
完整事件與生命週期契約見
[`docs/PROVIDER_CONTRACT.md`](docs/PROVIDER_CONTRACT.md)。

Live provider 驗證會消耗少量 token，且需要兩個 CLI/SDK 已有可用的驗證
方式：

```bash
npm run spike:codex
npm run spike:claude
npm run providers:verify:live # 正式 adapters + Evidence Log
```

Windows 實機完成互動登入後，可用 `npm run spike:verify` 一次跑完 Node、
Bun 與兩個 provider 的完整矩陣；不需要 GitHub Actions API-key secrets。

完整契約、Windows 重跑方式與目前證據見
[`docs/PROVIDER_SPIKES.md`](docs/PROVIDER_SPIKES.md)。

## 專案結構

```text
src/
├── evidence/       # JSONL Evidence Log 與 secret redaction
├── provider/       # 公開介面、事件 schema 與共用 primitives
├── providers/
│   ├── claude/     # Claude Agent SDK adapter
│   └── codex/      # Codex app-server adapter
├── index.ts        # 無副作用的公開 API
└── main.ts         # 目前可執行 entrypoint
spikes/
├── claude/   # Agent SDK 串流、approval、interrupt probe
└── codex/    # app-server 串流與 approval round-trip probe
scripts/      # bindings codegen 與 repo 自有 gate
```

Phase 2 刻意沒有加入 WebSocket server、Web UI、對話狀態資料庫或設定檔驅動的
Provider Registry；它們依實作計畫分別屬於後續 Phase。
