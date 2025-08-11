// server.js － Render
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const os = require("os");
const axios = require("axios");

const app = express();

/* 基本設定 */
app.use(cors({ origin: "*", methods: ["GET","POST"], allowedHeaders: ["Content-Type","X-Line-Signature"] }));

/* 可下載目錄 */
const REPORTS_DIR = path.join(os.tmpdir(), "reports");
fs.mkdirSync(REPORTS_DIR, { recursive: true });
app.use("/reports", express.static(REPORTS_DIR, { fallthrough: false }));

/* LINE Bot */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

/* 危險區 */
const dangerZone = { lat: 25.01528, lng: 121.5474, radius: 500 };
const pushableUsers = new Map(); // userId => lastTs

/* 回報暫存 */
const pendingReports = new Map(); // userId -> { category, reportDir, hasPhoto, hasLocation, folderName, displayName }

/* 工具 */
function ts() {
  const d = new Date(); const p = (n)=>String(n).padStart(2,"0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function ensureDir(d){ try{ fs.mkdirSync(d,{recursive:true}); }catch{} }
function getBaseUrl(){ return process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || ""; }

/* 壓 ZIP 並回傳公開下載連結 */
async function zipToPublic(reportDir, zipBaseName) {
  const safeBase = (zipBaseName || "report").replace(/[\\/:*?"<>|]/g, "_");
  const zipFilename = `${safeBase}.zip`;
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
  const url = (base ? base : "") + `/reports/${encoded}`;
  console.log("✅ ZIP created:", zipPath);
  console.log("🔗 後台下載連結：", url);
  return url;
}

/* 通知你的本機下載器 */
async function notifyDownloadAgent({ url, filename, category }) {
  const hook = process.env.DOWNLOAD_WEBHOOK_URL; // 例: https://xxxx.ngrok.io/hook
  if (!hook) return;
  try {
    await axios.post(hook, { url, filename, category }, {
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": process.env.DOWNLOAD_WEBHOOK_TOKEN || ""
      },
      timeout: 10000
    });
    console.log("📨 已通知本機下載器：", hook);
  } catch (e) {
    console.error("❌ 通知本機下載器失敗：", e?.response?.status, e?.response?.data || e.message);
  }
}

/* 啟動回報 */
async function startReport(event, category) {
  const userId = event.source?.userId;
  if (!userId) {
    await client.replyMessage(event.replyToken, { type: "text", text: "無法取得使用者資訊。" });
    return;
  }
  // 顯示名稱
  let displayName=""; 
  try { const p=await client.getProfile(userId); displayName=(p?.displayName||"").trim(); } catch {}
  const safeName = (displayName && displayName.replace(/[\\/:*?"<>|]/g,"_").trim()) || userId;
  // 本地資料夾
  const baseDir = path.join(__dirname, category); ensureDir(baseDir);
  const folderName = `${ts()}_${safeName}`;
  const reportDir = path.join(baseDir, folderName); ensureDir(reportDir);
  // name.txt
  try { fs.writeFileSync(path.join(reportDir,"name.txt"), displayName, "utf8"); } catch {}
  // 狀態
  pendingReports.set(userId, { category, reportDir, hasPhoto:false, hasLocation:false, folderName, displayName });
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `已建立回報，請依序上傳：1) 照片 2) 位置`
  });
}

async function finishIfReady(userId, replyToken) {
  const st = pendingReports.get(userId);
  if (!st) return false;
  if (st.hasPhoto && st.hasLocation) {
    pendingReports.delete(userId);
    try {
      const url = await zipToPublic(st.reportDir, st.folderName);
      await notifyDownloadAgent({ url, filename: `${st.folderName}.zip`, category: st.category });
    } catch (e) {
      console.error("壓縮/通知失敗：", e);
    }
    const text = `📦已完成存檔。`;
    if (replyToken) await client.replyMessage(replyToken, { type:"text", text });
    else await client.pushMessage(userId, { type:"text", text });
    return true;
  }
  return false;
}

/* webhook */
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    for (const event of events) {
      try {
        if (event.type !== "message") continue;
        const userId = event.source?.userId;
        const msg = event.message;

        if (msg.type === "text") {
          const text = (msg.text||"").trim();
          if (text === "開啟追蹤") {
            if (!pushableUsers.has(userId)) {
              pushableUsers.set(userId, 0);
              await client.replyMessage(event.replyToken, { type:"text", text:"✅ 你已成功啟用追蹤通知，請打開連結開始定位。" });
            } else {
              await client.replyMessage(event.replyToken, { type:"text", text:"🔁 你已經啟用過追蹤通知。" });
            }
            continue;
          }
          if (text === "關閉追蹤") {
            pushableUsers.delete(userId);
            await client.replyMessage(event.replyToken, { type:"text", text:"🛑 你已關閉追蹤功能。" });
            continue;
          }
          if (text === "發現疑似蜜蜂" || text === "發現疑似蜂巢") {
            const category = text.includes("蜜蜂") ? "疑似蜜蜂" : "疑似蜂巢";
            await startReport(event, category);
            continue;
          }
          continue; // 其他文字不回覆
        }

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
            if (!done) await client.replyMessage(event.replyToken, { type:"text", text:"✅ 照片已儲存，請再分享定位。" });
          } catch (err) {
            console.error("❌ 圖片存檔失敗：", err);
            await client.replyMessage(event.replyToken, { type:"text", text:"抱歉，圖片儲存失敗。" });
          }
          continue;
        }

        if (msg.type === "location") {
          const st = pendingReports.get(userId);
          if (!st) continue;
          try {
            const locStr = `${msg.latitude},${msg.longitude}`;
            fs.writeFileSync(path.join(st.reportDir,"location.txt"), locStr, "utf8");
            st.hasLocation = true;
            const done = await finishIfReady(userId, event.replyToken);
            if (!done) await client.replyMessage(event.replyToken, { type:"text", text:"✅ 已收到定位，請再上傳照片。" });
          } catch (err) {
            console.error("❌ 寫定位失敗：", err);
            await client.replyMessage(event.replyToken, { type:"text", text:"抱歉，儲存定位失敗。" });
          }
          continue;
        }
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

/* /location（只在這條掛 JSON 解析） */
app.post("/location", bodyParser.json(), async (req, res) => {
  const { userId, latitude, longitude } = req.body;
  if (!userId || !latitude || !longitude) return res.status(400).send("Missing fields");

  // 危險區推播 + 15 秒冷卻（原功能）
  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc);
  console.log(`📍 ${userId} 距離危險區：${distance.toFixed(2)}m`);
  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    const now = Date.now(); const last = pushableUsers.get(userId) || 0;
    if (now - last >= 15*1000) {
      try {
        await client.pushMessage(userId, { type:"text", text:"⚠️ 警告：您已進入危險區域，請注意安全！" });
        pushableUsers.set(userId, now);
      } catch (err) { console.error("❌ 推播失敗：", err.originalError?.response?.data || err); }
    } else {
      console.log("⏱️ 冷卻中，暫不重複通知");
    }
  }

  const st = pendingReports.get(userId);
  if (st) {
    try {
      fs.writeFileSync(path.join(st.reportDir,"location.txt"), `${latitude},${longitude}`, "utf8");
      st.hasLocation = true;
      if (st.hasPhoto && st.hasLocation) {
        pendingReports.delete(userId);
        try {
          const url = await zipToPublic(st.reportDir, st.folderName);
          await notifyDownloadAgent({ url, filename:`${st.folderName}.zip`, category: st.category });
          await client.pushMessage(userId, { type:"text", text:`📦已完成存檔。` });
        } catch (e) {
          console.error("壓縮/通知失敗（/location 完成）：", e);
          await client.pushMessage(userId, { type:"text", text:"📦 已完成存檔，但 ZIP 生成失敗，可稍後再試。" });
        }
      } else {
        await client.pushMessage(userId, { type:"text", text:"✅ 已收到定位，請再上傳照片。" });
      }
    } catch (e) { console.error("❌ 寫定位失敗（/location）：", e); }
  }
  res.sendStatus(200);
});

/* 啟動 */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  const base = getBaseUrl();
  if (base) console.log(`🔗 ZIP 下載根：${base}/reports/<檔名>.zip`);
  else console.log("ℹ️ 建議設定 PUBLIC_BASE_URL 或使用 RENDER_EXTERNAL_URL。");
});
