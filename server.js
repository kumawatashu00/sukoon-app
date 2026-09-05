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

const registeredUsers = [];
let liveStreams = [];

// लॉगिन / रजिस्ट्रेशन API
app.post("/api/auth", (req, res) => {
  const { email, password, role, channelName, category, socialLink, bio } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email & password required" });

  let user = registeredUsers.find(u => u.email === email);
  if (!user) {
    user = {
      id: "usr_" + Math.random().toString(36).substr(2, 6),
      email,
      role: role || "viewer",
      channelName: channelName || email.split("@")[0],
      category: category || "General",
      socialLink: socialLink || "",
      bio: bio || "",
      isApprovedCreator: role === "creator" ? false : true,
      joinedAt: new Date().toLocaleDateString()
    };
    registeredUsers.push(user);
  }
  res.json({ success: true, user });
});

// एडमिन अप्रूवल API
app.post("/api/admin/approve-creator", (req, res) => {
  const { email } = req.body;
  const user = registeredUsers.find(u => u.email === email);
  if (user) {
    user.isApprovedCreator = true;
    broadcastAdminStats();
    return res.json({ success: true, user });
  }
  res.status(404).json({ error: "User not found" });
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
    registeredUsers,
    liveStreamsCount: liveStreams.length,
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

  socket.on("start_stream", ({ email, title, category }) => {
    const user = registeredUsers.find(u => u.email === email);
    if (!user || !user.isApprovedCreator) {
      return socket.emit("stream_error", { message: "आपको एडमिन द्वारा क्रिएटर अप्रूवल मिलना बाकी है।" });
    }
    const streamId = "stream_" + socket.id;
    liveStreams = liveStreams.filter(s => s.socketId !== socket.id);
    const streamData = {
      streamId,
      streamerEmail: email,
      channelName: user.channelName,
      title: title || `${user.channelName} की लाइव स्ट्रीम`,
      category: category || user.category || "Gaming",
      socketId: socket.id
    };
    liveStreams.push(streamData);
    socket.join(streamId);
    socket.emit("stream_started", streamData);
    io.emit("stream_list_updated", liveStreams);
    broadcastAdminStats();
  });

  socket.on("get_streams", () => {
    socket.emit("stream_list_updated", liveStreams);
  });

  socket.on("join_stream", ({ streamId }) => {
    socket.join(streamId);
    const stream = liveStreams.find(s => s.streamId === streamId);
    if (stream) {
      io.to(stream.socketId).emit("viewer_joined", { viewerSocketId: socket.id });
    }
  });

  socket.on("stream_signal", ({ to, signal }) => {
    io.to(to).emit("stream_signal", { from: socket.id, signal });
  });

  socket.on("find_partner", ({ mode, tag }) => {
    waitingPool = waitingPool.filter(u => u.socketId !== socket.id);
    const user = { socketId: socket.id, mode: mode || "text", tag: tag || "All" };
    const match = attemptSmartMatch(user);

    if (match && io.sockets.sockets.get(match.socketId)) {
      const roomId = `room_${socket.id}_${match.socketId}`;
      socket.join(roomId);
      io.sockets.sockets.get(match.socketId).join(roomId);

      activeRooms[roomId] = { u1: socket.id, u2: match.socketId, mode: user.mode, createdAt: Date.now() };
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
      socket.emit("message_rejected", { reason: "संदेश में अमर्यादित भाषा डिटेक्ट हुई है।" });
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
    const streamIdx = liveStreams.findIndex(s => s.socketId === socket.id);
    if (streamIdx !== -1) {
      const s = liveStreams.splice(streamIdx, 1)[0];
      io.to(s.streamId).emit("stream_ended");
      io.emit("stream_list_updated", liveStreams);
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
  console.log(`>>> Sukoon V4 Engine active on port ${PORT}`);
});
