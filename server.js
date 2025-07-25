const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();
app.use(bodyParser.json());

// ⚙️ LINE Bot 設定（Render 要設好 CHANNEL_ACCESS_TOKEN 與 CHANNEL_SECRET）
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// 🧠 暫存可推播的使用者與上次推播時間
const pushableUsers = new Map(); // userId => lastPushedTimestamp(ms)

// 📍 危險區域設定
const dangerZone = {
  lat: 25.01845,
  lng: 121.54274,
  radius: 5, // 公尺
};

// 🔁 webhook：記錄 userId，控制追蹤權限
app.post("/webhook", line.middleware(config), async (req, res) => {
  for (const event of req.body.events) {
    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      const text = event.message.text.trim();

      if (text === "開啟追蹤") {
        pushableUsers.set(userId, 0); // 初始化推播時間
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "✅ 已啟用追蹤通知，請開啟 LIFF 應用程式開始定位追蹤。",
        });
      } else if (text === "關閉追蹤") {
        pushableUsers.delete(userId);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "🛑 已關閉追蹤通知。您將不再收到危險區警告。",
        });
      } else {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "請輸入「開啟追蹤」或「關閉追蹤」來控制定位通知功能。",
        });
      }
    }
  }
  res.sendStatus(200);
});

// 📡 接收 GPS 定位資料並檢查是否進入危險區
app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;
  if (!userId || !latitude || !longitude) {
    return res.status(400).send("Missing userId, latitude, or longitude");
  }

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc); // 單位：公尺

  console.log(`🛰️ ${userId} 距離危險區 ${distance.toFixed(2)}m`);

  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    const now = Date.now();
    const lastPush = pushableUsers.get(userId) || 0;

    if (now - lastPush >= 3 * 60 * 1000) { // 每 3 分鐘才能推播一次
      try {
        await client.pushMessage(userId, {
          type: "text",
          text: "⚠️ 您已進入危險區域！請注意安全。",
        });
        pushableUsers.set(userId, now); // 更新推播時間
        console.log(`✅ 已向 ${userId} 推播警告`);
      } catch (err) {
        console.error(`❌ 推播失敗：${err.message}`);
      }
    }
  }

  res.sendStatus(200);
});

// 🚀 啟動伺服器（Render 會自動綁定 PORT）
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

