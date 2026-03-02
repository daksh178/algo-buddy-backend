const express = require("express");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { Api } = require("telegram");

const authMiddleware = require("../middleware/auth");
const Signal = require("../models/Signal");
const User = require("../models/User");
const cron = require("node-cron");
const { findTokenAndSubscribe } = require("../services/tradingEngine");

const router = express.Router();

/* =====================================================
   TEMP LOGIN STATE (PER USER)
===================================================== */

const telegramLoginState = {}; 
// userId -> { client, phoneNumber, phoneCodeHash }

/* =====================================================
   ACTIVE TELEGRAM CLIENTS (PER USER)
===================================================== */

const telegramClients = {}; 
// userId -> TelegramClient


/* =====================================================
   GET TELEGRAM CLIENT (FROM DB SESSION)
===================================================== */

async function getTelegramClient(userId) {
  if (telegramClients[userId]) {
    return telegramClients[userId];
  }

  const user = await User.findById(userId);

  if (!user?.telegram?.sessionString) {
    throw new Error("Telegram not connected");
  }

  const client = new TelegramClient(
    new StringSession(user.telegram.sessionString),
    Number(process.env.TG_API_ID),
    process.env.TG_API_HASH,
    { connectionRetries: 5 }
  );

  await client.connect();

  // 🔥 IMPORTANT FIX
  await client.getDialogs(); 
  // This forces Telegram to sync updates properly

  telegramClients[userId] = client;

  return client;
}

/* =====================================================
   SEND CODE
===================================================== */

router.post("/send-code", authMiddleware, async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: "phoneNumber required" });
    }

    const client = new TelegramClient(
      new StringSession(""),
      Number(process.env.TG_API_ID),
      process.env.TG_API_HASH,
      { connectionRetries: 5 }
    );

    await client.connect();

    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: String(phoneNumber),
        apiId: Number(process.env.TG_API_ID),
        apiHash: process.env.TG_API_HASH,
        settings: new Api.CodeSettings({}),
      })
    );

    telegramLoginState[req.userId] = {
      client,
      phoneNumber,
      phoneCodeHash: result.phoneCodeHash,
    };

    res.json({ success: true });

  } catch (err) {
    console.log("SEND CODE ERROR:", err.message);
    res.status(500).json({ error: "Failed to send code" });
  }
});


/* =====================================================
   VERIFY CODE (ONLY code + password REQUIRED)
===================================================== */

router.post("/verify-code", authMiddleware, async (req, res) => {
  try {
    const { code, password } = req.body;

    const loginState = telegramLoginState[req.userId];

    if (!loginState) {
      return res.status(400).json({ error: "Send code first" });
    }

    const { client, phoneNumber, phoneCodeHash } = loginState;

    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: String(phoneNumber),
          phoneCodeHash: String(phoneCodeHash),
          phoneCode: String(code),
        })
      );
    } catch (error) {
      if (error.errorMessage === "SESSION_PASSWORD_NEEDED") {
        if (!password) {
          return res.json({
            success: false,
            requirePassword: true,
          });
        }

        const passwordInfo = await client.invoke(
          new Api.account.GetPassword()
        );

        const { computeCheck } = require("telegram/Password");
        const passwordCheck = await computeCheck(passwordInfo, password);

        await client.invoke(
          new Api.auth.CheckPassword({
            password: passwordCheck,
          })
        );
      } else {
        throw error;
      }
    }

    const sessionString = client.session.save();

    await User.findByIdAndUpdate(req.userId, {
      "telegram.sessionString": sessionString,
    });

    telegramClients[req.userId] = client;
    delete telegramLoginState[req.userId];

    res.json({ success: true });

  } catch (err) {
    console.log("VERIFY ERROR:", err.message);
    res.status(500).json({ error: "Invalid code or password" });
  }
});


/* =====================================================
   GET CHANNELS (PER USER)
===================================================== */

router.get("/channels", authMiddleware, async (req, res) => {
  try {
    const client = await getTelegramClient(req.userId);

    const dialogs = await client.getDialogs();

    const channels = dialogs
      .filter((d) => d.isChannel || d.isGroup)
      .map((chat) => ({
        id: chat.id,
        title: chat.name,
      }));

    res.json({ success: true, channels });

  } catch (err) {
    console.log("CHANNEL ERROR:", err.message);
    res.status(500).json({ error: "Failed to fetch channels" });
  }
});


/* =====================================================
   SELECT CHANNEL + SAVE TO DB + SUBSCRIBE
===================================================== */

router.post("/select-channel", authMiddleware, async (req, res) => {
  try {
    const { channelId, channelName } = req.body;

    if (!channelId) {
      return res.status(400).json({ error: "channelId required" });
    }

    await User.findByIdAndUpdate(req.userId, {
      "telegram.selectedChannelId": channelId,
      "telegram.selectedChannelName": channelName || "",
    });

    await subscribeUserToChannel(req.userId);

    res.json({ success: true });

  } catch (err) {
    console.log("SELECT CHANNEL ERROR:", err.message);
    res.status(500).json({ error: "Failed to select channel" });
  }
});


/* =====================================================
   SUBSCRIBE TO SAVED CHANNEL
===================================================== */

async function subscribeUserToChannel(userId) {
  const user = await User.findById(userId);

  if (!user?.telegram?.selectedChannelId) return;

  const client = await getTelegramClient(userId);

  const channelId = user.telegram.selectedChannelId;

  client.addEventHandler(
    async (event) => {
      try {
        const message = event.message?.message;
        if (!message) return;

        console.log(`📩 User ${userId} Signal:`, message);

        const parsed = parseSignal(message);
        if (!parsed) return;

        const saved = await Signal.create({
          userId,
          channelId,
          channelName: user.telegram.selectedChannelName,
          rawMessage: message,
          ...parsed,
        });

        if (global.io) {
          global.io.to(userId.toString()).emit("new-signal", saved);
        }

      await findTokenAndSubscribe(userId, parsed);

      } catch (err) {
        console.log("Telegram Event Error:", err.message);
      }
    },
    new NewMessage({
      chats: [channelId],
    })
  );

  console.log(`✅ User ${userId} subscribed to ${channelId}`);
}


/* =====================================================
   RESTORE SUBSCRIPTIONS ON SERVER START
===================================================== */

async function restoreSubscriptions() {
  const users = await User.find({
    "telegram.selectedChannelId": { $exists: true },
  });

  for (const user of users) {
    try {
      await subscribeUserToChannel(user._id);
    } catch (err) {
      console.log("Restore error:", err.message);
    }
  }
}

restoreSubscriptions();


/* =====================================================
   PARSE SIGNAL
===================================================== */

function parseSignal(message) {
  try {
    const lines = message.split("\n");
    const firstLine = lines[0].split(" ");

    return {
      action: firstLine[0],
      indexName: firstLine[1],
      strike: firstLine[2],
      optionType: firstLine[3],
      qty: Number(message.match(/QTY:\s*(\d+)/)?.[1]),
      entry: Number(message.match(/ENTRY:\s*(\d+)/)?.[1]),
      target: Number(message.match(/TARGET:\s*(\d+)/)?.[1]),
      sl: Number(message.match(/SL:\s*(\d+)/)?.[1]),
    };
  } catch {
    return null;
  }
}


/* =====================================================
   GET SAVED SIGNALS
===================================================== */

router.get("/signals", authMiddleware, async (req, res) => {
  try {
    const signals = await Signal.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({ success: true, data: signals });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch signals" });
  }
});

/* =====================================================
   DELETE ALL SIGNALS (MANUAL API)
===================================================== */

router.delete("/signals", authMiddleware, async (req, res) => {
  try {
    await Signal.deleteMany({ userId: req.userId });

    res.json({
      success: true,
      message: "All signals deleted successfully",
    });
  } catch (err) {
    console.log("DELETE SIGNAL ERROR:", err.message);
    res.status(500).json({ error: "Failed to delete signals" });
  }
});

/* =====================================================
   DAILY AUTO DELETE AT 5:00 PM
   (Server timezone based)
===================================================== */

cron.schedule("39 15 * * *", async () => {
  try {
    console.log("🕔 Running Daily Signal Cleanup...");

    const result = await Signal.deleteMany({});

    console.log(`🗑 Deleted ${result.deletedCount} signals`);
  } catch (err) {
    console.log("CRON DELETE ERROR:", err.message);
  }
});

module.exports = router;