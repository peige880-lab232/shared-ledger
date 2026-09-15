# share-ledge 後端整合

前端會優先使用 API 回傳的 `shortUrl` 來顯示及複製邀請連結。短網址必須由 `shared-ledger-api` Worker 建立；瀏覽器絕不能取得短網址服務的 `ADMIN_TOKEN`。

## API Worker secrets

在 `shared-ledger-api` Worker 設定：

- `SHORTLINK_API_URL`：例如 `https://share-ledge.<account>.workers.dev`
- `SHORTLINK_ADMIN_TOKEN`：short-link Worker 的 `ADMIN_TOKEN`
- `APP_ORIGIN`：記帳網站正式網址

## `POST /groups` 中新增的伺服器端邏輯

在群組已建立、並取得 `group.id` 與 `key` 後執行：

```js
const target = `${env.APP_ORIGIN}/#${new URLSearchParams({
  group: group.id, key, name: group.name,
})}`;
const code = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const result = await fetch(`${env.SHORTLINK_API_URL}/api/links/${code}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Admin-Token": env.SHORTLINK_ADMIN_TOKEN,
  },
  body: JSON.stringify({ target, status: 302 }),
});
if (!result.ok) throw new Error("Unable to create invitation short link");
return Response.json({ group, key, shortUrl: `${env.SHORTLINK_API_URL}/${code}` });
```

若需要在重新載入時仍顯示短網址，將 `shortUrl` 存入群組資料，並在 `GET /groups/:id` 回傳它。
