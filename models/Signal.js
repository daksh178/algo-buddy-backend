const mongoose = require("mongoose");

const signalSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  channelId: String,
  channelName: String,

  rawMessage: String,

  action: String,
  indexName: String,
  strike: String,
  optionType: String,
  qty: Number,
  entry: Number,
  target: Number,
  sl: Number,

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Signal", signalSchema);