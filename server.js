const express = require("express");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();

// ✅ LINE Bot 設定（來自 Render 環境變數）
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new line.Client(config);

// ✅ 暫存可推播使用者與上次推播時間（建議正式環境用資料庫）
const pushableUsers = new Map(); // userId => lastPushedTimestamp(ms)

// ✅ LINE Webhook：開啟/關閉追蹤
app.post("/webhook", line.middleware(config), express.json(), async (req, res) => {
  try {
    const events = req.body.events;
    if (!Array.isArray(events)) return res.sendStatus(200);

    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const text = event.message.text.trim();
        const userId = event.source.userId;

        if (text === "開啟追蹤") {
          pushableUsers.set(userId, 0);
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "✅ 你已啟用追蹤通知，請開啟 LIFF 開始定位。"
          });
        } else if (text === "關閉追蹤") {
          pushableUsers.delete(userId);
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "🛑 你已關閉追蹤功能。"
          });
        } else {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "請輸入「開啟追蹤」或「關閉追蹤」。"
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook 處理錯誤", err);
    res.sendStatus(500);
  }
});

// ✅ 危險區域座標設定
const dangerZone = {
  lat: 25.01845,
  lng: 121.54274,
  radius: 5 // 公尺
};

// ✅ 處理來自 LIFF 的位置資料
app.use(express.json());
app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    console.warn("⚠️ 缺少欄位", req.body);
    return res.status(400).send("Missing required fields");
  }

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc); // 單位：公尺

  console.log(`📍 ${userId} 距離危險區：${distance.toFixed(2)}m`);

  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    const now = Date.now();
    const lastPush = pushableUsers.get(userId) || 0;

    if (now - lastPush >= 3 * 60 * 1000) { // 每 3 分鐘推播一次
      try {
        await client.pushMessage(userId, {
          type: "text",
          text: "⚠️ 警告：您已進入危險區域，請注意安全！"
        });
        console.log("✅ 推播成功");
        pushableUsers.set(userId, now);
      } catch (err) {
        console.error("❌ 推播失敗", err.originalError?.response?.data || err);
      }
    } else {
      console.log("⏱️ 冷卻中，暫不推播");
    }
  }

  res.sendStatus(200);
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
