const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const app = express();

// ✅ CORS 設定（允許來自 GitHub Pages 等前端）
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-Line-Signature"],
  })
);

// ✅ 解析 JSON（給 /location 用）
app.use(bodyParser.json());

// ✅ LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// ✅ 危險區域定義
const dangerZone = {
  lat: 25.01528,
  lng: 121.5474,
  radius: 500, // 公尺
};

// ✅ 儲存可推播的使用者與上次推播時間
const pushableUsers = new Map(); // userId => timestamp

// ======【新增】回報狀態管理（疑似蜜蜂 / 疑似蜂巢）======
// userId -> {
//   category: "疑似蜜蜂" | "疑似蜂巢",
//   reportDir: 絕對路徑（./疑似蜜蜂/20250808_181200_userId/）,
//   hasPhoto: boolean,
//   hasLocation: boolean
// }
const pendingReports = new Map();

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function startReport(event, category) {
  const userId = event.source?.userId;
  if (!userId) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "無法取得使用者資訊。",
    });
    return;
  }

  const baseDir = path.join(__dirname, category); // ./疑似蜜蜂 或 ./疑似蜂巢
  ensureDir(baseDir);

  const folder = `${ts()}_${userId}`;
  const reportDir = path.join(baseDir, folder);
  ensureDir(reportDir);

  // name.txt：LINE displayName
  try {
    const profile = await client.getProfile(userId);
    fs.writeFileSync(
      path.join(reportDir, "name.txt"),
      profile?.displayName ?? "",
      "utf8"
    );
  } catch {
    fs.writeFileSync(path.join(reportDir, "name.txt"), "", "utf8");
  }

  pendingReports.set(userId, {
    category,
    reportDir,
    hasPhoto: false,
    hasLocation: false,
  });

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `已建立「${category}」回報資料夾。\n請依序上傳：\n1) 一張照片\n2) 位置（LINE 位置訊息或由 LIFF 上報）`,
  });
}

function buildDownloadUrl(reportDir) {
  // 需要在 Render/環境變數設 PUBLIC_BASE_URL，如 https://your-app.onrender.com
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return null;
  return `${base}/report/download?dir=${encodeURIComponent(reportDir)}`;
}

async function finishIfReady(userId, replyToken) {
  const st = pendingReports.get(userId);
  if (!st) return false;
  if (st.hasPhoto && st.hasLocation) {
    pendingReports.delete(userId);
    const url = buildDownloadUrl(st.reportDir);
    const text =
      url
        ? `📦「${st.category}」已完成存檔（照片＋定位＋名稱）。\n點此下載整包 zip：\n${url}`
        : `📦「${st.category}」已完成存檔（照片＋定位＋名稱）。`;

    if (replyToken) {
      await client.replyMessage(replyToken, { type: "text", text });
    } else {
      await client.pushMessage(userId, { type: "text", text });
    }
    return true;
  }
  return false;
}

// ✅ webhook 處理訊息（啟用 / 關閉 追蹤 +【新增】回報流程）
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      try {
        if (event.type !== "message") continue;

        const userId = event.source?.userId;
        const msg = event.message;

        // ---- 文字：維持原有兩個指令；其餘不回覆 ----
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

          // 【新增】啟動回報
          if (text === "發現疑似蜜蜂" || text === "發現疑似蜂巢") {
            const category = text.includes("蜜蜂") ? "疑似蜜蜂" : "疑似蜂巢";
            await startReport(event, category);
            continue;
          }

          // 其它文字：維持原本「不回覆」的行為
          continue;
        }

        // ---- 圖片：只有在回報模式下才存，否則忽略（不影響原行為） ----
        if (msg.type === "image") {
          const st = pendingReports.get(userId);
          if (!st) continue;

          try {
            const stream = await client.getMessageContent(msg.id);
            const filePath = path.join(st.reportDir, "image.jpg");
            await new Promise((resolve, reject) => {
              const ws = fs.createWriteStream(filePath);
              stream.pipe(ws);
              stream.on("end", resolve);
              stream.on("error", reject);
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

        // ---- LINE 位置訊息：在回報模式下寫入 ----
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

        // 其它訊息型別：維持忽略
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

// ✅ 接收 LIFF 傳送位置資料（保留原有邏輯 +【新增】若在回報模式也寫入）
app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    console.warn("❌ 缺少欄位：", req.body);
    return res.status(400).send("Missing fields");
  }

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc);

  console.log(`📍 ${userId} 距離危險區：${distance.toFixed(2)}m`);

  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    const now = Date.now();
    const lastPushed = pushableUsers.get(userId) || 0;

    if (now - lastPushed >= 15 * 1000) {
      try {
        await client.pushMessage(userId, {
          type: "text",
          text: "⚠️ 警告：您已進入危險區域，請注意安全！",
        });
        console.log("✅ 推播成功");
        pushableUsers.set(userId, now);
      } catch (err) {
        console.error("❌ 推播失敗：", err.originalError?.response?.data || err);
      }
    } else {
      console.log("⏱️ 推播冷卻中，暫不重複通知");
    }
  }

  // 【新增】如果使用者正處於回報模式，把座標寫入 location.txt
  const st = pendingReports.get(userId);
  if (st) {
    try {
      const locStr = `${latitude},${longitude}`;
      fs.writeFileSync(path.join(st.reportDir, "location.txt"), locStr, "utf8");
      st.hasLocation = true;

      // 這裡沒有 replyToken，用 push 通知
      const url = buildDownloadUrl(st.reportDir);
      const done = st.hasPhoto && st.hasLocation;
      if (done) {
        pendingReports.delete(userId);
        const text =
          url
            ? `📦「${st.category}」已完成存檔（照片＋定位＋名稱）。\n點此下載整包 zip：\n${url}`
            : `📦「${st.category}」已完成存檔（照片＋定位＋名稱）。`;
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

// ======【新增】資料夾下載（zip）======
// 需要設定 PUBLIC_BASE_URL 才會在完成時回傳連結；此路由本身不影響原功能
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

// ✅ 啟動伺服器
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  if (process.env.PUBLIC_BASE_URL) {
    console.log(`⬇️ 下載 API：${process.env.PUBLIC_BASE_URL}/report/download?dir=<reportDir>`);
  }
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
