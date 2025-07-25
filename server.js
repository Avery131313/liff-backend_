// server.js
const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();

// ⚙️ LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// 🧠 暫存 userId（建議正式環境改用 Redis 或 DB）
const pushableUsers = new Set();

// 📍 危險區域座標（以公尺為單位）
const dangerZone = {
  lat: 25.01845,
  lng: 121.54274,
  radius: 5,
};

// ✅ 設定 JSON parser 只對 /location 生效
app.use("/location", bodyParser.json());

/**
 * ✅ /webhook：處理 LINE 的 webhook
 * 使用 raw body，避免 LINE 簽章驗證失敗
 */
app.post(
  "/webhook",
  express.raw({ type: "*/*" }), // ⚠️ LINE 簽章驗證必須
  (req, res, next) => {
    req.rawBody = req.body;
    req.body = JSON.parse(req.body.toString("utf8")); // 還原成 JSON 給後續使用
    next();
  },
  line.middleware(config),
  async (req, res) => {
    for (const event of req.body.events) {
      try {
        if (event.type === "message" && event.source?.userId) {
          const userId = event.source.userId;
          pushableUsers.add(userId);
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "✅ 你已啟用定位通知功能！請開啟 LIFF 開始追蹤",
          });
        }
      } catch (err) {
        console.error("Webhook 處理錯誤：", err);
      }
    }
    res.sendStatus(200);
  }
);

/**
 * ✅ /location：LIFF 前端定時回報 GPS 座標
 * 接收 userId + 經緯度，判斷是否靠近危險區，並推播警告
 */
app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    return res.status(400).send("Missing required fields");
  }

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc);

  console.log(`🛰️ ${userId} 距離危險區 ${distance.toFixed(2)} 公尺`);

  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    try {
      await client.pushMessage(userId, {
        type: "text",
        text: "⚠️ 您已進入危險區域，請小心安全！",
      });
      console.log("✅ 推播成功");
    } catch (err) {
      console.error("❌ 推播失敗", err);
    }
  }

  res.sendStatus(200);
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

