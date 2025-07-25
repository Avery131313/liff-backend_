// server.js
const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();
app.use(bodyParser.json());

// ⚙️ LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

// 🧠 暫存記憶可推播的 userId（生產環境建議用資料庫或 Redis）
const pushableUsers = new Set();

// 🔁 Webhook 接收訊息，記錄 userId
app.post("/webhook", line.middleware(config), async (req, res) => {
  for (const event of req.body.events) {
    if (event.type === "message") {
      const userId = event.source.userId;
      pushableUsers.add(userId); // 登記可推播
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "✅ 你已啟用定位通知功能！請開啟 LIFF 開始追蹤"
      });
    }
  }
  res.sendStatus(200);
});

// 📍 危險區域設定
const dangerZone = {
  lat: 25.01845,
  lng: 121.54274,
  radius: 5 // 公尺
};

// 📡 定時上傳位置資料
app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;
  if (!userId || !latitude || !longitude) return res.status(400).send("Missing fields");

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc); // 公尺

  console.log(`🛰️ ${userId} 距離危險區 ${distance.toFixed(2)}m`);

  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    try {
      await client.pushMessage(userId, {
        type: "text",
        text: "⚠️ 您已進入危險區域！請注意安全"
      });
      console.log("✅ 推播成功");
    } catch (err) {
      console.error("❌ 推播失敗", err);
    }
  }

  res.sendStatus(200);
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
