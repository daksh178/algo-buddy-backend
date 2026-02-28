const express = require("express");
const totp = require("otplib");
const { SmartAPI } = require("smartapi-javascript");

const User = require("../models/User");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

/* ================= ANGEL SESSION STORE ================= */

const angelSessions = {}; // per-user memory session

async function getAngelInstance(user) {

  if (angelSessions[user._id]) {
    return angelSessions[user._id];
  }

  const angelData = user.angel;

  if (!angelData?.jwtToken) {
    throw new Error("Angel not logged in");
  }

  const now = new Date();
  const loginTime = new Date(angelData.loginTime);
  const hoursPassed = (now - loginTime) / (1000 * 60 * 60);

  let angelInstance = new SmartAPI({
    api_key: angelData.apiKey,
  });

  try {

    if (hoursPassed < 23) {
      console.log("♻️ Reusing stored token");

      angelInstance.setAccessToken(angelData.jwtToken);
    } else {
      console.log("🔄 Token expired. Regenerating...");

      const otp = totp.authenticator.generate(angelData.totpSecret);

      const session = await angelInstance.generateSession(
        angelData.clientCode,
        angelData.pin,
        otp
      );

      await User.findByIdAndUpdate(user._id, {
        "angel.jwtToken": session.data.jwtToken,
        "angel.feedToken": session.data.feedToken,
        "angel.loginTime": new Date(),
      });

      angelInstance.setAccessToken(session.data.jwtToken);
    }

    angelSessions[user._id] = angelInstance;

    return angelInstance;

  } catch (err) {
    delete angelSessions[user._id];
    throw err;
  }
}

/* ================= ANGEL LOGIN ================= */

router.post("/login", authMiddleware, async (req, res) => {
  try {
    const { apiKey, clientCode, pin, totpSecret } = req.body;

    const otp = totp.authenticator.generate(totpSecret);
    const angelInstance = new SmartAPI({ api_key: apiKey });

    const session = await angelInstance.generateSession(
      clientCode,
      pin,
      otp
    );

    const jwtToken = session.data.jwtToken;
    const feedToken = session.data.feedToken;

    // ✅ Save EVERYTHING in DB
    await User.findByIdAndUpdate(req.userId, {
      angel: {
        apiKey,
        clientCode,
        pin,
        totpSecret,
        jwtToken,
        feedToken,
        loginTime: new Date(),
      },
    });

    // Store instance in memory for quick use
    angelSessions[req.userId] = angelInstance;

    console.log("✅ Angel Login Saved in DB");

    res.json({ success: true });

  } catch (err) {
    console.log("LOGIN ERROR:", err.response?.data || err);
    res.status(500).json({ error: "Angel Login Failed" });
  }
});
/* ================= ORDER BOOK ================= */

router.get("/orderbook", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user?.angel?.apiKey) {
      return res.status(400).json({ error: "Angel not configured" });
    }

    const angelInstance = await getAngelInstance(user);

    const orderBook = await angelInstance.getOrderBook();

    res.json({
      success: true,
      data: orderBook.data || [],
    });
  } catch (err) {
    console.log("ORDERBOOK ERROR:", err.response?.data || err);
    delete angelSessions[req.userId];
    res.status(500).json({ error: "Failed to fetch order book" });
  }
});

/* ================= CAPITAL ================= */

router.get("/capital", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user?.angel?.apiKey) {
      return res.status(400).json({ error: "Angel not configured" });
    }

    const angelInstance = await getAngelInstance(user);

    const rms = await angelInstance.getRMS();

    res.json({
      success: true,
      data: rms.data || {},
    });
  } catch (err) {
    console.log("RMS ERROR:", err.response?.data || err);
    delete angelSessions[req.userId];
    res.status(500).json({ error: "Failed to fetch capital details" });
  }
});

module.exports = router;