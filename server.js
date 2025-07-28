const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");

const app = express();

// ✅ CORS 設定（允許來自 GitHub Pages 等前端）
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));

// ✅ LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// ✅ 危險區域定義
const dangerZone = {
  lat: 25.01843,
  lng:  121.54282,
  radius: 500 // 公尺
};

// ✅ 儲存可推播的使用者與上次推播時間
const pushableUsers = new Map(); // userId => timestamp

// ✅ webhook 處理訊息（啟用 / 關閉 追蹤）
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const userId = event.source.userId;
        const text = event.message.text;

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
        }
        // 其他訊息不回覆任何內容（不再提示開關指令）
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook 處理錯誤：", err);
    res.sendStatus(200);
  }
});

// ✅ 接收 LIFF 傳送位置資料
app.use(bodyParser.json());

  app.post("/location", async (req, res) => {
  const { userId, latitude, longitude } = req.body;

  if (!userId || !latitude || !longitude) {
    console.warn("❌ 缺少欄位：", req.body);
    return res.status(400).send("Missing fields");
  }

  const userLoc = { lat: latitude, lng: longitude };
  const zoneLoc = { lat: dangerZone.lat, lng: dangerZone.lng };
  const distance = haversine(userLoc, zoneLoc);


  if (distance <= dangerZone.radius && pushableUsers.has(userId)) {
    const now = Date.now();
    const lastPushed = pushableUsers.get(userId) || 0;

    if (now - lastPushed >= 15 * 1000) {
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
  console.log(✅ Server running on port ${PORT});
});
