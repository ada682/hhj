import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import WebSocket from "ws";

// ================= env =================
const TOKEN = process.env.BOT_TOKEN;
const CANTEX_COOKIE = process.env.CANTEX_COOKIE;
const INTERVAL = 60000;
// =======================================

const bot = new TelegramBot(TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  }
});

bot.on("polling_error", (err) => {
  if (err.code === "ETELEGRAM" && err.message.includes("409")) {
    console.error("409 conflict: instance lain masih jalan, tunggu 15 detik lalu restart...");
    setTimeout(() => process.exit(1), 15000);
  } else {
    console.error("polling error:", err.message);
  }
});

let users = new Set();
let CC_PRICE = 0;
let cookieExpiredNotified = false;

// ================= payload =================
const payload = {
  sellInstrumentId: "Amulet",
  sellInstrumentAdmin: "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc",
  sellAmount: "1.7761889243",
  buyInstrumentId: "USDCx",
  buyInstrumentAdmin: "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef"
};

// ================= telegram =================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  users.add(chatId);
  cookieExpiredNotified = false;
  bot.sendMessage(chatId, "bot aktif, otw cek gas fee cc mok");
});

bot.onText(/\/harga/, (msg) => {
  const chatId = msg.chat.id;
  if (CC_PRICE) {
    bot.sendMessage(chatId, `harga cc sekarang: $${CC_PRICE}`);
  } else {
    bot.sendMessage(chatId, "harga cc belum tersedia, tunggu sebentar");
  }
});

bot.onText(/\/fee/, async (msg) => {
  const chatId = msg.chat.id;
  if (!CC_PRICE) {
    bot.sendMessage(chatId, "harga cc belum tersedia, tunggu sebentar");
    return;
  }
  const result = await checkFee();
  if (!result) {
    bot.sendMessage(chatId, "gagal ambil fee, coba lagi");
    return;
  }
  const { feeAmulet, feeUSD, feeCC } = result;
  bot.sendMessage(
    chatId,
    `fee sekarang\n\namulet: ${feeAmulet.toFixed(4)}\nusd: $${feeUSD.toFixed(4)}\ncc: ${feeCC.toFixed(4)}`
  );
});

// ================= websocket =================
function connectWS() {
  console.log("connecting ws...");
  const ws = new WebSocket("wss://api.cantex.io/v1/ws/public", {
    headers: {
      "origin": "https://www.cantex.io"
    }
  });

  ws.on("open", () => {
    console.log("ws connected");
    ws.send(JSON.stringify({
      op: "subscribe",
      channels: ["market.CC-USDC.ticker"]
    }));
    console.log("subscribe sent");
  });

  ws.on("message", (msg) => {
    const raw = msg.toString();

    try {
      const parsed = JSON.parse(raw);

      if (parsed.op === "ping") {
        ws.send(JSON.stringify({ op: "pong" }));
        return;
      }

      if (parsed.op === "subscribed") {
        console.log("subscribed to:", parsed.channels);
        return;
      }

      if (parsed.op === "error") {
        console.log("server error:", parsed.message);
        return;
      }

      const channel = parsed.channel || "";
      const price = parsed.data?.price || null;

      if (price && channel === "market.CC-USDC.ticker") {
        const newPrice = parseFloat(price);
        if (!isNaN(newPrice) && newPrice > 0) {
          CC_PRICE = newPrice;
          console.log("cc price updated:", CC_PRICE);
        }
      }

    } catch (e) {
      console.log("parse error:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("ws disconnected, reconnecting...");
    setTimeout(connectWS, 3000);
  });

  ws.on("error", (err) => {
    console.log("ws error:", err.message);
    ws.close();
  });
}

connectWS();

// ================= notif ke semua user =================
function notifyAll(text) {
  users.forEach(chatId => {
    bot.sendMessage(chatId, text).catch(() => {});
  });
}

// ================= api fee =================
async function checkFee() {
  try {
    const res = await axios.post(
      "https://api.cantex.io/v2/pools/quote",
      payload,
      {
        headers: {
          "content-type": "text/plain;charset=UTF-8",
          "origin": "https://www.cantex.io",
          "referer": "https://www.cantex.io/",
          "cookie": CANTEX_COOKIE
        }
      }
    );

    if (cookieExpiredNotified) {
      cookieExpiredNotified = false;
      notifyAll("✅ cookie sudah valid lagi, bot normal kembali");
    }

    const data = res.data;
    const networkFee = parseFloat(data.fees.network_fee.amount);
    const adminFee = parseFloat(data.fees.amount_admin);
    const liquidityFee = parseFloat(data.fees.amount_liquidity);
    const totalAmulet = networkFee + adminFee + liquidityFee;
    const tradePrice = parseFloat(data.trade_price);
    const feeUSD = totalAmulet * tradePrice;
    const feeCC = CC_PRICE ? (feeUSD / CC_PRICE) : 0;

    return { feeAmulet: totalAmulet, feeUSD, feeCC };

  } catch (err) {
    const status = err.response?.status;

    if (status === 401) {
      console.log("cookie expired / unauthorized");
      if (!cookieExpiredNotified) {
        cookieExpiredNotified = true;
        notifyAll(
          "⚠️ cookie cantex expired!\n\n" +
          "bot tidak bisa ambil data fee.\n" +
          "update env CANTEX_COOKIE dengan cookie baru dari browser, lalu restart bot."
        );
      }
    } else {
      console.log("api error:", err.message);
    }

    return null;
  }
}

// ================= initial check =================
async function initialCheck() {
  console.log("waiting cc price...");

  let retries = 0;
  while (!CC_PRICE && retries < 30) {
    await new Promise(r => setTimeout(r, 1000));
    retries++;
  }

  if (!CC_PRICE) {
    console.log("gagal ambil harga cc setelah 30 detik");
    return;
  }

  console.log("cc price ready:", CC_PRICE);

  const result = await checkFee();
  if (!result) return;

  const { feeAmulet, feeUSD, feeCC } = result;
  console.log("gas check");
  console.log("amulet:", feeAmulet);
  console.log("usd:", feeUSD);
  console.log("cc:", feeCC);
}

initialCheck();

// ================= loop =================
setInterval(async () => {
  if (!CC_PRICE) return;

  const result = await checkFee();
  if (!result) return;

  const { feeCC, feeUSD, feeAmulet } = result;

  users.forEach(chatId => {
    bot.sendMessage(
      chatId,
      `fee update\n\namulet: ${feeAmulet.toFixed(4)}\nusd: $${feeUSD.toFixed(4)}\ncc: ${feeCC.toFixed(4)}`
    );
  });

  if (feeCC < 0.2) {
    users.forEach(chatId => {
      bot.sendMessage(chatId, `🚨 fee cuma ${feeCC.toFixed(4)} cc`);
    });
  }

}, INTERVAL);

// ================= ping =================
setInterval(async () => {
  try {
    await axios.get("https://api.cantex.io");
    console.log("ping ok");
  } catch {}
}, 60000);
