const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/ping", (req, res) => res.send("pong 24x7 active"));

// ऑप्शनल लॉगिन यूज़र्स का इन-मेमरी रिकॉर्ड
const registeredUsers = [];

// लॉगिन / साइनअप API
app.post("/api/auth", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "ईमेल और पासवर्ड ज़रूरी है" });

  let user = registeredUsers.find(u => u.email === email);
  if (!user) {
    user = { id: "user_" + Math.random().toString(36).substr(2, 6), email, joinedAt: new Date().toLocaleDateString() };
    registeredUsers.push(user);
  }
  res.json({ success: true, user });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e7
});

const ABUSE_WORDS = ["mc", "bc", "bhenchod", "madarchod", "chutiya", "randi", "gand", "harami", "lodu", "bsdk"];

let waitingPool = [];
const activeRooms = {};
const userRooms = {};
let totalConnections = 0;
let incidentReports = [];

const broadcastAdminStats = () => {
  io.to("admin_ops_room").emit("admin_metrics", {
    onlineUsers: io.engine.clientsCount,
    activeSessions: Object.keys(activeRooms).length,
    waitingPoolCount: waitingPool.length,
    totalConnections,
    totalRegistered: registeredUsers.length,
    incidents: incidentReports
  });
};

function attemptSmartMatch(user) {
  let index = waitingPool.findIndex(c => c.socketId !== user.socketId && c.mode === user.mode && c.tag === user.tag && user.tag !== "All");
  if (index === -1) {
    index = waitingPool.findIndex(c => c.socketId !== user.socketId && c.mode === user.mode);
  }
  if (index !== -1) {
    return waitingPool.splice(index, 1)[0];
  }
  return null;
}

io.on("connection", (socket) => {
  totalConnections++;
  broadcastAdminStats();

  socket.on("join_admin", () => {
    socket.join("admin_ops_room");
    broadcastAdminStats();
  });

  socket.on("find_partner", ({ mode, tag }) => {
    waitingPool = waitingPool.filter(u => u.socketId !== socket.id);
    const user = { socketId: socket.id, mode: mode || "text", tag: tag || "All" };
    const match = attemptSmartMatch(user);

    if (match && io.sockets.sockets.get(match.socketId)) {
      const roomId = `room_${socket.id}_${match.socketId}`;
      socket.join(roomId);
      io.sockets.sockets.get(match.socketId).join(roomId);

      activeRooms[roomId] = {
        u1: socket.id,
        u2: match.socketId,
        mode: user.mode,
        createdAt: Date.now()
      };

      userRooms[socket.id] = roomId;
      userRooms[match.socketId] = roomId;

      io.to(match.socketId).emit("partner_found", { roomId, isInitiator: true, tag: user.tag });
      io.to(socket.id).emit("partner_found", { roomId, isInitiator: false, tag: match.tag });
    } else {
      waitingPool.push(user);
      socket.emit("waiting_in_queue");
    }
    broadcastAdminStats();
  });

  socket.on("send_message", ({ text }) => {
    const roomId = userRooms[socket.id];
    if (!roomId || !text) return;
    const lower = text.toLowerCase();

    if (ABUSE_WORDS.some(w => lower.includes(w))) {
      socket.emit("message_rejected", { reason: "यह संदेश सुरक्षा नीति का उल्लंघन करता है।" });
      incidentReports.unshift({
        id: Math.random().toString(),
        room: roomId,
        user: socket.id.slice(0, 5) + "***",
        reason: "अमर्यादित भाषा",
        time: new Date().toLocaleTimeString()
      });
      if (incidentReports.length > 20) incidentReports.pop();
      broadcastAdminStats();
      return;
    }

    socket.to(roomId).emit("receive_message", {
      id: Math.random().toString(),
      text,
      sender: "partner",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    });
  });

  // 10s वैनिश फोटो ब्रॉडकास्ट
  socket.on("send_media", ({ imageBase64 }) => {
    const roomId = userRooms[socket.id];
    if (roomId) {
      socket.to(roomId).emit("receive_media", {
        id: Math.random().toString(),
        image: imageBase64,
        sender: "partner",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      });
    }
  });

  socket.on("send_reaction", ({ emoji }) => {
    const roomId = userRooms[socket.id];
    if (roomId) io.to(roomId).emit("receive_reaction", { emoji });
  });

  socket.on("webrtc_signal", (data) => {
    const roomId = userRooms[socket.id];
    if (roomId) socket.to(roomId).emit("webrtc_signal", data);
  });

  const cleanup = () => {
    waitingPool = waitingPool.filter(u => u.socketId !== socket.id);
    const roomId = userRooms[socket.id];
    if (roomId) {
      socket.to(roomId).emit("partner_disconnected");
      socket.leave(roomId);
      delete activeRooms[roomId];
      delete userRooms[socket.id];
    }
    broadcastAdminStats();
  };

  socket.on("leave_chat", cleanup);
  socket.on("disconnect", cleanup);
});

const PING_URL = process.env.RENDER_EXTERNAL_URL || "https://sukoon-app-lthm.onrender.com";
setInterval(() => {
  http.get(`${PING_URL}/ping`, () => {}).on("error", () => {});
}, 14 * 60 * 1000);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`>>> Sukoon Advanced Engine active on port ${PORT}`);
});
