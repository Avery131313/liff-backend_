const express = require("express");
const cors = require("cors");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");
const fs = require("fs"); // 只剩零星用途
const path = require("path");
const { google } = require("googleapis");

const app = express();

// ✅ CORS（不會改動 body）
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-Line-Signature"],
  })
);

// ===== LINE 基本設定 =====
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// ===== 危險區域 & 推播暫存（沿用你的原功能） =====
const dangerZone = { lat: 25.01528, lng: 121.5474, radius: 500 };
const pushableUsers = new Map(); // userId => lastTs

// ===== Google Drive：服務帳號、根資料夾 =====
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT; // 服務帳號 JSON 內容（整段放進 env）
const BEE_FOLDER_ID = process.env.BEE_FOLDER_ID;   // Drive 上的「疑似蜜蜂」資料夾ID
const HIVE_FOLDER_ID = process.env.HIVE_FOLDER_ID; // Drive 上的「疑似蜂巢」資料夾ID

function getDriveClient() {
  if (!SERVICE_ACCOUNT_JSON || !BEE_FOLDER_ID || !HIVE_FOLDER_ID) {
    console.error("❌ 缺少 GOOGLE_DRIVE_SERVICE_ACCOUNT / BEE_FOLDER_ID / HIVE_FOLDER_ID");
  }
  const credentials = JSON.parse(SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return google.drive({ version: "v3", auth });
}

async function createDriveFolder(parentId, name) {
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id, name",
  });
  return res.data; // { id, name }
}

async function uploadToDrive(folderId, fileName, mimeType, bodyStreamOrBuffer) {
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: bodyStreamOrBuffer,
    },
    fields: "id, name",
  });
  return res.data; // { id, name }
}

async function makeFilePublic(fileId) {
  const drive = getDriveClient();
  // 設定任何人可讀
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });
  const f = await drive.files.get({
    fileId,
    fields: "webViewLink, webContentLink",
  });
  return f.data.webViewLink; // 可瀏覽的連結（資料夾/檔案）
}

// ===== 回報流程暫存 =====
// userId => { category: '疑似蜜蜂'|'疑似蜂巢', driveFolderId, folderLink, hasPhoto, hasLocation }
const pendingReports = new Map();

const ts = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

async function startReport(event, category) {
  const userId = event.source?.userId;
  if (!userId) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "無法取得使用者資訊。",
    });
    return;
  }

  // 在對應的雲端父資料夾下建立一個子資料夾（時間戳_使用者ID）
  const parentId = category === "疑似蜜蜂" ? BEE_FOLDER_ID : HIVE_FOLDER_ID;
  const folderName = `${ts()}_${userId}`;
  const folder = await createDriveFolder(parentId, folderName);

  // 讓資料夾可分享（取得連結）
  const folderLink = await makeFilePublic(folder.id);

  // name.txt：LINE displayName
  try {
    const profile = await client.getProfile(userId);
    const nameBuf = Buffer.from(profile?.displayName ?? "", "utf8");
    await uploadToDrive(folder.id, "name.txt", "text/plain", nameBuf);
  } catch {
    await uploadToDrive(folder.id, "name.txt", "text/plain", Buffer.from("", "utf8"));
  }

  // 建立狀態
  pendingReports.set(userId, {
    category,
    driveFolderId: folder.id,
    folderLink,
    hasPhoto: false,
    hasLocation: false,
  });

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `已建立「${category}」回報資料夾（雲端）。\n請依序上傳：\n1) 一張照片\n2) 位置（LINE 位置訊息或由 LIFF 上報）\n📂 資料夾連結：${folderLink}`,
  });
}

async function finishIfReady(userId, replyToken) {
  const st = pendingReports.get(userId);
  if (!st) return false;
  if (st.hasPhoto && st.hasLocation) {
    pendingReports.delete(userId);
    const text = `📦「${st.category}」已完成存檔（照片＋定位＋名稱）。\n雲端資料夾：${st.folderLink}`;
    if (replyToken) {
      await client.replyMessage(replyToken, { type: "text", text });
    } else {
      await client.pushMessage(userId, { type: "text", text });
    }
    return true;
  }
  return false;
}

// ========== Webhook：必須是 raw body，才能通過 LINE 驗簽 ==========
app.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  line.middleware(config),
  async (req, res) => {
    try {
      const events = req.body.events || [];
      for (const event of events) {
        try {
          if (event.type !== "message") continue;

          const userId = event.source?.userId;
          const msg = event.message;

          // ---- 文字：原有兩個指令；其餘不回覆 ----
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

            // 【新增】啟動回報（雲端）
            if (text === "發現疑似蜜蜂" || text === "發現疑似蜂巢") {
              const category = text.includes("蜜蜂") ? "疑似蜜蜂" : "疑似蜂巢";
              await startReport(event, category);
              continue;
            }

            // 其它文字：維持不回覆
            continue;
          }

          // ---- 圖片：僅回報模式→直接上傳到 Google Drive ----
          if (msg.type === "image") {
            const st = pendingReports.get(userId);
            if (!st) continue;

            try {
              const stream = await client.getMessageContent(msg.id);
              // 直接把 LINE 的 stream 丟給 Google API（可接受 stream）
              await uploadToDrive(st.driveFolderId, "image.jpg", "image/jpeg", stream);

              st.hasPhoto = true;
              const done = await finishIfReady(userId, event.replyToken);
              if (!done) {
                await client.replyMessage(event.replyToken, {
                  type: "text",
                  text: "✅ 照片已上傳雲端，請再分享定位。",
                });
              }
            } catch (err) {
              console.error("❌ 圖片上傳失敗：", err);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "抱歉，圖片上傳失敗。",
              });
            }
            continue;
          }

          // ---- LINE 位置訊息：回報模式→上傳 location.txt ----
          if (msg.type === "location") {
            const st = pendingReports.get(userId);
            if (!st) continue;

            try {
              const locStr = `${msg.latitude},${msg.longitude}`;
              const buf = Buffer.from(locStr, "utf8");
              await uploadToDrive(st.driveFolderId, "location.txt", "text/plain", buf);

              st.hasLocation = true;
              const done = await finishIfReady(userId, event.replyToken);
              if (!done) {
                await client.replyMessage(event.replyToken, {
                  type: "text",
                  text: "✅ 已收到定位（已上傳雲端），請再上傳照片。",
                });
              }
            } catch (err) {
              console.error("❌ 位置上傳失敗：", err);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "抱歉，儲存定位失敗。",
              });
            }
            continue;
          }

          // 其他型別：忽略
        } catch (e) {
          console.error("❌ webhook 單一事件錯誤：", e);
        }
      }
      res.sendStatus(200);
    } catch (err) {
      console.error("❌ webhook 處理錯誤：", err);
      res.sendStatus(200);
    }
  }
);

// ========== /location：只在這條掛 JSON 解析；同時維持你原本的危險區推播 ==========
app.post("/location", express.json(), async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    console.warn("❌ 缺少欄位：", req.body);
    return res.status(400).send("Missing fields");
  }

  // 原功能：危險區推播 + 15 秒冷卻
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
        console.log("✅ 推播成功");
      } catch (err) {
        console.error("❌ 推播失敗：", err.originalError?.response?.data || err);
      }
    } else {
      console.log("⏱️ 推播冷卻中，暫不重複通知");
    }
  }

  // 回報模式：把定位上傳到雲端
  const st = pendingReports.get(userId);
  if (st) {
    try {
      const locStr = `${latitude},${longitude}`;
      const buf = Buffer.from(locStr, "utf8");
      await uploadToDrive(st.driveFolderId, "location.txt", "text/plain", buf);

      st.hasLocation = true;
      const done = st.hasPhoto && st.hasLocation;
      if (done) {
        pendingReports.delete(userId);
        await client.pushMessage(userId, {
          type: "text",
          text: `📦「${st.category}」已完成存檔（照片＋定位＋名稱）。\n雲端資料夾：${st.folderLink}`,
        });
      } else {
        await client.pushMessage(userId, {
          type: "text",
          text: "✅ 已收到定位（已上傳雲端），請再上傳照片。",
        });
      }
    } catch (err) {
      console.error("❌ 位置上傳失敗（/location）：", err);
    }
  }

  res.sendStatus(200);
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
