const express = require("express");
const authMiddleware = require("../middleware/auth");
const User = require("../models/User");

// 🔥 import from trading engine
const { setAlgoRunning, stopUserWebSocket } = require("../services/tradingEngine");

const router = express.Router();

/* ================= START ALGO ================= */

router.post("/start", authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, {
      "algo.running": true,
      "algo.tradeState": "IDLE",
      "algo.lastStartedAt": new Date(),
    });

    // 🔥 update memory cache
    setAlgoRunning(req.userId.toString(), true);

    console.log("🟢 Algo Started for:", req.userId);

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: "Failed to start algo" });
  }
});

/* ================= STOP ALGO ================= */

router.post("/stop", authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, {
      "algo.running": false,
      "algo.tradeState": "IDLE",
    });

    // 🔥 update memory cache
    setAlgoRunning(req.userId.toString(), false);

    // 🔥 optional: immediately close active websocket
    stopUserWebSocket(req.userId.toString());

    console.log("🔴 Algo Stopped for:", req.userId);

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: "Failed to stop algo" });
  }
});

module.exports = router;