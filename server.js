// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const os = require("os");

const app = express();

/* ============ 基本設定 ============ */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-Line-Signature"],
  })
);
// 千萬不要在全域掛 JSON（避免破壞 LINE 驗簽）
// app.use(bodyParser.json());

/* ============ 可下載目錄（Render 可寫：/tmp） ============ */
function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
const REPORTS_DIR = path.join(os.tmpdir(), "reports");
ensureDir(REPORTS_DIR);

// 讓 /reports 指向 /tmp/reports（處理中文檔名 OK）
app.use("/reports", express.static(REPORTS_DIR, { fallthrough: false }));

/* ============ LINE Bot 設定 ============ */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ============ 危險區與推播（原功能保留） ============ */
const dangerZone = { lat: 25.01528, lng: 121.5474, radius: 500 }; // m
const pushableUsers = new Map(); // userId => timestamp

/* ============ 回報流程暫存 ============ */
// userId -> { category, reportDir, hasPhoto, hasLocation, folderName }
const pendingReports = new Map();

/* ============ 小工具 ============ */
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function getBaseUrl() {
  // Render 會提供 RENDER_EXTERNAL_URL；你也可自行設 PUBLIC_BASE_URL
  return process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
}

// 壓縮 reportDir 到 /tmp/reports/<zipBaseName>.zip，回傳完整 URL（但我們只 log 不回給用戶）
async function zipToPublic(reportDir, zipBaseName) {
  const safeBase = (zipBaseName || "report").replace(/[\\/:*?"<>|]/g, "_");
  const zipFilename = `${safeBase}.zip`;               // 檔案系統上保留中文檔名
  const zipPath = path.join(REPORTS_DIR, zipFilename);

  try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.directory(reportDir, false);
    archive.pipe(output);
    archive.finalize();
  });

  const encoded = encodeURIComponent(zipFilename);
  const base = getBaseUrl();
  const url = (base ? `${base}` : "") + `/reports/${encoded}`;
  console.log("✅ ZIP created:", zipPath);
  console.log("🔗 下載連結（後台用）：", url);
  return url;
}

/* ============ 啟動回報：每次建立「顯示名稱版」資料夾 ============ */
async function startReport(event, category) {
  const userId = event.source?.userId;
  if (!userId) {
    await client.replyMessage(event.replyToken, { type: "text", text: "無法取得使用者資訊。" });
    return;
  }

  // 顯示名稱 → 資料夾名：YYYYMMDD_HHMMSS_顯示名稱（非法字元 → _）
  let displayName = null;
  try {
    const profile = await client.getProfile(userId);
    displayName = (profile?.displayName || "").trim();
  } catch {}
  const safeName = (displayName && displayName.replace(/[\\/:*?"<>|]/g, "_").trim()) || userId;

  // 父目錄：./疑似蜜蜂 或 ./疑似蜂巢（存在於容器本機，暫存）
  const baseDir = path.join(__dirname, category);
  ensureDir(baseDir);

  // 最終資料夾：YYYYMMDD_HHMMSS_顯示名稱(或 userId)
  const folderName = `${ts()}_${safeName}`;
  const reportDir = path.join(baseDir, folderName);
  ensureDir(reportDir);

  // name.txt（真正顯示名稱；取不到就空字串）
  try {
    fs.writeFileSync(path.join(reportDir, "name.txt"), displayName ?? "", "utf8");
  } catch (e) {
    console.error("寫入 name.txt 失敗：", e);
  }

  // 建立狀態
  pendingReports.set(userId, {
    category,
    reportDir,
    hasPhoto: false,
    hasLocation: false,
    folderName,
  });

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `已建立「${category}」回報資料夾：\n${folderName}\n\n請依序上傳：\n1) 一張照片\n2) 位置（LINE 位置訊息或由 LIFF 上報）`,
  });
}

/* ============ 完成檢查（完成即生成 ZIP，連結只寫 Logs） ============ */
async function finishIfReady(userId, replyToken) {
  const st = pendingReports.get(userId);
  if (!st) return false;

  if (st.hasPhoto && st.hasLocation) {
    pendingReports.delete(userId);

    try {
      const url = await zipToPublic(st.reportDir, st.folderName);
      // 後台可見連結，前端用戶不會看到
      console.log(`📦「${st.category}」完成，下載：${url}`);
    } catch (e) {
      console.error("壓縮/產出下載連結失敗：", e);
    }

    const text = `📦「${st.category}」已完成存檔（照片＋定位＋名稱）。`;
    if (replyToken) {
      await client.replyMessage(replyToken, { type: "text", text });
    } else {
      await client.pushMessage(userId, { type: "text", text });
    }
    return true;
  }
  return false;
}

/* ============ webhook（不要在全域掛 JSON） ============ */
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      try {
        if (event.type !== "message") continue;
        const userId = event.source?.userId;
        const msg = event.message;

        // 文字（保留原功能 + 新增回報啟動）
        if (msg.type === "text") {
          const text = (msg.text || "").trim();

          if (text === "開啟追蹤") {
            if (!pushableUsers.has(userId)) {
              pushableUsers.set(userId, 0);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "✅ 你已成功啟用追蹤通知，請開啟 LIFF 畫面開始定位。",
              });
            } else {
              await client.replyMessage(event.replyToken, { type: "text", text: "🔁 你已經啟用過追蹤通知。" });
            }
            continue;
          }

          if (text === "關閉追蹤") {
            pushableUsers.delete(userId);
            await client.replyMessage(event.replyToken, { type: "text", text: "🛑 你已關閉追蹤功能。" });
            continue;
          }

          if (text === "發現疑似蜜蜂" || text === "發現疑似蜂巢") {
            const category = text.includes("蜜蜂") ? "疑似蜜蜂" : "疑似蜂巢";
            await startReport(event, category);
            continue;
          }

          // 其他文字：保持不回覆
          continue;
        }

        // 圖片：在回報模式下存檔
        if (msg.type === "image") {
          const st = pendingReports.get(userId);
          if (!st) continue;

          try {
            const stream = await client.getMessageContent(msg.id);
            const filePath = path.join(st.reportDir, "image.jpg");
            await new Promise((resolve, reject) => {
              const ws = fs.createWriteStream(filePath);
              stream.pipe(ws);
              ws.on("finish", resolve);
              stream.on("error", reject);
              ws.on("error", reject);
            });

            st.hasPhoto = true;
            const done = await finishIfReady(userId, event.replyToken);
            if (!done) {
              await client.replyMessage(event.replyToken, { type: "text", text: "✅ 照片已儲存，請再分享定位。" });
            }
          } catch (err) {
            console.error("❌ 圖片存檔失敗：", err);
            await client.replyMessage(event.replyToken, { type: "text", text: "抱歉，圖片儲存失敗。" });
          }
          continue;
        }

        // 位置：在回報模式下寫入
        if (msg.type === "location") {
          const st = pendingReports.get(userId);
          if (!st) continue;

          try {
            const locStr = `${msg.latitude},${msg.longitude}`;
            fs.writeFileSync(path.join(st.reportDir, "location.txt"), locStr, "utf8");
            st.hasLocation = true;

            const done = await finishIfReady(userId, event.replyToken);
            if (!done) {
              await client.replyMessage(event.replyToken, { type: "text", text: "✅ 已收到定位，請再上傳照片。" });
            }
          } catch (err) {
            console.error("❌ 寫定位失敗：", err);
            await client.replyMessage(event.replyToken, { type: "text", text: "抱歉，儲存定位失敗。" });
          }
          continue;
        }

        // 其他訊息型別：忽略
      } catch (e) {
        console.error("❌ webhook 單一事件錯誤：", e);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook 處理錯誤：", err);
    res.sendStatus(200);
  }
});

/* ============ /location（只在這條掛 JSON 解析） ============ */
app.post("/location", bodyParser.json(), async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    console.warn("❌ 缺少欄位：", req.body);
    return res.status(400).send("Missing fields");
  }

  // 原：危險區推播 + 15 秒冷卻
  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc);
  console.log(`📍 ${userId} 距離危險區：${distance.toFixed(2)}m`);

  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    const now = Date.now();
    const last = pushableUsers.get(userId) || 0;
    if (now - last >= 15 * 1000) {
      try {
        await client.pushMessage(userId, { type: "text", text: "⚠️ 警告：您已進入危險區域，請注意安全！" });
        pushableUsers.set(userId, now);
      } catch (err) {
        console.error("❌ 推播失敗：", err.originalError?.response?.data || err);
      }
    } else {
      console.log("⏱️ 推播冷卻中，暫不重複通知");
    }
  }

  // 回報模式：寫入 location.txt；若完成→產出 ZIP（只寫 Logs）
  const st = pendingReports.get(userId);
  if (st) {
    try {
      const locStr = `${latitude},${longitude}`;
      fs.writeFileSync(path.join(st.reportDir, "location.txt"), locStr, "utf8");
      st.hasLocation = true;

      if (st.hasPhoto && st.hasLocation) {
        pendingReports.delete(userId);
        try {
          const url = await zipToPublic(st.reportDir, st.folderName);
          console.log(`📦「${st.category}」完成，下載：${url}`);
          await client.pushMessage(userId, { type: "text", text: `📦「${st.category}」已完成存檔（照片＋定位＋名稱）。` });
        } catch (e) {
          console.error("壓縮/產出下載連結失敗（/location 完成）：", e);
          await client.pushMessage(userId, { type: "text", text: "📦 已完成存檔，但 ZIP 生成失敗，可稍後再試。" });
        }
      } else {
        await client.pushMessage(userId, { type: "text", text: "✅ 已收到定位，請再上傳照片。" });
      }
    } catch (err) {
      console.error("❌ 寫定位失敗（/location）：", err);
    }
  }

  res.sendStatus(200);
});

/* ============ 啟動伺服器 ============ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  const base = getBaseUrl();
  if (base) {
    console.log(`🔗 ZIP 靜態下載根路徑：${base}/reports/<檔名>.zip`);
  } else {
    console.log("ℹ️ 建議設定 PUBLIC_BASE_URL（或用 Render 內建 RENDER_EXTERNAL_URL）以便在 Logs 顯示完整下載連結。");
  }
});
