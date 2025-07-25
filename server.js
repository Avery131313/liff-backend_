const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();
app.use(bodyParser.json());

// ✅ LINE Bot 設定（需在 Render 設定環境變數）
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// ✅ 暫存啟用追蹤的使用者及推播時間
const pushableUsers = new Map(); // userId => lastPushedTimestamp(ms)

// ✅ 危險區設定
const dangerZone = {
  lat: 25.01845,
  lng: 121.54274,
  radius: 5, // 公尺
};

// ✅ webhook 接收訊息
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const text = event.message.text;
        const userId = event.source.userId;

        if (text === "開啟追蹤") {
          if (!pushableUsers.has(userId)) {
            pushableUsers.set(userId, 0); // 初始推播時間為 0
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "✅ 已啟用追蹤功能，請開啟 LIFF 開始定位。",
            });
          } else {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "🔄 你已經啟用了追蹤功能。",
            });
          }
        } else if (text === "關閉追蹤") {
          pushableUsers.delete(userId);
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "🛑 已關閉追蹤功能。",
          });
        } else {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "請輸入「開啟追蹤」或「關閉追蹤」來控制定位推播。",
          });
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Server error");
  }
});

// ✅ 接收 LIFF 定位
app.post("/location", async (req, res) => {
  try {
    const { userId, latitude, longitude } = req.body;
    if (!userId || !latitude || !longitude) {
      return res.status(400).send("缺少參數");
    }

    const userLoc = { lat: latitude, lng: longitude };
    const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
    const distance = haversine(userLoc, zoneLoc);

    console.log(`📍 ${userId} 距離危險區：${distance.toFixed(2)}m`);

    if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
      const now = Date.now();
      const lastPush = pushableUsers.get(userId);

      if (now - lastPush >= 3 * 60 * 1000) {
        await client.pushMessage(userId, {
          type: "text",
          text: "⚠️ 警告：您已進入危險區域，請注意安全！",
        });
        console.log(`✅ 已推播給 ${userId}`);
        pushableUsers.set(userId, now);
      } else {
        console.log(`⏱️ ${userId} 冷卻中，暫不重複推播`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Location error:", err);
    res.status(500).send("Server error");
  }
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
