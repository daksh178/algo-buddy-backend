const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: String,
  email: {
    type: String,
    unique: true,
  },
  password: String,

  // Angel Credentials
  angel: {
    apiKey: String,
    clientCode: String,
    pin: String,
    totpSecret: String,
    jwtToken: String,
    feedToken: String,
    loginTime: Date,
  },

  telegram: {
    sessionString: String,
    selectedChannelId: String,
    selectedChannelName: String,
  },

  algo: {
    running: { type: Boolean, default: false },
    tradeState: { type: String, default: "IDLE" },
    lastStartedAt: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("User", userSchema);
