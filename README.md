# goldbaton

本機優先的 AI 協作控制台。這個 repo 目前完成 Phase 0，只包含可執行的
TypeScript 骨架、Goldband 對齊的 Biome 門檻，以及專案層級操作說明。

Provider、server、資料持久化與 Web UI 會依實作計畫在後續 Phase 加入；
目前不提供模擬實作。

## 開始使用

```bash
npm install
npm run check
npm run build
npm start
```

成功啟動 Phase 0 entrypoint 時會輸出：

```text
goldbaton: phase-0 scaffold ready
```

## 專案結構

```text
src/
├── index.ts  # 無副作用的專案 metadata export
└── main.ts   # Phase 0 可執行 entrypoint
```
