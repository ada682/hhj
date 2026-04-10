import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import WebSocket from "ws";

// ================= ENV =================
const TOKEN = process.env.BOT_TOKEN;
const INTERVAL = 5000;

// =======================================

const bot = new TelegramBot(TOKEN, { polling: true });
let users = new Set();
let CC_PRICE = 0;

// ================= PAYLOAD =================
const payload = {
  sellInstrumentId: "Amulet",
  sellInstrumentAdmin: "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc",
  sellAmount: "1.7761889243",
  buyInstrumentId: "USDCx",
  buyInstrumentAdmin: "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef"
};

// ================= TELEGRAM =================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  users.add(chatId);

  bot.sendMessage(chatId, "otw monitor gas fee mok");
});

// ================= WEBSOCKET =================
function connectWS() {
  console.log("Connecting WS...");

  const ws = new WebSocket("wss://api.cantex.io/v1/ws/public");

  ws.on("open", () => {
    console.log("WS Connected");

    ws.send(JSON.stringify({
      type: "subscribe",
      channel: "market.CC-USDC.ticker"
    }));
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.channel === "market.CC-USDC.ticker") {
        CC_PRICE = parseFloat(data.data.price);
        console.log("CC Price:", CC_PRICE);
      }
    } catch {}
  });

  ws.on("close", () => {
    console.log("WS Disconnected, reconnecting...");
    setTimeout(connectWS, 3000);
  });

  ws.on("error", (err) => {
    console.log("WS Error:", err.message);
    ws.close();
  });
}

connectWS();

// ================= API FEE =================
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
    console.log("API Error:", err.message);
    return null;
  }
}

// ================= LOOP =================
setInterval(async () => {
  if (!CC_PRICE) return;

  const result = await checkFee();
  if (!result) return;

  const { feeCC, feeUSD, feeAmulet } = result;

  users.forEach(chatId => {
    bot.sendMessage(
      chatId,
      `fee update\n\n` +
      `Amulet: ${feeAmulet.toFixed(4)}\n` +
      `USD: $${feeUSD.toFixed(4)}\n` +
      `CC: ${feeCC.toFixed(4)}`
    );
  });

  if (feeCC < 0.2) {
    users.forEach(chatId => {
      bot.sendMessage(
        chatId,
        `fee cuma ${feeCC.toFixed(4)} CC`
      );
    });
  }

}, INTERVAL);

setInterval(async () => {
  try {
    await axios.get("https://api.cantex.io/v2/pools/quote");
    console.log("Ping OK");
  } catch {}
}, 60000);
