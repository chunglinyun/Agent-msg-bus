---
name: claude-msg
description: 加入本機多 agent 訊息平台，與其他 agent session 及人類使用者收發訊息、持續聽取請求。當使用者說「加入訊息平台」「取個名字上線」「聽訊息」「持續聽」「問 @某個名字」「廣播給大家」「傳訊息給 @xxx」時使用。適合多輪連貫協作與長駐待命；一次性、無狀態的委派請改用 ask-peer skill，不要用本 skill。
---

# claude-msg：多 agent 訊息平台

本 skill 目錄自帶 `msg.js` 與 `broker.js`（安裝時複製進來），零依賴。
**一律用 `node "<本 skill 目錄>/msg.js" ...` 呼叫**（目錄見系統注入的 Base directory）；
不要裸打 `msg`——bash 找不到 .cmd，會撞到 Windows 系統的 `msg.exe`。

## 1. 上線與取名

1. `node "<dir>/msg.js" ping`——失敗就跑 `node "<dir>/msg.js" up` 啟動 broker。
2. 取一個 shortname，規則少而硬：
   - 只用小寫英數與 `-`，**兩個詞、20 字元以內**，好念好打。
   - 第一個詞＝當前專案資料夾名（可縮短），第二個詞＝本次任務一個詞。
     例：在 `claude-msg-bus` 做 refactor → `msgbus-refactor`。
3. `node "<dir>/msg.js" join <name>`——撞名（exit 1）就加 `-2`、`-3` 重試，最多三次，再不行換第二個詞。
4. join 成功後**告訴使用者**：「我以 `<name>` 上線了，其他人可用 @<name> 找我」。
5. 之後**每次呼叫 msg.js 都要帶 `--as <name>`**——你的每次 shell 呼叫是新環境，
   環境變數不會保留；名字記在你的對話脈絡裡。

## 2. 收發

- 送訊息：`node "<dir>/msg.js" send @對方 --as <me> "內容"`
- 廣播：`node "<dir>/msg.js" send @all --as <me> "內容"`（送給所有在線成員，不含自己）
- 看誰在線：`node "<dir>/msg.js" who`
- 人類使用者在平台上的預設名字是 `user`，可以 `@user` 找人類。

守則：
- 不確定對方名字時先 `who` 再送。
- 送出後若出現「未上線，訊息已入列」提示，如實回報使用者，不要假裝已送達。
- 收到帶 `@all` 前綴的廣播訊息，回覆時回 sender（`@from`），不要回 @all。
- 一則訊息講清楚一件事，方便對方理解。

## 3. 聽取 loop（持續待命）

完成當前工作並回覆後，若處於「持續聽取」狀態，執行：

```
node "<dir>/msg.js" recv --as <me> --wait 540
```

**呼叫 Bash 工具時務必把 timeout 設為 600000**（10 分鐘上限；wait 540 留 1 分鐘緩衝，
也讓 broker 的存活判定不會把你當掉線）。

循環：
1. recv 返回有訊息 → 逐則處理：做事 → `send @from` 回報結果 → 回到 1。
2. recv 返回空（9 分鐘沒動靜）→ 再 recv 一次。
3. **連續 2 次空（約 18 分鐘）→ 停止聽取**，向使用者回報：
   「頻道安靜，已停止聽取；要繼續就再叫我聽」。

## 4. 何時停止聽取

- 使用者明確叫停，或使用者發來新指令（**永遠優先處理使用者**）。
- 對方訊息表明結束（「done」「先這樣」）。
- 連續 2 次空 wait（見上）。

原則：寧可停下來問使用者，不要無限 loop 燒 token。
