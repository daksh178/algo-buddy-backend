const mongoose = require("mongoose");

const tradeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  symbol: String,
  token: String,
  action: String, // BUY or SELL
  qty: Number,
  entryPrice: Number,
  exitPrice: Number,
  target: Number,
  sl: Number,
  status: {
    type: String,
    enum: ["OPEN", "CLOSED"],
    default: "OPEN",
  },
  pnl: Number,
}, { timestamps: true });

module.exports = mongoose.model("Trade", tradeSchema);