const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();
app.use(bodyParser.json());

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

// ✅ 儲存可推播用戶與上次推播時間
const pushableUsers = new Map(); // { userId: lastPushedTimestamp }

// 📍 危險區域設定
const dangerZone = {
  lat: 25.01845,
  lng: 121.54274,
  radius: 5 // 公尺
};

// ✅ 接收使用者訊息：只有「開啟追蹤」才註冊推播
app.post("/webhook", line.middleware(config), async (req, res) => {
  for (const event of req.body.events) {
    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      const text = event.message.text.trim();

      if (text === "開啟追蹤") {
        pushableUsers.set(userId, 0); // 註冊並初始化為0（尚未推播）
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "✅ 已成功啟用追蹤通知，請開啟 LIFF 應用"
        });
      } else {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "請輸入「開啟追蹤」以啟用位置推播通知。"
        });
      }
    }
  }
  res.sendStatus(200);
});

// 📡 LIFF 前端定時回報位置
app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;
  if (!userId || !latitude || !longitude) return res.status(400).send("Missing fields");

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc); // 單位：公尺

  console.log(`🛰️ ${userId} 距離危險區 ${distance.toFixed(2)}m`);

  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    const lastPush = pushableUsers.get(userId) || 0;
    const now = Date.now();
    const minutesPassed = (now - lastPush) / 1000 / 60;

    if (minutesPassed >= 3) {
      try {
        await client.pushMessage(userId, {
          type: "text",
          text: "⚠️ 您已進入危險區域，請注意安全！"
        });
        console.log("✅ 已推播警告");
        pushableUsers.set(userId, now); // 更新推播時間
      } catch (err) {
        console.error("❌ 推播失敗", err);
      }
    } else {
      console.log("⏱️ 尚未滿 3 分鐘，不推播");
    }
  }

  res.sendStatus(200);
});

// 啟動伺服器
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
