const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { SmartAPI, WebSocketV2 } = require("smartapi-javascript");
const totp = require("otplib");
const axios = require("axios");

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");

// ================= TELEGRAM =================
const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const stringSession = new StringSession(process.env.TG_SESSION || "");

let signalData = null;
let selectedOption = null;
let buyExecuted = false;
let sellExecuted = false;
let buyPrice = null;
let sellPrice = null;
let web_socket = null;
let jwtToken = null;
let feedToken = null;

async function connectTelegram() {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("Phone: "),
    password: async () => await input.text("Password (if any): "),
    phoneCode: async () => await input.text("Code: "),
  });

  console.log("✅ Telegram Connected");

// ===== FETCH ALL CHANNELS & GROUPS =====
  const dialogs = await client.getDialogs();

  const channels = dialogs.filter(
    (dialog) => dialog.isChannel || dialog.isGroup
  );

  console.log("\n📋 Available Groups / Channels:\n");

  channels.forEach((chat, index) => {
    console.log(`${index} → ${chat.name}`);
  });

  const selectedIndex = await input.text(
    "\nSelect Channel/Group Index: "
  );

  const selectedChat = channels[selectedIndex];

  if (!selectedChat) {
    console.log("❌ Invalid selection");
    return;
  }

  console.log("✅ Subscribed To:", selectedChat.name);

  // ===== SUBSCRIBE ONLY SELECTED CHAT =====
  client.addEventHandler(
    async (event) => {
      const message = event.message.message;
      if (!message) return;

      console.log("\n📩 Message From Selected Channel:\n", message);

      parseSignal(message);
    },
    new NewMessage({
      chats: [selectedChat.id],
    })
  );
}

// ================= SIGNAL PARSER =================
function parseSignal(message) {
  try {
    const lines = message.split("\n");

    const firstLine = lines[0].split(" ");
    const action = firstLine[0]; // BUY
    const indexName = firstLine[1]; // NIFTY
    const strike = firstLine[2]; // 25650
    const optionType = firstLine[3]; // CE

    const qty = Number(message.match(/QTY:\s*(\d+)/)?.[1]);
    const entry = Number(message.match(/ENTRY:\s*(\d+)/)?.[1]);
    const sl = Number(message.match(/SL:\s*(\d+)/)?.[1]);
    const target = Number(message.match(/TARGET:\s*(\d+)/)?.[1]);

    signalData = {
      action,
      indexName,
      strike,
      optionType,
      qty,
      entry,
      sl,
      target,
    };

    console.log("✅ Parsed Signal:", signalData);

    findTokenAndSubscribe();
  } catch (err) {
    console.log("❌ Signal Parse Error");
  }
}

// ================= ANGEL LOGIN =================
const angel_obj = new SmartAPI({
  api_key: process.env.ANGEL_API_KEY,
});

async function angelLogin() {
  const otp = totp.authenticator.generate(process.env.TOTP_SECRET);

  console.log(process.env.TOTP_SECRET)
  console.log(otp)

  const session = await angel_obj.generateSession(
    process.env.CLIENT_CODE,
    process.env.CLIENT_PIN,
    otp,
  );

  jwtToken = session.data.jwtToken;
  feedToken = session.data.feedToken;

  console.log("✅ Angel Login Success");
}

// ================= FIND TOKEN =================
async function findTokenAndSubscribe() {
  const url =
    "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

  const response = await axios.get(url);
  const data = response.data;

  const today = new Date();

  // Step 1: Filter index + NFO + OPTIDX + CE/PE
  const filtered = data
    .filter((item) => {
      return (
        item.exch_seg === "NFO" &&
        item.name === signalData.indexName &&
        item.instrumenttype === "OPTIDX" &&
        (item.symbol.endsWith("CE") || item.symbol.endsWith("PE"))
      );
    })
    .map((item) => ({
      token: item.token,
      symbol: item.symbol,
      strike: Number(item.strike) / 100,
      optionType: item.symbol.endsWith("CE") ? "CE" : "PE",
      expiry: item.expiry,
      expiryDate: new Date(item.expiry),
    }))
    .filter((item) => item.expiryDate >= today)
    .sort((a, b) => a.expiryDate - b.expiryDate);

  if (!filtered.length) {
    console.log("❌ No Future Expiry Found");
    return;
  }

  // Step 2: Get nearest expiry
  const nearestExpiry = filtered[0].expiry;

  console.log("📅 Nearest Expiry Selected:", nearestExpiry);

  // Step 3: Now filter only that expiry
  const sameExpiryOptions = filtered.filter(
    (item) => item.expiry === nearestExpiry
  );

  // Step 4: Find exact strike + CE/PE
  selectedOption = sameExpiryOptions.find(
    (opt) =>
      opt.strike === Number(signalData.strike) &&
      opt.optionType === signalData.optionType
  );

  if (!selectedOption) {
    console.log("❌ Exact Strike Not Found In Nearest Expiry");
    return;
  }

  console.log("✅ Selected Option:", selectedOption.symbol);
  console.log("🎯 Token:", selectedOption.token);

  connectWebSocket([selectedOption.token]);
}

// ================= WEBSOCKET =================
async function connectWebSocket(token) {
  web_socket = new WebSocketV2({
    jwttoken: jwtToken,
    apikey: process.env.ANGEL_API_KEY,
    clientcode: process.env.CLIENT_CODE,
    feedtype: feedToken,
  });

  web_socket.connect().then(() => {
    let json_req = {
      correlationID: "abcd123",
      action: 1,
      mode: 1,
      exchangeType: 2,
      tokens: token,
    };
    web_socket.fetchData(json_req);
    web_socket.on("tick", receiveTick);

    console.log("📡 WebSocket Subscribed");

    // ================= HANDLE TICK =================
    async function receiveTick(data) {
      const ltp = data.last_traded_price / 100;
      if (!ltp) return;

      console.log("LTP:", ltp);

      // ================= ENTRY LOGIC =================
      if (!buyExecuted) {
        // BUY signal: wait for price to COME DOWN to entry
        if (signalData.action === "BUY" && ltp <= signalData.entry) {
          await placeOrder("BUY");
          buyExecuted = true;
          buyPrice = ltp;
          console.log("✅ BUY Executed @", buyPrice);
        }

        // SELL signal: wait for price to COME UP to entry
        if (signalData.action === "SELL" && ltp >= signalData.entry) {
          await placeOrder("SELL");
          buyExecuted = true;
          buyPrice = ltp;
          console.log("✅ SELL Executed @", buyPrice);
        }
      }

      // ================= EXIT LOGIC =================
      if (buyExecuted && !sellExecuted) {
        const pnl =
          signalData.action === "BUY"
            ? (ltp - buyPrice) * signalData.qty
            : (buyPrice - ltp) * signalData.qty;

        console.log("💰 Live PNL:", pnl);

        // BUY Trade Exit
        if (signalData.action === "BUY") {
          if (ltp >= signalData.target) {
            await placeOrder("SELL");
            sellExecuted = true;
            sellPrice = ltp;
            console.log("🎯 TARGET HIT @", sellPrice);
            console.log(
              "🔥 Final PNL:",
              (sellPrice - buyPrice) * signalData.qty,
            );
          } else if (ltp <= signalData.sl) {
            await placeOrder("SELL");
            sellExecuted = true;
            sellPrice = ltp;
            console.log("🛑 SL HIT @", sellPrice);
            console.log(
              "🔥 Final PNL:",
              (sellPrice - buyPrice) * signalData.qty,
            );
          }
        }

      //   // SELL Trade Exit
        if (signalData.action === "SELL") {
          if (ltp <= signalData.target) {
            await placeOrder("BUY");
            sellExecuted = true;
            sellPrice = ltp;
            console.log("🎯 TARGET HIT @", sellPrice);
            console.log(
              "🔥 Final PNL:",
              (buyPrice - sellPrice) * signalData.qty,
            );
          } else if (ltp >= signalData.sl) {
            await placeOrder("BUY");
            sellExecuted = true;
            sellPrice = ltp;
            console.log("🛑 SL HIT @", sellPrice);
            console.log(
              "🔥 Final PNL:",
              (buyPrice - sellPrice) * signalData.qty,
            );
          }
        }
      }
    }
  });
}

// ================= PLACE ORDER =================
async function placeOrder(type) {
  const orderData = JSON.stringify({
    variety: "NORMAL",
    tradingsymbol: selectedOption.symbol,
    symboltoken: selectedOption.token,
    transactiontype: type,
    exchange: "NFO",
    ordertype: "MARKET",
    producttype: "INTRADAY",
    duration: "DAY",
    quantity: signalData.qty,
    price: "0",
    squareoff: "0",
    stoploss: "0",
    disclosedquantity: 0,
  });

  const response = await axios.post(
    "https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder",
    orderData,
    {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "CLIENT_LOCAL_IP",
        "X-ClientPublicIP": "CLIENT_PUBLIC_IP",
        "X-MACAddress": "MAC_ADDRESS",
        "X-PrivateKey": process.env.ANGEL_API_KEY,
      },
    },
  );

  console.log(`🚀 ${type} Order Placed`, response.data);
}

// ================= START =================
(async () => {
  await connectTelegram();
  await angelLogin();
})();
