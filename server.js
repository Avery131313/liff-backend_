const express = require("express");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();
app.use(bodyParser.json());

// ✅ LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new line.Client(config);

// ✅ 危險區域設定
const dangerZone = {
  lat: 25.01845,
  lng: 121.54274,
  radius: 5 // 公尺
};

// ✅ 儲存可推播的使用者與上次推播時間
const pushableUsers = new Map(); // userId => timestamp(ms)

// ✅ Webhook 接收訊息（管理開啟/關閉追蹤）
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const text = event.message.text;
        const userId = event.source.userId;

        if (text === "開啟追蹤") {
          if (!pushableUsers.has(userId)) {
            pushableUsers.set(userId, 0);
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
        } else {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "請輸入「開啟追蹤」或「關閉追蹤」來控制是否接收定位通知。"
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook 錯誤：", err);
    res.sendStatus(200); // 即使錯誤也回傳 200，避免 webhook 被停用
  }
});

// ✅ 接收來自 LIFF 的 GPS 資料
app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    console.warn("❌ 缺少欄位：", req.body);
    return res.status(400).send("Missing required fields");
  }

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc); // 單位：公尺

  console.log(`📍 ${userId} 距離危險區：${distance.toFixed(2)}m`);

  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    const now = Date.now();
    const lastPushed = pushableUsers.get(userId);

    if (now - lastPushed >= 3 * 60 * 1000) {
      try {
        await client.pushMessage(userId, {
          type: "text",
          text: "⚠️ 警告：您已進入危險區域，請注意安全！"
        });
        console.log("✅ 推播成功");
        pushableUsers.set(userId, now);
      } catch (err) {
        console.error("❌ 推播失敗：", err.originalError?.response?.data || err);
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
