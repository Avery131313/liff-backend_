const express = require("express");
const cors = require("cors");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");
const { google } = require("googleapis");
const { Readable } = require("stream");

const app = express();

/* ---------- 基本設定 ---------- */
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type", "X-Line-Signature"] }));

/* ---------- LINE 設定 ---------- */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ---------- 危險區與推播暫存（原功能保留） ---------- */
const dangerZone = { lat: 25.01528, lng: 121.5474, radius: 500 };
const pushableUsers = new Map(); // userId => lastTs

/* ---------- Google OAuth 設定（取代 Service Account） ---------- */
const GDRIVE_CLIENT_ID = process.env.GDRIVE_CLIENT_ID;
const GDRIVE_CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET;
const GDRIVE_REDIRECT = process.env.GDRIVE_REDIRECT; // e.g. https://your-app.onrender.com/oauth2callback
let GDRIVE_REFRESH_TOKEN = process.env.GDRIVE_REFRESH_TOKEN; // 取得後填進環境變數

const oauth2Client = new google.auth.OAuth2(GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REDIRECT);

/* 供 Drive 用的 Auth */
function getOAuthDrive() {
  if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET || !GDRIVE_REDIRECT)
    throw new Error("Missing GDRIVE_CLIENT_ID/SECRET/REDIRECT");

  if (!GDRIVE_REFRESH_TOKEN) throw new Error("GDRIVE_REFRESH_TOKEN not set. Visit /oauth/init to authorize.");

  oauth2Client.setCredentials({ refresh_token: GDRIVE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth: oauth2Client });
}

/* 取得 OAuth 授權網址（一次性） */
app.get("/oauth/init", (req, res) => {
  try {
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/drive.file"],
    });
    res.send(`<a href="${url}" target="_blank">到 Google 授權</a>`);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

/* OAuth 回調，顯示 refresh token（複製貼到 Render 環境變數後重佈署） */
app.get("/oauth2callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Missing code");
    const { tokens } = await oauth2Client.getToken(String(code));
    // tokens.refresh_token 只會在首次 consent 回來，之後同一帳號不一定再給
    GDRIVE_REFRESH_TOKEN = tokens.refresh_token || GDRIVE_REFRESH_TOKEN;
    res.send(`<h3>取得成功</h3><p>請把下面這串 refresh token 貼到 Render 的 <b>GDRIVE_REFRESH_TOKEN</b> 環境變數，並重新部署。</p>
<pre style="white-space:pre-wrap">${GDRIVE_REFRESH_TOKEN || "(未回傳 refresh_token，請在同意畫面選「允許存取」並確保 prompt=consent）"}</pre>`);
  } catch (e) {
    res.status(500).send("OAuth error: " + String(e));
  }
});

/* ---------- Drive 輔助 ---------- */
const BEE_FOLDER_ID = process.env.BEE_FOLDER_ID;
const HIVE_FOLDER_ID = process.env.HIVE_FOLDER_ID;

function toReadable(body) {
  if (body == null) return Readable.from(Buffer.from(""));
  if (Buffer.isBuffer(body)) return Readable.from(body);
  if (typeof body === "string") return Readable.from(body);
  if (typeof body.pipe === "function") return body; // already stream
  return Readable.from(String(body));
}

async function createDriveFolder(parentId, name) {
  const drive = getOAuthDrive();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id,name",
    supportsAllDrives: true,
  });
  return res.data; // {id,name}
}

async function uploadToDrive(folderId, fileName, mimeType, body) {
  const drive = getOAuthDrive();
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: toReadable(body) },
    fields: "id,name",
    supportsAllDrives: true,
  });
  return res.data;
}

async function makeFilePublic(fileId) {
  const drive = getOAuthDrive();
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
    supportsAllDrives: true,
  });
  const f = await drive.files.get({
    fileId,
    fields: "webViewLink",
    supportsAllDrives: true,
  });
  return f.data.webViewLink;
}

/* 啟動時自檢：資料夾存在 & 可寫（若還沒設 refresh token，略過檢查） */
async function validateDriveAccess() {
  if (!BEE_FOLDER_ID || !HIVE_FOLDER_ID) throw new Error("BEE_FOLDER_ID/HIVE_FOLDER_ID missing");
  if (!GDRIVE_REFRESH_TOKEN) {
    console.warn("⚠️ 尚未設定 GDRIVE_REFRESH_TOKEN，先完成 /oauth/init 授權流程再說。");
    return;
  }
  const drive = getOAuthDrive();
  for (const [label, folderId] of [
    ["BEE_FOLDER_ID", BEE_FOLDER_ID],
    ["HIVE_FOLDER_ID", HIVE_FOLDER_ID],
  ]) {
    await drive.files.get({ fileId: folderId, fields: "id,name", supportsAllDrives: true });
    const tmp = await drive.files.create({
      requestBody: { name: `__probe_${Date.now()}.txt`, parents: [folderId] },
      media: { mimeType: "text/plain", body: Readable.from("ok") },
      fields: "id",
      supportsAllDrives: true,
    });
    await drive.files.delete({ fileId: tmp.data.id, supportsAllDrives: true });
    console.log(`✅ Drive access OK for ${label}`);
  }
}

/* ---------- 回報流程暫存 ---------- */
// userId => { category, driveFolderId, folderLink, hasPhoto, hasLocation }
const pendingReports = new Map();

const ts = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

async function startReport(event, category) {
  const userId = event.source?.userId;
  if (!userId) {
    await client.replyMessage(event.replyToken, { type: "text", text: "無法取得使用者資訊。" });
    return;
  }
  if (!BEE_FOLDER_ID || !HIVE_FOLDER_ID) {
    await client.replyMessage(event.replyToken, { type: "text", text: "伺服器未設定雲端資料夾 ID。" });
    return;
  }

  const parentId = category === "疑似蜜蜂" ? BEE_FOLDER_ID : HIVE_FOLDER_ID;
  const folderName = `${ts()}_${userId}`;
  const folder = await createDriveFolder(parentId, folderName);
  const folderLink = await makeFilePublic(folder.id);

  // name.txt
  try {
    const profile = await client.getProfile(userId);
    await uploadToDrive(folder.id, "name.txt", "text/plain", Buffer.from(profile?.displayName ?? "", "utf8"));
  } catch {
    await uploadToDrive(folder.id, "name.txt", "text/plain", Buffer.from("", "utf8"));
  }

  pendingReports.set(userId, { category, driveFolderId: folder.id, folderLink, hasPhoto: false, hasLocation: false });

  // 立即回覆（避免 replyToken 逾時）
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
    if (replyToken) await client.replyMessage(replyToken, { type: "text", text });
    else await client.pushMessage(userId, { type: "text", text });
    return true;
  }
  return false;
}

/* ---------- Webhook（raw body 驗簽） ---------- */
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

          if (msg.type === "text") {
            const text = (msg.text || "").trim();
            if (text === "開啟追蹤") {
              if (!pushableUsers.has(userId)) {
                pushableUsers.set(userId, 0);
                await client.replyMessage(event.replyToken, { type: "text", text: "✅ 你已成功啟用追蹤通知，請開啟 LIFF 畫面開始定位。" });
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
            continue; // 其它文字不回覆
          }

          if (msg.type === "image") {
            const st = pendingReports.get(userId);
            if (!st) continue;
            try {
              const stream = await client.getMessageContent(msg.id); // Readable
              await uploadToDrive(st.driveFolderId, "image.jpg", "image/jpeg", stream);
              st.hasPhoto = true;

              const done = await finishIfReady(userId, event.replyToken);
              if (!done) {
                await client.replyMessage(event.replyToken, { type: "text", text: "✅ 照片已上傳雲端，請再分享定位。" });
              }
            } catch (err) {
              console.error("❌ 圖片上傳失敗：", err.response?.data || err);
              await client.replyMessage(event.replyToken, { type: "text", text: "抱歉，圖片上傳失敗。" });
            }
            continue;
          }

          if (msg.type === "location") {
            const st = pendingReports.get(userId);
            if (!st) continue;
            try {
              const locStr = `${msg.latitude},${msg.longitude}`;
              await uploadToDrive(st.driveFolderId, "location.txt", "text/plain", Buffer.from(locStr, "utf8"));
              st.hasLocation = true;

              const done = await finishIfReady(userId, event.replyToken);
              if (!done) {
                await client.replyMessage(event.replyToken, { type: "text", text: "✅ 已收到定位（已上傳雲端），請再上傳照片。" });
              }
            } catch (err) {
              console.error("❌ 位置上傳失敗：", err.response?.data || err);
              await client.replyMessage(event.replyToken, { type: "text", text: "抱歉，儲存定位失敗。" });
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
  }
);

/* ---------- /location（原功能 + 雲端定位） ---------- */
app.post("/location", express.json(), async (req, res) => {
  const { userId, latitude, longitude } = req.body;
  if (!userId || !latitude || !longitude) return res.status(400).send("Missing fields");

  // 危險區推播
  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc);
  console.log(`📍 ${userId} 距離危險區：${distance.toFixed(2)}m`);
  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    const now = Date.now(), last = pushableUsers.get(userId) || 0;
    if (now - last >= 15 * 1000) {
      try {
        await client.pushMessage(userId, { type: "text", text: "⚠️ 警告：您已進入危險區域，請注意安全！" });
        pushableUsers.set(userId, now);
      } catch (err) {
        console.error("❌ 推播失敗：", err.originalError?.response?.data || err);
      }
    }
  }

  // 回報模式：寫入 location.txt
  const st = pendingReports.get(userId);
  if (st) {
    try {
      const locStr = `${latitude},${longitude}`;
      await uploadToDrive(st.driveFolderId, "location.txt", "text/plain", Buffer.from(locStr, "utf8"));
      st.hasLocation = true;

      const done = st.hasPhoto && st.hasLocation;
      if (done) {
        pendingReports.delete(userId);
        await client.pushMessage(userId, { type: "text", text: `📦「${st.category}」已完成存檔（照片＋定位＋名稱）。\n雲端資料夾：${st.folderLink}` });
      } else {
        await client.pushMessage(userId, { type: "text", text: "✅ 已收到定位（已上傳雲端），請再上傳照片。" });
      }
    } catch (err) {
      console.error("❌ 位置上傳失敗（/location）：", err.response?.data || err);
    }
  }

  res.sendStatus(200);
});

/* ---------- 啟動 & 自檢 ---------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  try {
    await validateDriveAccess();
    console.log("🟢 Google Drive ready.");
  } catch (e) {
    console.error("🔴 Drive setup/permission problem:", e.response?.data || e);
    console.error("請先到 /oauth/init 完成授權並取得 refresh token，或檢查資料夾 ID 是否正確。");
  }
});
