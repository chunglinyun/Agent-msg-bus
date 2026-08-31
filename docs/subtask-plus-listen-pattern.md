# Subtask + Listen 併行模式

一則工作實踐紀錄，外加一次誠實的失誤覆盤。給未來的 session 參考。

相關：[[claude-msg]]

## 情境

在多代理訊息平台（`claude-msg` skill）待命時，本 session 以 `cie-listen` 名字上線。
peer `@tppay-redis` 丟來一個很重的跨服務程式碼調查問題：ciemobile 錢包遷移 stage 處理的 4 個問題，
需要讀 `Service/Payment/*`、`Global.asax.cs`、`PaymentSdkSimpleInjectorExtensions.cs`、`web.*.config` 等多份原始碼。

## 有效的做法（切分原則）

一句話：**把「重 / 會污染 context / 花時間」的工作外包出去；「必須即時」的工作自己留著。**兩者併行、互不阻塞。

- **重、污染 context、慢** → 丟給背景 subagent（今天用的是 Explore / general-purpose 型別）。它只回結論 + `file:line`，主 session 的 context 保持乾淨。
- **輕、要即時** → 留在主 session（維持 `recv --wait` 監聽 loop），研究在跑的同時，user 或 peer 的新訊息會**即時喚醒 `recv`**、不被卡住。

> 澄清一個看似矛盾處：`recv --wait` 對主 session 而言是阻塞呼叫，但**進來的 peer/user 訊息會立刻喚醒它**；唯一「晚一拍」的是**背景 subagent 的完成通知**——它不喚醒 wait，只在下一個 event 邊界才浮現（見下節）。所以「阻塞」與「新訊息不被卡住」兩者並不衝突。

## 失誤 / 差點出事（誠實紀錄）

這主要是**可見度與預期落差**，不是資料遺失——不要誇大成 bug。

- 啟動 subagent 後，主 session 直接進入阻塞的 `recv --wait 540`。
- 背景 subagent 完成時，**不會**照它自己的節奏在 wait 中途插斷。它的結果是以 `<task-notification>` 的形式，
  在**下一個 event 邊界**才浮現。
- 這段期間 human user 沒有任何「背景工作正在進行」的訊號，於是合理地判斷
  「但你的 subtask 結束以後結果沒有回來這裡」。實際上那個當下 subtask **還沒**完成；
  結果與通知是在 user 那則訊息之後一拍才到。
- 混淆的根因：主 session 沒有**事先**把預期講清楚——(a) subagent 結果會透過 task-notification 自動回來、不需輪詢；
  (b) 那個通知可能比其他訊息**晚一拍**到；(c) **不可以**去讀 subagent 的原始輸出 / transcript 檔來「確認」
  （那是完整 JSONL transcript，讀它會撐爆 context——結果本來就會自動送達）。

## 真正的失誤：回覆沒送回 bus（比上面嚴重）

上面那個是可見度誤會；這一個是實打實的失誤。

- user 是**從訊息平台以 `@user` 跟我對話**的——他的每則訊息都經 broker 進到我的 `recv`
  （格式 `[time] user: ...` 就是 bus 訊息）。
- 但我前面所有回覆都打在**終端機 markdown**。終端輸出只有終端這一側看得到；
  坐在 chat room 那側的 human 完全看不到。
- 結果：從 user 的座位看，「訊息都沒回來」——因為我從沒用 `msg send @user --as cie-listen` 把回覆送回 bus。
  我以為我在回話，實際上對方那側一片空白。
- 根因：搞錯了對話發生在哪個通道。訊息**從 bus 進來**，回覆就必須**從 bus 出去**，
  不能預設回終端。

## 下次的規則

1. **（最重要）訊息從哪個通道進來，回覆就從哪個通道出去。** 若 user 是經 bus（`recv` 收到 `[time] user:`）
   跟你說話，回覆一律用 `msg send @user --as cie-listen`（每次呼叫都要帶 `--as <bus名>`，這是 CLAUDE.md 硬規則），
   不要只打在終端；終端輸出對方看不到。
2. subagent 與監聽 loop 併行時，**事先告訴 user**：結果會透過 task-notification 自動浮現，
   可能比其他訊息晚一點到；不用輪詢、不用讀 transcript 檔。
3. 在通知到達前，**不要**過早宣稱背景結果「遺失」或「已在」——等通知。
4. 正確心智模型：subagent 結果是 **push（通知）**，不是 pull。不要輪詢，不要 tail 輸出檔。
5. 維持切分：重 / context 重 / 慢 → subagent；即時 / 輕量（監聽）→ 主 session。
