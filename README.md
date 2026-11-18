# AudioTune Fusion Web — 家庭劇院與音響室調音大師（S24 Ultra 專用 PWA）

專為 **Samsung Galaxy S24 Ultra**（Chrome / Samsung Internet 行動瀏覽器）打造的純原生前端聲學與硬體感應器融合調音儀器。無需打包編譯，直接部署於 GitHub Pages HTTPS 環境即可開箱即用，並支援「加到主畫面」全螢幕 PWA 運行。

🌐 **線上體驗網址**：[https://happyfarmer-dot.github.io/audiotune-fusion-s24u/](https://happyfarmer-dot.github.io/audiotune-fusion-s24u/)

---

## ✨ 四大核心模組

1. **皇帝位聲學相位、低頻駐波與殘響分析（Web Audio API）**
   - 關閉瀏覽器語音降噪與自動增益（`echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`），擷取未失真原始聲場訊號。
   - **4096-pt Radix-2 FFT ＋ GCC-PHAT 廣義互相關相位變換**：針對 S24 Ultra 頂部與底部雙麥克風（間距 `0.162 m`）即時計算聲源到達角（DoA）、時間差 $\Delta t$ 與建議微調公分數；若瀏覽器降級為單聲道，自動無縫切換為「脈衝相位對齊與低頻駐波峰值偵測模式」。
   - **20–250 Hz 低頻駐波頻譜瀑布圖**與 **Schroeder $RT_{60}$ 房間殘響時間估算**。
   - 內建測試訊號產生器：**粉紅噪音（Pink Noise）**、**對數掃頻（20 Hz – 8,000 Hz Log Chirp）**、**低頻掃描／單頻鎖定（30 Hz – 200 Hz）**。

2. **喇叭／重低音箱體諧振與抑振評分（DeviceMotion ＋ 超低頻聲學）**
   - 監聽 `devicemotion` 去除重力後的線性三軸加速度 `event.acceleration`，動態計算實際採樣率，並融合 Web Audio **15–150 Hz 2 階 IIR 巴特沃斯濾波器**聲壓包絡。
   - 即時計算三軸振動 **RMS G 值** 與 **FFT 箱體共鳴主頻**，換算為直覺的 **箱體抑振評分（0–100 分）**。

3. **擴大機變壓器與訊號線漏磁干擾掃描（雙軌磁力計引擎 ＋ 觸覺震動）**
   - **主引擎**：優先偵測 Generic Sensor API（`'Magnetometer' in window`），讀取原始三軸磁通量（$\mu\text{T}$），計算靜態磁場偏移與交流磁場抖動能量（EMI 指數）。
   - **自動備援引擎**：若 Chrome 未開啟實驗性旗標，自動切換為 `deviceorientationabsolute` 絕對地磁羅盤偏轉偵測，計算瞬時異常偏轉量與 60 Hz 高頻角速度抖動標準差。
   - 掃描靠近漏磁超標區域時，觸發 S24 Ultra 線性馬達脈衝震動警報（`navigator.vibrate([80, 40, 80])`）。

4. **音響室調音紀錄與前後對比（LocalStorage ＋ JSON 匯出）**
   - 儲存每次量測快照，提供「調整前 vs 調整後」並排數據對比，並支援一鍵匯出 `.json` 體檢報告。

---

## 📱 Samsung Galaxy S24 Ultra 擺位測量教學

1. **皇帝位相位與駐波量測**：
   - 點擊頂部 **「一鍵啟動全部感應器」** 授權麥克風、動態感應器與螢幕常亮（Screen Wake Lock）。
   - 將手機垂直或水平朝向主喇叭中央（皇帝位），確保頂部與底部雙麥克風無遮擋，播放粉紅噪音或對數掃頻即可觀察相位羅盤與 20–250 Hz 駐波瀑布圖。
2. **箱體諧振與避震墊測試（平放測量）**：
   - 將 S24 Ultra **螢幕朝上平放** 於重低音音箱或書架喇叭頂部中央。
   - 切換至「箱體諧振」分頁並播放「低頻自動掃描（30–200 Hz）」，對比加裝角錐、黑金石或避震墊前後的 **抑振評分** 與 **RMS G 值**。
3. **擴大機變壓器漏磁掃描（機身中上半部）**：
   - Galaxy S24 Ultra 的磁力計（霍爾/地磁感應器）位於 **機身中上半部（約相機模組下方至螢幕中上段區域）**。
   - 切換至「漏磁掃描」分頁，先在遠離電器處點擊「環境基準歸零校準」，再將手機中上半部貼近擴大機環形變壓器、電源排插或 RCA/XLR 訊號線周邊慢速移動，即可精準抓出漏磁熱區。
   - *進階提示*：若希望在 Chrome 中直接讀取原始 $\mu\text{T}$ 數值，可於網址列輸入 `chrome://flags/#enable-generic-sensor-extra-classes` 設為 **Enabled** 並重啟瀏覽器。

---

## 🛠️ 技術架構

- 純 HTML5 + CSS3（Tailwind CSS CDN）+ 原生 ES6 模組（`dsp.js`、`sensors.js`、`app.js`）
- 零建置依賴，支援 GitHub Pages 靜態託管與離線 PWA 快取（`manifest.json`、`sw.js`）
