# 新豐廠人時性儀表板

## 日常更新方式

1. 先在 GitHub Desktop 按 **Fetch origin / Pull origin**。
2. 將新的新豐廠人時生產性日報 `.xlsx` 放到 `data/`（也支援年月子資料夾）。
3. Commit 並 Push 到 `main` 或 `master`。
4. GitHub Actions 會自動更新 `data/manifest.json`、`data/json-manifest.json` 與 `data-json/`。
5. Actions 完成後，再 Pull 一次取得自動產生的 JSON。

不需要手動修改任何 manifest；同月份若同時存在部分檔與完整檔，會自動採用結束日期較晚的完整版本。

## 本機手動轉檔

```bash
npm ci
npm run convert:data
npm run check:data
```

網站優先讀取精簡 JSON；若 JSON 缺漏或讀取失敗，才會自動退回原始 Excel。
