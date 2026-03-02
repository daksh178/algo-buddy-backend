const express = require("express");
const router = express.Router();
const User = require("../models/User");
const auth = require("../middleware/auth");

/* ================= GET USER DATA ================= */
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select(
      "-password -angel.pin -angel.totpSecret -angel.jwtToken -angel.feedToken"
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      success: true,
      user,
    });
  } catch (error) {
    console.error("GET USER ERROR:", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;