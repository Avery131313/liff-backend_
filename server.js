const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();
app.use(bodyParser.json());

const client = new line.Client({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
});

const dangerZone = {
  lat: 25.01845,
  lng: 121.54274,
  radius: 5, // 公尺
};

// 🧠 推播紀錄 (userId -> 最後推播時間)
const pushHistory = {};
const PUSH_INTERVAL_MS = 5 * 60 * 1000; // 5分鐘（單位：毫秒）

app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    return res.status(400).send("Missing required fields");
  }

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc);

  console.log(`📍 User ${userId} 距離危險區 ${distance.toFixed(2)}m`);

  if (distance <= dangerZone.radius) {
    const now = Date.now();
    const lastPushed = pushHistory[userId] || 0;

    if (now - lastPushed >= PUSH_INTERVAL_MS) {
      try {
        await client.pushMessage(userId, {
          type: "text",
          text: "⚠️ 您已進入危險位置，請小心！"
        });
        pushHistory[userId] = now;
        console.log(`✅ 已推播給 ${userId}`);
      } catch (err) {
        console.error("❌ 發送失敗", err);
      }
    } else {
      console.log(`⏱️ ${userId} 距上次推播未滿 5 分鐘，跳過`);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 伺服器執行中：http://localhost:${PORT}`);
});
