const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(bodyParser.json());

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new line.Client(config);

// 危險區域定義
const dangerZone = {
  lat: 25.01843,
  lng: 121.54282,
  radius: 500 // 公尺
};

// 儲存使用者狀態：{ lastPushTime, lastLocationTime }
const pushableUsers = new Map();

// webhook 接收訊息：「開啟追蹤」或「關閉追蹤」
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const userId = event.source.userId;
        const text = event.message.text;

        if (text === "開啟追蹤") {
          if (!pushableUsers.has(userId)) {
            pushableUsers.set(userId, {
              lastPushTime: 0,
              lastLocationTime: Date.now()
            });
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "✅ 你已成功啟用追蹤通知，請開啟 LIFF 畫面開始定位。"
            });
          } else {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "🔁 你已經啟用過追蹤通知。"
            });
          }
        } else if (text === "關閉追蹤") {
          pushableUsers.delete(userId);
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "🛑 你已關閉追蹤功能。"
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook 錯誤：", err);
    res.sendStatus(200);
  }
});

// LIFF 傳送位置資料
app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    console.warn("❌ 缺少欄位：", req.body);
    return res.status(400).send("Missing fields");
  }

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc);

  console.log(`📍 ${userId} 距離危險區：${distance.toFixed(2)}m`);

  if (pushableUsers.has(userId)) {
    const now = Date.now();
    const state = pushableUsers.get(userId);
    state.lastLocationTime = now;

    if (distance <= dangerZone.radius && (now - state.lastPushTime >= 15 * 1000)) {
      try {
        await client.pushMessage(userId, {
          type: "text",
          text: "⚠️ 警告：您已進入危險區域，請注意安全！"
        });
        state.lastPushTime = now;
        console.log("✅ 推播成功");
      } catch (err) {
        console.error("❌ 推播失敗：", err.originalError?.response?.data || err);
      }
    }

    pushableUsers.set(userId, state);
  }

  res.sendStatus(200);
});

// 定時檢查：是否超過 10 分鐘未傳送位置 → 自動關閉追蹤
setInterval(async () => {
  const now = Date.now();
  for (const [userId, state] of pushableUsers.entries()) {
    if (now - state.lastLocationTime > 10 * 60 * 1000) {
      pushableUsers.delete(userId);
      try {
        await client.pushMessage(userId, {
          type: "text",
          text: "📴 由於您已關閉 LIFF 畫面或超過 10 分鐘未回報定位，已自動關閉追蹤。"
        });
        console.log(`⏹️ 已自動關閉：${userId}`);
      } catch (err) {
        console.error("❌ 自動關閉通知失敗：", err.originalError?.response?.data || err);
      }
    }
  }
}, 60 * 1000); // 每分鐘執行一次

// 啟動伺服器
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

