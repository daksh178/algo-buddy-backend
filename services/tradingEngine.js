const axios = require("axios");
const { WebSocketV2 } = require("smartapi-javascript");
const User = require("../models/User");
const Trade = require("../models/Trade");

const userTrades = {}; // per-user trade memory
const algoCache = {};

/* =====================================================
   INIT USER TRADE SESSION
===================================================== */

function initUserTrade(userId) {
  if (!userTrades[userId]) {
    userTrades[userId] = {
      signalData: null,
      selectedOption: null,
      webSocket: null,
      tradeState: "IDLE",
      buyPrice: null,
      sellPrice: null,
    };
  }

  return userTrades[userId];
}

function setAlgoRunning(userId, status) {
  algoCache[userId] = status;
}

function isAlgoRunning(userId) {
  return algoCache[userId] === true;
}

function stopUserWebSocket(userId) {
  const session = userTrades[userId];
  if (session?.webSocket) {
    session.webSocket.close();
    console.log("🔌 WebSocket closed for:", userId);
  }
}

/* =====================================================
   FIND TOKEN
===================================================== */

async function findTokenAndSubscribe(userId, signal) {
  try {
    const session = initUserTrade(userId);
    session.signalData = signal;
    console.log(session.signalData);
    const response = await axios.get(
      "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json",
    );

    const data = response.data;

    const filtered = data
      .filter(
        (item) =>
          item.exch_seg === "NFO" &&
          item.name === signal.indexName &&
          item.instrumenttype === "OPTIDX",
      )
      .map((item) => ({
        token: item.token,
        symbol: item.symbol,
        strike: Number(item.strike) / 100,
        optionType: item.symbol.endsWith("CE") ? "CE" : "PE",
        expiry: new Date(item.expiry),
      }))
      .filter((item) => item.expiry >= new Date())
      .sort((a, b) => a.expiry - b.expiry);

    const nearestExpiry = filtered[0]?.expiry;

    session.selectedOption = filtered.find(
      (opt) =>
        opt.strike === Number(signal.strike) &&
        opt.optionType === signal.optionType &&
        opt.expiry.getTime() === nearestExpiry.getTime(),
    );

    if (!session.selectedOption) {
      console.log("❌ No Matching Option Found");
      return;
    }

    console.log("✅ Option Found:", session.selectedOption.symbol);

    await connectWebSocket(userId, [session.selectedOption.token]);
  } catch (err) {
    console.log("FIND TOKEN ERROR:", err.message);
  }
}

/* =====================================================
   CONNECT WEBSOCKET (MULTI USER SAFE)
===================================================== */

async function connectWebSocket(userId, tokens) {
  const session = initUserTrade(userId);

  const user = await User.findById(userId);

  if (!user?.angel?.jwtToken) {
    console.log("❌ Angel not logged in");
    return;
  }

  const web_socket = new WebSocketV2({
    jwttoken: user.angel.jwtToken,
    apikey: user.angel.apiKey,
    clientcode: user.angel.clientCode,
    feedtype: user.angel.feedToken,
  });

  session.webSocket = web_socket;

  await web_socket.connect();

  console.log("📡 WebSocket Connected");

  web_socket.fetchData({
    correlationID: userId,
    action: 1,
    mode: 1,
    exchangeType: 2,
    tokens,
  });

  web_socket.on("tick", async (data) => {
    const ltp = data.last_traded_price / 100;
    if (!ltp || !session.signalData) return;

    console.log("📈 LTP:", ltp);

    /* ENTRY */

    if (session.tradeState === "IDLE") {
      session.tradeState = "WAITING_ENTRY";
    }

    if (session.tradeState === "WAITING_ENTRY" && isAlgoRunning(userId)) {
      if (
        (session.signalData.action === "BUY" &&
          ltp <= session.signalData.entry) ||
        (session.signalData.action === "SELL" &&
          ltp >= session.signalData.entry)
      ) {
        session.tradeState = "ENTERED";
        session.buyPrice = ltp;

        console.log("🚀 ENTRY @", ltp);

        await placeOrder(userId, session.signalData.action);

        // 🔥 CREATE TRADE IN DB
        session.activeTrade = await Trade.create({
          userId,
          symbol: session.selectedOption.symbol,
          token: session.selectedOption.token,
          action: session.signalData.action,
          qty: session.signalData.qty,
          entryPrice: ltp,
          target: session.signalData.target,
          sl: session.signalData.sl,
          status: "ENTRY",
        });

        // 🔥 PUSH TO FRONTEND
        global.io?.to(userId.toString()).emit("new-trade", session.activeTrade);
      }
    }

    /* EXIT */

    if (session.tradeState === "ENTERED" && isAlgoRunning(userId)) {
      const { action, target, sl, qty } = session.signalData;

      let exitCondition =
        (action === "BUY" && (ltp >= target || ltp <= sl)) ||
        (action === "SELL" && (ltp <= target || ltp >= sl));

      if (exitCondition) {
        session.tradeState = "EXITED";
        session.sellPrice = ltp;

        const exitType = action === "BUY" ? "SELL" : "BUY";

        await placeOrder(userId, exitType);

        const pnl =
          action === "BUY"
            ? (session.sellPrice - session.buyPrice) * qty
            : (session.buyPrice - session.sellPrice) * qty;

        console.log("💰 FINAL PNL:", pnl);

        // 🔥 UPDATE TRADE
        await Trade.findByIdAndUpdate(session.activeTrade._id, {
          exitPrice: ltp,
          pnl,
          status: "CLOSED",
        });

        const updatedTrade = await Trade.findById(session.activeTrade._id);

        // 🔥 PUSH UPDATE TO FRONTEND
        global.io?.to(userId.toString()).emit("trade-updated", updatedTrade);

        /* UNSUBSCRIBE */
        web_socket.fetchData({
          correlationID: userId,
          action: 0,
          mode: 1,
          exchangeType: 2,
          tokens,
        });

        web_socket.close();
        session.tradeState = "IDLE";
        session.signalData = null;
        session.selectedOption = null;
        session.webSocket = null;
        session.activeTrade = null;
      }
    }
  });
}

/* =====================================================
   PLACE ORDER (MULTI USER SAFE)
===================================================== */

async function placeOrder(userId, type) {
  try {
    if (!isAlgoRunning(userId)) {
      console.log("⛔ Algo stopped. Order blocked.");
      return;
    }

    const session = initUserTrade(userId);
    const user = await User.findById(userId);

    const orderData = {
      variety: "NORMAL",
      tradingsymbol: session.selectedOption.symbol,
      symboltoken: session.selectedOption.token,
      transactiontype: type,
      exchange: "NFO",
      ordertype: "MARKET",
      producttype: "INTRADAY",
      duration: "DAY",
      quantity: 30,
      price: "0",
      squareoff: "0",
      stoploss: "0",
      disclosedquantity: 0,
    };

    await axios.post(
      "https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder",
      orderData,
      {
        headers: {
          Authorization: `Bearer ${user.angel.jwtToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-UserType": "USER",
          "X-SourceID": "WEB",
          "X-PrivateKey": process.env.ANGEL_API_KEY,
        },
      },
    );

    console.log(`🚀 ${type} ORDER SUCCESS`);
  } catch (err) {
    console.log("❌ ORDER FAILED:", err.response?.data || err.message);
  }
}

module.exports = {
  findTokenAndSubscribe,
  setAlgoRunning,
  isAlgoRunning,
  stopUserWebSocket,
};
