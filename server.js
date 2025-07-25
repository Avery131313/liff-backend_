const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// 只給 /location 使用 json parser
app.use("/location", bodyParser.json());

// ✅ 儲存已啟用推播的 userId
const pushableUsers = new Set();
// ✅ 儲存每個使用者上次推播時間（防止狂刷）
const lastAlertTimeMap = new Map();

// ✅ webhook for LINE 記錄 userId
app.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  (req, res, next) => {
    req.rawBody = req.body;
    next();
  },
  line.middleware(config),
  async (req, res) => {
    try {
      for (const event of req.body.events) {
        if (event.type === "message" && event.source?.userId) {
          const userId = event.source.userId;
          pushableUsers.add(userId);
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "✅ 你已啟用定位通知功能！請開啟 LIFF 開始追蹤",
          });
        }
      }
      res.sendStatus(200);
    } catch (err) {
      console.error("Webhook error", err);
      res.sendStatus(500);
    }
  }
);

// ✅ 危險區域座標
const dangerZone = {
  lat: 25.01845,
  lng: 121.54274,
  radius: 5, // 公尺
};

// ✅ 處理位置上傳
app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;
  if (!userId || !latitude || !longitude) return res.status(400).send("Missing fields");

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc);

  console.log(`🛰️ ${userId} 距離危險區 ${distance.toFixed(2)}m`);

  const now = Date.now();
  const lastTime = lastAlertTimeMap.get(userId) || 0;

  if (
    distance <= dangerZone.radius &&
    pushableUsers.has(userId) &&
    now - lastTime >= 3 * 60 * 1000 // 3 分鐘
  ) {
    try {
      await client.pushMessage(userId, {
        type: "text",
        text: "⚠️ 您已進入危險區域！請注意安全",
      });
      console.log("✅ 推播成功");
      lastAlertTimeMap.set(userId, now); // 更新推播時間
    } catch (err) {
      console.error("❌ 推播失敗", err);
    }
  }

  res.sendStatus(200);
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 伺服器執行中：http://localhost:${PORT}`);
});
