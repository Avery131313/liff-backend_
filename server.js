// server.js
const express = require("express");
const cors = require("cors");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");
const { google } = require("googleapis");

const app = express();

/* ========================= 基本設定 ========================= */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-Line-Signature"],
  })
);

// LINE Bot
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// 危險區與推播暫存（保留原功能）
const dangerZone = { lat: 25.01528, lng: 121.5474, radius: 500 };
const pushableUsers = new Map(); // userId => lastTs

/* ========================= Google Drive ========================= */
/** 必填環境變數：GOOGLE_DRIVE_SERVICE_ACCOUNT（JSON 或 base64）、BEE_FOLDER_ID、HIVE_FOLDER_ID */
const BEE_FOLDER_ID = process.env.BEE_FOLDER_ID;
const HIVE_FOLDER_ID = process.env.HIVE_FOLDER_ID;

function loadServiceAccount() {
  const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("GOOGLE_DRIVE_SERVICE_ACCOUNT is missing");

  // 先嘗試 JSON
  try {
    return JSON.parse(raw);
  } catch {}

  // 再嘗試 base64 -> JSON
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    throw new Error(
      "Invalid GOOGLE_DRIVE_SERVICE_ACCOUNT: not valid JSON or base64 JSON"
    );
  }
}

function getDriveClient() {
  const credentials = loadServiceAccount();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return google.drive({ version: "v3", auth });
}

async function createDriveFolder(parentId, name) {
  try {
    const drive = getDriveClient();
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id,name",
      supportsAllDrives: true,
    });
    return res.data; // { id, name }
  } catch (e) {
    console.error("❌ createDriveFolder error:", e.response?.data || e);
    throw e;
  }
}

async function uploadToDrive(folderId, fileName, mimeType, body) {
  try {
    const drive = getDriveClient();
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body },
      fields: "id,name",
      supportsAllDrives: true,
    });
    return res.data; // { id, name }
  } catch (e) {
    console.error("❌ uploadToDrive error:", e.response?.data || e);
    throw e;
  }
}

async function makeFilePublic(fileId) {
  try {
    const drive = getDriveClient();
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
  } catch (e) {
    console.error("❌ makeFilePublic error:", e.response?.data || e);
    throw e;
  }
}

/** 啟動時自檢：確認資料夾存在且可寫入（建立→刪除一個測試檔） */
async function validateDriveAccess() {
  if (!BEE_FOLDER_ID || !HIVE_FOLDER_ID) {
    throw new Error("BEE_FOLDER_ID / HIVE_FOLDER_ID is missing");
  }
  const drive = getDriveClient();
  for (const [label, folderId] of [
    ["BEE_FOLDER_ID", BEE_FOLDER_ID],
    ["HIVE_FOLDER_ID", HIVE_FOLDER_ID],
  ]) {
    // 看得到
    await drive.files.get({
      fileId: folderId,
      fields: "id,name",
      supportsAllDrives: true,
    });

    // 可寫入（寫一個 temp 檔，再刪掉）
    const tmp = await drive.files.create({
      requestBody: { name: `__probe_${Date.now()}.txt`, parents: [folderId] },
      media: { mimeType: "text/plain", body: Buffer.from("ok") },
      fields: "id",
      supportsAllDrives: true,
    });
    await drive.files.delete({ fileId: tmp.data.id, supportsAllDrives: true });
    console.log(`✅ Drive access OK for ${label}`);
  }
}

/* ========================= 回報流程暫存 ========================= */
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

  const parentId = category === "疑似蜜蜂" ? BEE_FOLDER_ID : HIVE_FOLDER_ID;
  const folderName = `${ts()}_${userId}`;
  const folder = await createDriveFolder(parentId, folderName);
  const folderLink = await makeFilePublic(folder.id);

  // name.txt
  try {
    const profile = await client.getProfile(userId);
    await uploadToDrive(
      folder.id,
      "name.txt",
      "text/plain",
      Buffer.from(profile?.displayName ?? "", "utf8")
    );
  } catch {
    await uploadToDrive(folder.id, "name.txt", "text/plain", Buffer.from("", "utf8"));
  }

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

/* ========================= Webhook（raw body 驗簽） ========================= */
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

            // 其它文字：維持不回覆
            continue;
          }

          // 圖片：回報模式→直接上傳 Drive
          if (msg.type === "image") {
            const st = pendingReports.get(userId);
            if (!st) continue;

            try {
              const stream = await client.getMessageContent(msg.id);
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
              console.error("❌ 圖片上傳失敗：", err.response?.data || err);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "抱歉，圖片上傳失敗。",
              });
            }
            continue;
          }

          // 位置：回報模式→上傳 location.txt
          if (msg.type === "location") {
            const st = pendingReports.get(userId);
            if (!st) continue;

            try {
              const locStr = `${msg.latitude},${msg.longitude}`;
              await uploadToDrive(
                st.driveFolderId,
                "location.txt",
                "text/plain",
                Buffer.from(locStr, "utf8")
              );
              st.hasLocation = true;

              const done = await finishIfReady(userId, event.replyToken);
              if (!done) {
                await client.replyMessage(event.replyToken, {
                  type: "text",
                  text: "✅ 已收到定位（已上傳雲端），請再上傳照片。",
                });
              }
            } catch (err) {
              console.error("❌ 位置上傳失敗：", err.response?.data || err);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "抱歉，儲存定位失敗。",
              });
            }
            continue;
          }

          // 其它型別：忽略
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

/* ========================= /location（原功能+雲端定位） ========================= */
app.post("/location", express.json(), async (req, res) => {
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
        console.log("✅ 推播成功");
      } catch (err) {
        console.error("❌ 推播失敗：", err.originalError?.response?.data || err);
      }
    } else {
      console.log("⏱️ 推播冷卻中，暫不重複通知");
    }
  }

  // 新：回報模式→上傳定位
  const st = pendingReports.get(userId);
  if (st) {
    try {
      const locStr = `${latitude},${longitude}`;
      await uploadToDrive(
        st.driveFolderId,
        "location.txt",
        "text/plain",
        Buffer.from(locStr, "utf8")
      );
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
      console.error("❌ 位置上傳失敗（/location）：", err.response?.data || err);
    }
  }

  res.sendStatus(200);
});

/* ========================= 啟動 & 啟動前自檢 ========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);

  try {
    // 啟動時先檢查 Drive 設定與權限
    await validateDriveAccess();
    console.log("🟢 Google Drive folders are accessible & writable.");
  } catch (e) {
    console.error("🔴 Drive setup/permission problem:", e.response?.data || e);
    console.error(
      "請檢查：1) GOOGLE_DRIVE_SERVICE_ACCOUNT JSON 是否正確；2) BEE_FOLDER_ID/HIVE_FOLDER_ID 是否正確的資料夾 ID；3) 服務帳號 email 是否有資料夾『編輯者』權限。"
    );
  }
});

