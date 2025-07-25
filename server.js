const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();
app.use(bodyParser.json());

// ✅ LINE Bot 設定（Render 環境變數中設定）
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new line.Client(config);

// ✅ 暫存可推播使用者與上次推播時間（實際可改為 DB）
const pushableUsers = new Map(); // userId => lastPushedTimestamp(ms)

// ✅ webhook 接收使用者訊息，處理開啟 / 關閉追蹤
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    if (!Array.isArray(events)) return res.sendStatus(200);

    for (const event of events) {
      console.log("🔁 webhook event：", JSON.stringify(event, null, 2));

      if (event.type === "message" && event.message.type === "text") {
        const text = event.message.text;
        const userId = event.source.userId;

        if (text === "開啟追蹤") {
          pushableUsers.set(userId, 0); // 記錄推播時間為 0
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

// ✅ 處理 LIFF 定期傳來的 GPS 定位資料
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

  // 判斷是否在危險區域，且允許推播
  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    const now = Date.now();
    const lastPush = pushableUsers.get(userId) || 0;

    if (now - lastPush >= 3 * 60 * 1000) { // 每 3 分鐘才能推播一次
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
      console.log("⏱️ 推播冷卻中，暫不重複通知");
    }
  }

  res.sendStatus(200);
});

// ✅ 啟動伺服器
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
