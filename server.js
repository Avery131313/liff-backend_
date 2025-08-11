// 功能：info.txt（name/lat/lng/date/time/notes）+ image.jpg + ZIP + 後台下載 + 本機下載器通知 + /location 觸發危險提示
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const line = require("@line/bot-sdk");
const haversine = require("haversine-distance");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const os = require("os");
const axios = require("axios");
const mysql = require("mysql2/promise");

const app = express();

/* CORS（不要在 webhook 前面掛全域 JSON 解析） */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-Line-Signature"],
  })
);

/* 可公開下載 ZIP 的目錄（Render ephemeral disk） */
const REPORTS_DIR = path.join(os.tmpdir(), "reports");
fs.mkdirSync(REPORTS_DIR, { recursive: true });
app.use("/reports", express.static(REPORTS_DIR, { fallthrough: false }));

/* LINE Bot 設定 */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

/* fallback 危險點（DB 出錯時才會用到） */
const fallbackZone = { lat: 25.01528, lng: 121.5474, radius: 500 };

/* 追蹤冷卻記錄（15 秒） */
const pushableUsers = new Map(); // userId => lastTs(ms)

/* 回報狀態：userId -> {...} */
const pendingReports = new Map();

/* MySQL 連線池（請用環境變數設定） */
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
  ...(String(process.env.DB_SSL || "false").toLowerCase() === "true"
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
});

/* ====== 共用小工具 ====== */
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function ensureDir(d) {
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {}
}
function getBaseUrl() {
  return process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
}
function nowTWParts() {
  const fmt = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`, // YYYY-MM-DD
    time: `${get("hour")}:${get("minute")}:${get("second")}`, // HH:mm:ss
  };
}
function metersToLatLngDelta(latDeg, radiusMeters) {
  const dLat = radiusMeters / 111320; // 1度緯度 ≈ 111,320m
  const rad = (Math.PI / 180) * latDeg;
  const metersPerDegLon = 111320 * Math.cos(rad || 1e-6);
  const dLng = radiusMeters / metersPerDegLon;
  return { dLat, dLng };
}

/* ====== ZIP + 後台下載連結 ====== */
async function zipToPublic(reportDir, zipBaseName) {
  const safeBase = (zipBaseName || "report").replace(/[\\/:*?"<>|]/g, "_");
  const zipFilename = `${safeBase}.zip`;
  const zipPath = path.join(REPORTS_DIR, zipFilename);
  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  } catch {}
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.directory(reportDir, false);
    archive.pipe(output);
    archive.finalize();
  });
  const encoded = encodeURIComponent(zipFilename);
  const base = getBaseUrl();
  const url = (base ? base : "") + `/reports/${encoded}`;
  console.log("✅ ZIP created:", zipPath);
  console.log("🔗 後台下載連結：", url);
  return url;
}

/* ====== 通知本機下載器（ngrok webhook）====== */
async function notifyDownloadAgent({ url, filename, category }) {
  const hook = process.env.DOWNLOAD_WEBHOOK_URL; // 例: https://<ngrok>/hook
  if (!hook) return;
  try {
    await axios.post(
      hook,
      { url, filename, category },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": process.env.DOWNLOAD_WEBHOOK_TOKEN || "",
        },
        timeout: 10000,
      }
    );
    console.log("📨 已通知本機下載器：", hook);
  } catch (e) {
    console.error(
      "❌ 通知本機下載器失敗：",
      e?.response?.status,
      e?.response?.data || e.message
    );
  }
}

/* ====== 危險區判斷====== */
async function isInDangerByDB(lat, lng, radiusMeters = 500) {
  const { dLat, dLng } = metersToLatLngDelta(lat, radiusMeters);
  const latMin = lat - dLat;
  const latMax = lat + dLat;
  const lngMin = lng - dLng;
  const lngMax = lng + dLng;

  const sql = `
    SELECT latitude, longitude
    FROM wasp_reports
    WHERE latitude  IS NOT NULL
      AND longitude IS NOT NULL
      AND latitude  BETWEEN ? AND ?
      AND longitude BETWEEN ? AND ?
    LIMIT 5000
  `;

  try {
    console.log(
      `[DANGER-DB] bbox lat:[${latMin.toFixed(6)}, ${latMax.toFixed(
        6
      )}] lng:[${lngMin.toFixed(6)}, ${lngMax.toFixed(6)}]`
    );
    const t0 = Date.now();
    const [rows] = await pool.query(sql, [latMin, latMax, lngMin, lngMax]);
    console.log(
      `[DANGER-DB] got ${rows.length} candidates in ${Date.now() - t0}ms`
    );

    const here = { lat, lng };
    for (const r of rows) {
      const p = {
        lat: Number(r.latitude),
        lng: Number(r.longitude),
      };
      if (Number.isNaN(p.lat) || Number.isNaN(p.lng)) continue;
      const d = haversine(p, here);
      if (d <= radiusMeters) {
        console.log(
          `[DANGER-DB] HIT distance=${Math.round(d)}m point=(${p.lat},${p.lng})`
        );
        return true;
      }
    }
    console.log("[DANGER-DB] NO hit within radius");
    return false;
  } catch (e) {
    console.error("[DANGER-DB] query failed:", e.message);
    return null; // 交給上層 fallback
  }
}

/* ====== 回報流程 ====== */
async function startReport(event, category) {
  const userId = event.source?.userId;
  if (!userId) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "無法取得使用者資訊。",
    });
    return;
  }

  // 顯示名稱
  let displayName = "";
  try {
    const p = await client.getProfile(userId);
    displayName = (p?.displayName || "").trim();
  } catch {}

  const safeName =
    (displayName && displayName.replace(/[\\/:*?"<>|]/g, "_").trim()) ||
    userId;

  // 建立本地資料夾
  const baseDir = path.join(__dirname, category);
  ensureDir(baseDir);
  const folderName = `${ts()}_${safeName}`;
  const reportDir = path.join(baseDir, folderName);
  ensureDir(reportDir);

  // 初始化狀態
  pendingReports.set(userId, {
    category,
    reportDir,
    folderName,
    displayName,
    hasPhoto: false,
    hasLocation: false,
    hasNotes: false,
    lat: null,
    lng: null,
    notes: "",
  });

  await client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "已建立回報，請依序上傳：\n1) 照片\n2) 備註：直接輸入文字訊息即可（例如：在學校門口發現）\n3) 位置（LINE 位置訊息）",
  });
}

/* 建立 info.txt 內容（含台灣時區 date/time） */
function buildInfoTxt({ displayName, lat, lng, notes }) {
  const { date, time } = nowTWParts();
  const lines = [
    `name: ${displayName || ""}`,
    `latitude: ${lat != null ? String(lat) : ""}`,
    `longitude: ${lng != null ? String(lng) : ""}`,
    `date: ${date}`,
    `time: ${time}`,
    `notes: ${(notes || "").trim()}`,
  ];
  return lines.join("\n");
}
async function writeInfoTxt(reportDir, data) {
  const txt = buildInfoTxt(data);
  fs.writeFileSync(path.join(reportDir, "info.txt"), txt, "utf8");
}

/* 嘗試在三要件齊全時收尾（寫 info.txt、壓 ZIP、通知下載器） */
async function finishIfReady(userId, replyToken) {
  const st = pendingReports.get(userId);
  if (!st) return false;

  if (st.hasPhoto && st.hasLocation && st.hasNotes) {
    pendingReports.delete(userId);
    try {
      await writeInfoTxt(st.reportDir, {
        displayName: st.displayName,
        lat: st.lat,
        lng: st.lng,
        notes: st.notes,
      });
      const url = await zipToPublic(st.reportDir, st.folderName);
      await notifyDownloadAgent({
        url,
        filename: `${st.folderName}.zip`,
        category: st.category,
      });
    } catch (e) {
      console.error("❌ finalize failed (write/zip/notify):", e);
    }

    const text = `📦 已完成存檔。`;
    if (replyToken)
      await client.replyMessage(replyToken, { type: "text", text });
    else await client.pushMessage(userId, { type: "text", text });
    return true;
  }
  return false;
}

/* ====== webhook（不要在前面掛 JSON 解析）====== */
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    for (const event of events) {
      try {
        if (event.type !== "message") continue;
        const userId = event.source?.userId;
        const msg = event.message;

        if (msg.type === "text") {
          const text = (msg.text || "").trim();

          if (text === "開啟追蹤") {
            if (!pushableUsers.has(userId)) {
              pushableUsers.set(userId, 0);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "✅ 你已成功啟用追蹤通知，請打開連結開始定位。",
              });
            } else {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "🔁 你已經啟用過追蹤通知。",
              });
            }
            continue;
          }
          if (text === "關閉追蹤") {
            pushableUsers.delete(userId);
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "🛑 你已關閉追蹤功能。",
            });
            continue;
          }

          // 啟動回報
          if (text === "發現疑似蜜蜂" || text === "發現疑似蜂巢") {
            const category = text.includes("蜜蜂") ? "疑似蜜蜂" : "疑似蜂巢";
            await startReport(event, category);
            continue;
          }

          // 備註：回報進行中且尚未記錄 notes 的任意文字
          const st = pendingReports.get(userId);
          if (st && !st.hasNotes) {
            st.notes = text;
            st.hasNotes = true;

            const done = await finishIfReady(userId, event.replyToken);
            if (!done) {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "📝 備註已記錄，請繼續提供位置。",
              });
            }
            continue;
          }

          continue; // 其他文字不回覆
        }

        if (msg.type === "image") {
          const st = pendingReports.get(userId);
          if (!st) continue;

          try {
            const stream = await client.getMessageContent(msg.id);
            const filePath = path.join(st.reportDir, "image.jpg");
            await new Promise((resolve, reject) => {
              const ws = fs.createWriteStream(filePath);
              stream.pipe(ws);
              ws.on("finish", resolve);
              stream.on("error", reject);
              ws.on("error", reject);
            });
            st.hasPhoto = true;

            const done = await finishIfReady(userId, event.replyToken);
            if (!done) {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "✅ 照片已儲存，請再分享備註與定位。",
              });
            }
          } catch (err) {
            console.error("❌ 圖片存檔失敗：", err);
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "抱歉，圖片儲存失敗。",
            });
          }
          continue;
        }

        if (msg.type === "location") {
          const st = pendingReports.get(userId);
          if (!st) continue;

          try {
            st.lat = Number(msg.latitude);
            st.lng = Number(msg.longitude);
            st.hasLocation = true;

            const done = await finishIfReady(userId, event.replyToken);
            if (!done) {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "✅ 已收到定位。",
              });
            }
          } catch (err) {
            console.error("❌ 定位處理失敗：", err);
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "抱歉，定位處理失敗。",
            });
          }
          continue;
        }
      } catch (e) {
        console.error("❌ webhook 單一事件錯誤：", e);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook 處理錯誤：", err);
    res.sendStatus(200);
  }
});

/* ====== LIFF 的 /location：只在這條掛 JSON；這裡才做危險判斷 ====== */
app.post("/location", bodyParser.json(), async (req, res) => {
  const { userId, latitude, longitude } = req.body;
  if (!userId || !latitude || !longitude) {
    console.warn("❌ /location 缺少欄位：", req.body);
    return res.status(400).send("Missing fields");
  }

  const lat = Number(latitude);
  const lng = Number(longitude);
  console.log(`[DANGER-CHECK] input lat=${lat}, lng=${lng}`);

  // 1) 用 DB 外接矩形粗篩 + Node haversine 精算
  const t0 = Date.now();
  let danger = await isInDangerByDB(lat, lng, 500);
  console.log(
    `[DANGER-CHECK] result=${danger} cost=${Date.now() - t0}ms (null 表示 DB 失敗、走 fallback)`
  );

  // 2) DB 失敗就 fallback 到單一危險點（避免完全沒提示）
  if (danger === null) {
    const d = haversine({ lat, lng }, { lat: fallbackZone.lat, lng: fallbackZone.lng });
    danger = d <= fallbackZone.radius;
    console.log(`[DANGER-FALLBACK] dist=${Math.round(d)}m => danger=${danger}`);
  }

  // 3) 命中才推播（沿用 15 秒冷卻 + 必須先「開啟追蹤」）
  if (danger && pushableUsers.has(userId)) {
    const now = Date.now();
    const last = pushableUsers.get(userId) || 0;
    if (now - last >= 15 * 1000) {
      try {
        await client.pushMessage(userId, {
          type: "text",
          text: `⚠️ 警告：您已進入危險區域，請注意安全！`,
        });
        pushableUsers.set(userId, now);
        console.log("✅ 推播成功");
      } catch (err) {
        console.error("❌ 推播失敗：", err.originalError?.response?.data || err.message);
      }
    } else {
      console.log("⏱️ 冷卻中，暫不重複通知");
    }
  }

  // 4) 回報模式：記錄 lat/lng，嘗試完成
  const st = pendingReports.get(userId);
  if (st) {
    try {
      st.lat = lat;
      st.lng = lng;
      st.hasLocation = true;

      if (st.hasPhoto && st.hasLocation && st.hasNotes) {
        pendingReports.delete(userId);
        try {
          await writeInfoTxt(st.reportDir, {
            displayName: st.displayName,
            lat: st.lat,
            lng: st.lng,
            notes: st.notes,
          });
          const url = await zipToPublic(st.reportDir, st.folderName);
          await notifyDownloadAgent({
            url,
            filename: `${st.folderName}.zip`,
            category: st.category,
          });
          await client.pushMessage(userId, { type: "text", text: `📦 已完成存檔。` });
        } catch (e) {
          console.error("❌ 壓縮/寫檔/通知失敗（/location 完成）：", e);
          await client.pushMessage(userId, {
            type: "text",
            text: "📦 已完成存檔，但 ZIP 生成失敗，可稍後再試。",
          });
        }
      } else {
        await client.pushMessage(userId, {
          type: "text",
          text: "✅ 已收到定位。",
        });
      }
    } catch (e) {
      console.error("❌ 定位處理失敗（/location）：", e);
    }
  }

  res.sendStatus(200);
});

/* ====== 啟動 ====== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  const base = getBaseUrl();
  if (base) console.log(`🔗 ZIP 下載根：${base}/reports/<檔名>.zip`);
  else console.log("ℹ️ 建議設定 PUBLIC_BASE_URL 或使用 RENDER_EXTERNAL_URL。");
});

/* ====== 全域錯誤保險（避免吞錯）====== */
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION:", e);
});
process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT EXCEPTION:", e);
});

