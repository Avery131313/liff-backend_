// server.js
const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();
app.use(bodyParser.json());

// ⚠️ LINE Bot 設定
const client = new line.Client({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN, // Render 會讀這個環境變數
});

// 危險區座標
const dangerZone = {
  lat: 25.01845,
  lng: 121.54274,
  radius: 5, // 公尺
};

app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    return res.status(400).send("Missing required fields");
  }

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc); // 單位為公尺

  console.log(`User ${userId} 距離危險區 ${distance.toFixed(2)}m`);

  if (distance <= dangerZone.radius) {
    try {
      await client.pushMessage(userId, {
        type: "text",
        text: "⚠️ 您已進入危險位置，請小心！"
      });
      console.log("✅ 推播成功");
    } catch (err) {
      console.error("❌ 發送失敗", err);
    }
  }

  res.sendStatus(200);
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`後端伺服器已啟動在 http://localhost:${PORT}`);
});
