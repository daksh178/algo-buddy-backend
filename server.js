require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const authRoutes = require("./routes/authRoutes");
const angelRoutes = require("./routes/angelRoutes");
const telegramRoutes = require("./routes/telegramRoutes");
const algoRoutes = require("./routes/algoRoutes");
const tradeRoutes = require("./routes/tradeRoutes");
const userRoutes = require("./routes/user");

const connectDB = require("./config/db");
connectDB();

const app = express();
const server = http.createServer(app);

const { setAlgoRunning } = require("./services/tradingEngine");
const User = require("./models/User");

(async () => {
  const runningUsers = await User.find({ "algo.running": true });

  runningUsers.forEach((user) => {
    setAlgoRunning(user._id.toString(), true);
  });

  console.log("♻️ Algo cache restored");
})();

/* ================= SOCKET.IO ================= */

const io = new Server(server, {
  cors: {
    origin: "*", // change to frontend URL in production
    methods: ["GET", "POST"],
  },
});

// Make io globally accessible
global.io = io;

io.on("connection", (socket) => {
  console.log("🟢 Frontend Connected:", socket.id);

  // Join user-specific room
  socket.on("join-room", (userId) => {
    socket.join(userId);
    console.log(`👤 User ${userId} joined room`);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Frontend Disconnected:", socket.id);
  });
});

/* ================= MIDDLEWARE ================= */

app.use(cors());
app.use(express.json());

/* ================= ROUTES ================= */

app.use("/api/auth", authRoutes);
app.use("/api/angel", angelRoutes);
app.use("/api/telegram", telegramRoutes);
app.use("/api/algo", algoRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/user", userRoutes);

/* ================= HEALTH CHECK ================= */

app.get("/", (req, res) => {
  res.send("🚀 Trading Server Running with WebSocket...");
});

/* ================= START SERVER ================= */

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Server Running on Port ${PORT}`);
});
