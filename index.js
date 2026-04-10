import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import WebSocket from "ws";

// ================= env =================
const TOKEN = process.env.BOT_TOKEN;
const INTERVAL = 5000;
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

// ================= websocket =================
function connectWS() {
  console.log("connecting ws...");
  const ws = new WebSocket("wss://api.cantex.io/v1/ws/public");

  ws.on("open", () => {
    console.log("ws connected");

    // coba format subscribe yang berbeda
    ws.send(JSON.stringify({
      op: "subscribe",
      args: ["market.CC-USDC.ticker"]
    }));
    console.log("subscribe sent (op format)");
  });

  ws.on("message", (msg) => {
    const raw = msg.toString();
    console.log("raw:", raw);

    try {
      const parsed = JSON.parse(raw);

      // handle ping dari server, balas pong
      if (parsed.op === "ping") {
        ws.send(JSON.stringify({ op: "pong" }));
        console.log("pong sent");
        return;
      }

      // coba berbagai kemungkinan lokasi price
      const price =
        parsed.data?.price ||
        parsed.price ||
        parsed.data?.last ||
        parsed.last ||
        null;

      const channel =
        parsed.channel ||
        parsed.topic ||
        parsed.arg ||
        parsed.subject ||
        "";

      console.log("channel:", channel, "| price:", price);

      if (price && (channel.includes("CC") || channel.includes("ticker"))) {
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
          "referer": "https://www.cantex.io/"
        }
      }
    );

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
    console.log("api error:", err.message);
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
  if (!result) {
    console.log("gagal ambil fee");
    return;
  }

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
      bot.sendMessage(chatId, `fee cuma ${feeCC.toFixed(4)} cc`);
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
