# 訊息平台「中斷 agent」機制規劃

狀態：**規劃中，待使用者決定 UX 後才實作**。
相關計畫：鍵盤注入觸發原生指令獨立成 `docs/msg-native-cmd-plan.md`（若其 Esc 注入實測可行，對 split session 可作為更即時的中斷手段，本計畫對非 split 成員仍然必要）。

## Context

現況：訊息平台是排隊制。agent 埋頭做事（跑 tool call）期間不會收訊息，使用者送的「stop」要等 agent 下一次 `recv` 才被看到——實測 30 秒任務中途送 stop，30 秒後才送達。原生 Claude Code 的 Esc 能即時打斷，但那是因為 Esc 直接打在 agent 自己的終端機上；broker 隔著一層，摸不到 agent 的執行程序。

目標：讓使用者能「叫停」正在做事的 agent，中斷延遲越短越好。

## 方案：合作式中斷

原理：真正的 Esc 其實也只能在 tool call 邊界打斷；合作式就是把「邊界」做出來——agent 做長任務時**分步執行，步與步之間跑一次不等待的 `recv`**，看到 stop 就放下手上的事回報。

- 零 broker／協定改動：stop 就是一則普通訊息，約定俗成。
- 中斷延遲 = 一步的長度（守則要求一步 ≤ 1–2 分鐘，通常幾十秒內生效）。
- 改動範圍：`msg-bus-skill/SKILL.md` 與 `AGENTS-template.md` 各加一節「可中斷的長任務」守則；程式碼零改動（chat 模式糖另計，見 UX 待決）。
- 適用平台上所有成員（Claude、Codex、Gemini…），不限 split session。

守則草稿（SKILL.md 新增一節）：

1. 預估超過 2 分鐘的任務，拆成數步，每步結束跑 `node <dir>/msg.js recv --as <me>`（不帶 --wait，秒回）。
2. 收到內容為 `stop`（不分大小寫，或 `停`）的訊息 → 立刻停止當前任務，回報 sender：已完成什麼、停在哪、有無殘留。
3. 其他訊息 → 不中斷，記下來做完再處理（或視內容判斷要不要改變優先序）。
4. 中途 recv 到訊息但不是給你的指示（如廣播閒聊）→ 照常做完。

## UX 待決問題（使用者決定後定案）

1. **stop 的長相**：
   - a. 純訊息慣例：聊天視窗打 `msgbus-listen stop`（零改動）。
   - b. chat 模式加 `/stop <name>` 指令糖：效果同 a，但語意明確、可搭配狀態列回饋（送出後 spinner label 變 `⏹ msgbus-listen stopping…` 直到對方回報）。約 +15 行 broker.js。
2. **stop 之後 queue 怎麼辦**：agent 中止時，排隊中的其他訊息照常保留（下次 recv 收到）？還是視為整批作廢？（建議：保留，stop 只停「當前任務」。）
3. **停下來之後**：agent 回報後回到待命 loop？還是等使用者下一句？（建議：回待命 loop，跟平常一樣。）
4. **要不要擴大成「插話即重排」**：不只 stop，任何使用者新訊息都讓 agent 在步間看到、自行判斷要不要改變方向？（守則草稿第 3 點目前是「記下來做完再處理」，也可以改成「使用者訊息優先、立即改道」。）

## 實作步驟（待 UX 定案後）

1. `msg-bus-skill/SKILL.md`：新增「可中斷的長任務」一節（守則草稿依 UX 決定修訂）。
2. `AGENTS-template.md`：同步 provider 中立版。
3. （若選 1b）`broker.js` chat 模式：`/stop <name>` = 送 `stop` 給該成員＋spinner label 切成 stopping 狀態，對方下一次 send 解除。
4. README：協作慣例一節補 stop 慣例（無協定改動，協定表不動）。
5. 重跑 `Install-MsgBus` 部署 skill 副本（split 兩個假 home 也要）。

## 驗證

- 對一個聽命中的 agent 派一個 3 步、每步約 30–60 秒的任務，第一步進行中送 stop：agent 應在第一步結束後即中止並回報（不做第二步）。
- 派同樣任務不送 stop：三步照常做完，中途的無關訊息做完才處理。
- （若選 1b）`/stop` 後狀態列顯示 stopping，對方回報後恢復。

## 不做（YAGNI）

- 協定層的 urgent/priority 訊息種類——stop 只是文字慣例，夠用。
- kill agent 程序之類的硬中斷。
- 鍵盤注入（獨立計畫，見 `docs/msg-native-cmd-plan.md`）。
