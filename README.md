# TA 自動填報工具


破爛的學校，狗屎的系統，學生要麻想辦法自己寫工具克服，不然就活該自己填

本工具為本人真的懶的手填學校的狗屎填報系統寫出的自動化腳本，
運行邏輯為將 TA 課後輔導單照片交由 `gemini` 分類，並使用爬蟲實現自動填入。

![](https://media.fgo.wiki/thumb/c/ce/%E6%84%9A%E4%BA%BA%E8%8A%82_%E5%8D%A1%E9%9D%A2_FFJ_418.png/285px-%E6%84%9A%E4%BA%BA%E8%8A%82_%E5%8D%A1%E9%9D%A2_FFJ_418.png)

## 0. 先準備
1. Windows 電腦
2. 本專案資料夾
3. Gemini API Key
4. TA 網站帳號密碼
5. 簽到單圖片

## 1. 安裝 Bun（只要做一次）

開 PowerShell，執行：

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
```

安裝後，關掉 PowerShell 再開新視窗，檢查：

```powershell
bun --version
```

有顯示版本號就成功。

如果顯示找不到 `bun`：
1. 關閉再重開終端
2. 把 `%USERPROFILE%\.bun\bin` 加到 PATH

官方安裝說明：  
https://bun.com/docs/installation

## 2. 設定 `.env`

在專案根目錄建立/修改 `.env`：

```env
ACCOUNT=你的學校帳號
PASSWORD=你的學校密碼
LOGIN_WEBSITE=https://ta.pu.edu.tw/login.php
SCRIPT_WEBSITE=https://ta.pu.edu.tw/index.php
GEMINI_API_KEY=你的金鑰
GEMINI_MODEL=gemini-3.1-flash-lite
```

## 3. 每次操作流程

## 步驟 A：放圖片
把圖片放到：

`images/`

例如：
- `images/image_7.jpg`
- `images/image_8.jpg`

## 步驟 B：辨識

```powershell
bun gemini/recognize-images.mjs --overwrite
```

輸出：
- `data/recognized/*.json`
- `data/pending/pending.json`

## 步驟 C：送審（核准）

先看待核准清單：

```powershell
bun gemini/approve-records.mjs --list
```

核准指定 ID（只核准你要的）：

```powershell
bun gemini/approve-records.mjs --ids <id1,id2>
```

核准全部：

```powershell
bun gemini/approve-records.mjs --all
```

## 送審佇列規則
- `data/approved/to-submit.json` 預設只會放「本次新核准」資料。
- 例如先送 1、2，下一次只核准 3，`to-submit.json` 只會有 3。
- 不會重複把 1、2 再送一次。

如果你想要「全部已核准」都放進佇列，才用：

```powershell
bun gemini/approve-records.mjs --all --queue-all-approved
```

## 步驟 D：先 dry-run，再 commit

先模擬（不真的寫入）：

```powershell
bun crawler/submit-records.mjs --input data/approved/to-submit.json
```

確認沒問題再真的寫入：

```powershell
bun crawler/submit-records.mjs --input data/approved/to-submit.json --commit
```

## 4. 常用參數

```powershell
--course-id 3389
--sign-in 12:00
--sign-out 13:00
--notes 指導作業
--limit 3
--verbose
```

## 5. 常見問題

## Q1: `to-submit.json` 找不到
先做核准：

```powershell
bun gemini/approve-records.mjs --all
```

## Q2: Gemini 報 `429 quota exceeded`
代表 API key 配額不足或未開通計費。  
要去 Gemini/Google AI 後台確認配額與專案。

## Q3: 看起來沒新增
先確認：
1. 你選對月份
2. `data/submit/submit-result.json` 的狀態
3. 同日期時段可能是「更新既有列」而不是新增一列

## Q4: 課輔內容錯誤
目前預設固定寫入 `指導作業`。  
如需強制：

```powershell
bun crawler/submit-records.mjs --input data/approved/to-submit.json --commit --notes 指導作業
```

## 6. 建議你每次都用這組指令

```powershell
# 1) 辨識
bun gemini/recognize-images.mjs --overwrite

# 2) 看待核准
bun gemini/approve-records.mjs --list

# 3) 核准（可改 --ids）
bun gemini/approve-records.mjs --all

# 4) 模擬寫入
bun crawler/submit-records.mjs --input data/approved/to-submit.json

# 5) 正式寫入
bun crawler/submit-records.mjs --input data/approved/to-submit.json --commit
```
