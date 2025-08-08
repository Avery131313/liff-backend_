// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const app = express();

/* ============ 基本設定 ============ */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-Line-Signature"],
  })
);
// 千萬不要在全域掛 JSON 解析，避免破壞 LINE 驗簽
// app.use(bodyParser.json());

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
// userId -> { category, reportDir, hasPhoto, hasLocation }
const pendingReports = new Map();

/* ============ 小工具 ============ */
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function buildDownloadUrl(reportDir) {
  const base = process.env.PUBLIC_BASE_URL; // e.g. https://your-app.onrender.com
  if (!base) return null;
  return `${base}/report/download?dir=${encodeURIComponent(reportDir)}`;
}

/* ============ 啟動回報：每次建立「顯示名稱版」資料夾 ============ */
async function startReport(event, category) {
  const userId = event.source?.userId;
  if (!userId) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "無法取得使用者資訊。",
    });
    return;
  }

  // 先拿顯示名稱，組資料夾名：YYYYMMDD_HHMMSS_顯示名稱
  let displayName = null;
  try {
    const profile = await client.getProfile(userId);
    displayName = (profile?.displayName || "").trim();
  } catch {
    // ignore — 取不到就用 userId
  }
  const safeName =
    (displayName && displayName.replace(/[\\/:*?"<>|]/g, "_").trim()) ||
    userId;

  // 父目錄：./疑似蜜蜂 或 ./疑似蜂巢
  const baseDir = path.join(__dirname, category);
  ensureDir(baseDir);

  // 最終資料夾：YYYYMMDD_HHMMSS_顯示名稱(或 userId)
  const folder = `${ts()}_${safeName}`;
  const reportDir = path.join(baseDir, folder);
  ensureDir(reportDir);

  // name.txt（仍然存真正顯示名稱；取不到就空字串）
  try {
    fs.writeFileSync(
      path.join(reportDir, "name.txt"),
      displayName ?? "",
      "utf8"
    );
  } catch (e) {
    console.error("寫入 name.txt 失敗：", e);
  }

  // 建立狀態
  pendingReports.set(userId, {
    category,
    reportDir,
    hasPhoto: false,
    hasLocation: false,
  });

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `已建立「${category}」回報資料夾：\n${folder}\n\n請依序上傳：\n1) 一張照片\n2) 位置（LINE 位置訊息或由 LIFF 上報）`,
  });
}

/* ============ 完成檢查 ============ */
async function finishIfReady(userId, replyToken) {
  const st = pendingReports.get(userId);
  if (!st) return false;

  if (st.hasPhoto && st.hasLocation) {
    pendingReports.delete(userId);

    const url = buildDownloadUrl(st.reportDir);
    const text = url
      ? `📦 已完成存檔（照片＋定位＋名稱）。\n點此打包下載：\n${url}`
      : `📦 已完成存檔（照片＋定位＋名稱）。`;

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
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "🔁 你已經啟用過追蹤通知。",
              });
            }
            continue;
          }

          if (text === "關閉追蹤") {
            pushableUsers.delete(userId);
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "🛑 你已關閉追蹤功能。",
            });
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
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "✅ 照片已儲存，請再分享定位。",
              });
            }
          } catch (err) {
            console.error("❌ 圖片存檔失敗：", err);
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "抱歉，圖片儲存失敗。",
            });
          }
          continue;
        }

        // 位置：在回報模式下寫入
        if (msg.type === "location") {
          const st = pendingReports.get(userId);
          if (!st) continue;

          try {
            const locStr = `${msg.latitude},${msg.longitude}`;
            fs.writeFileSync(
              path.join(st.reportDir, "location.txt"),
              locStr,
              "utf8"
            );
            st.hasLocation = true;

            const done = await finishIfReady(userId, event.replyToken);
            if (!done) {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "✅ 已收到定位，請再上傳照片。",
              });
            }
          } catch (err) {
            console.error("❌ 寫定位失敗：", err);
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "抱歉，儲存定位失敗。",
            });
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
        await client.pushMessage(userId, {
          type: "text",
          text: "⚠️ 警告：您已進入危險區域，請注意安全！",
        });
        pushableUsers.set(userId, now);
      } catch (err) {
        console.error("❌ 推播失敗：", err.originalError?.response?.data || err);
      }
    } else {
      console.log("⏱️ 推播冷卻中，暫不重複通知");
    }
  }

  // 新：回報模式→寫入 location.txt
  const st = pendingReports.get(userId);
  if (st) {
    try {
      const locStr = `${latitude},${longitude}`;
      fs.writeFileSync(path.join(st.reportDir, "location.txt"), locStr, "utf8");
      st.hasLocation = true;

      const url = buildDownloadUrl(st.reportDir);
      const done = st.hasPhoto && st.hasLocation;
      if (done) {
        pendingReports.delete(userId);
        const text = url
          ? `📦 已完成存檔（照片＋定位＋名稱）。\n點此打包下載：\n${url}`
          : `📦 已完成存檔（照片＋定位＋名稱）。`;
        await client.pushMessage(userId, { type: "text", text });
      } else {
        await client.pushMessage(userId, {
          type: "text",
          text: "✅ 已收到定位，請再上傳照片。",
        });
      }
    } catch (err) {
      console.error("❌ 寫定位失敗（/location）：", err);
    }
  }

  res.sendStatus(200);
});

/* ============ ZIP 下載 ============ */
app.get("/report/download", async (req, res) => {
  try {
    const dir = req.query.dir;
    if (!dir) return res.status(400).send("Missing dir");

    const abs = path.resolve(dir);
    if (!abs.startsWith(path.resolve(__dirname)))
      return res.status(403).send("Forbidden");

    if (!fs.existsSync(abs) || !fs.lstatSync(abs).isDirectory())
      return res.status(404).send("Not found");

    const zipName = path.basename(abs) + ".zip";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.directory(abs, false);
    archive.on("error", (err) => {
      throw err;
    });
    archive.pipe(res);
    await archive.finalize();
  } catch (e) {
    console.error("download error:", e);
    if (!res.headersSent) res.status(500).send("Server error");
  }
});

/* ============ 啟動伺服器 ============ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  if (process.env.PUBLIC_BASE_URL) {
    console.log(
      `⬇️ 下載 API：${process.env.PUBLIC_BASE_URL}/report/download?dir=<reportDir>`
    );
  }
});

