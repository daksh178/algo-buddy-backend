const express = require("express");
const authMiddleware = require("../middleware/auth");
const Trade = require("../models/Trade");

const router = express.Router();

/* ================= GET USER TRADES ================= */

router.get("/", authMiddleware, async (req, res) => {
  try {
    const trades = await Trade.find({ userId: req.userId })
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: trades,
    });
  } catch (err) {
    console.log("GET TRADES ERROR:", err.message);
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});

module.exports = router;