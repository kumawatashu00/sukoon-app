const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e7
});

const ABUSE_WORDS = ["mc", "bc", "bhenchod", "madarchod", "chutiya", "randi", "gand", "harami", "lodu", "bsdk"];

let waitingTextPool = [];
let waitingVideoPool = [];
const activeRooms = {};
const userRooms = {};
let totalConnections = 0;
let incidentReports = [];

const broadcastAdminStats = () => {
  io.to("admin_ops_room").emit("admin_metrics", {
    onlineUsers: io.engine.clientsCount,
    activeSessions: Object.keys(activeRooms).length,
    waitingText: waitingTextPool.length,
    waitingVideo: waitingVideoPool.length,
    totalConnections,
    incidents: incidentReports
  });
};

function matchUser(pool, socketId) {
  const index = pool.findIndex(id => id !== socketId);
  if (index !== -1) {
    return pool.splice(index, 1)[0];
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

  // पार्टनर ढूँढना (text या video)
  socket.on("find_partner", ({ mode }) => {
    waitingTextPool = waitingTextPool.filter(id => id !== socket.id);
    waitingVideoPool = waitingVideoPool.filter(id => id !== socket.id);

    const targetPool = mode === "video" ? waitingVideoPool : waitingTextPool;
    const partnerId = matchUser(targetPool, socket.id);

    if (partnerId && io.sockets.sockets.get(partnerId)) {
      const roomId = `room_${mode}_${socket.id}_${partnerId}`;
      socket.join(roomId);
      io.sockets.sockets.get(partnerId).join(roomId);

      activeRooms[roomId] = {
        u1: socket.id,
        u2: partnerId,
        mode,
        createdAt: Date.now()
      };

      userRooms[socket.id] = roomId;
      userRooms[partnerId] = roomId;

      io.to(partnerId).emit("partner_found", { roomId, isInitiator: true, mode });
      io.to(socket.id).emit("partner_found", { roomId, isInitiator: false, mode });
    } else {
      targetPool.push(socket.id);
      socket.emit("waiting_in_queue", { mode });
    }
    broadcastAdminStats();
  });

  socket.on("send_message", ({ text }) => {
    const roomId = userRooms[socket.id];
    if (!roomId || !text) return;
    const lower = text.toLowerCase();

    if (ABUSE_WORDS.some(w => lower.includes(w))) {
      socket.emit("message_rejected", {
        reason: "यह संदेश सुरक्षा नीति का उल्लंघन करता है।"
      });
      incidentReports.unshift({
        id: Math.random().toString(),
        room: roomId,
        user: socket.id.slice(0, 5) + "***",
        reason: "गाली-गलौज फ़िल्टर ट्रिगर हुआ",
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

  // WebRTC Signals (Video Call)
  socket.on("webrtc_signal", (data) => {
    const roomId = userRooms[socket.id];
    if (roomId) {
      socket.to(roomId).emit("webrtc_signal", data);
    }
  });

  const cleanup = () => {
    waitingTextPool = waitingTextPool.filter(id => id !== socket.id);
    waitingVideoPool = waitingVideoPool.filter(id => id !== socket.id);
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

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`>>> Sukoon Live Engine active on port ${PORT}`);
});
