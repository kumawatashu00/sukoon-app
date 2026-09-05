const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/ping", (req, res) => res.send("pong 24x7 active"));

const ADMIN_USER = "ashok_admin";
const ADMIN_PASS = "Sukoon@2026#Secure";
const DB_FILE = path.join(__dirname, "database.json");

let dbData = {
  registeredUsers: [],
  totalConnectionsCount: 0,
  incidents: [],
  banners: {
    banner1: {
      imageUrl: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=800&auto=format&fit=crop&q=60",
      title: "सुकून कम्युनिटी में आपका स्वागत है 🌿",
      linkUrl: ""
    },
    banner2: {
      imageUrl: "https://images.unsplash.com/photo-1517649763962-0c623266ddc0?w=800&auto=format&fit=crop&q=60",
      title: "लाइव स्ट्रीम हब में अपनी प्रतिभा दिखाएँ 🎙️",
      linkUrl: ""
    }
  }
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    dbData = { ...dbData, ...JSON.parse(raw) };
  } catch (e) {
    console.error("DB Load Error:", e);
  }
}

const saveDB = () => {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
  } catch (e) {
    console.error("DB Save Error:", e);
  }
};

let liveStreams = []; // { streamId, streamerEmail, channelName, avatar, schedule, bio, category, socketId, viewersCount }

app.get("/api/banners", (req, res) => {
  res.json({ banners: dbData.banners });
});

app.post("/api/admin/update-banners", (req, res) => {
  const { token, banner1, banner2 } = req.body;
  if (token !== "sukoon_admin_auth_verified_2026") {
    return res.status(403).json({ error: "अनधिकृत एक्सेस" });
  }
  dbData.banners = {
    banner1: {
      imageUrl: banner1?.imageUrl || "",
      title: banner1?.title || "",
      linkUrl: banner1?.linkUrl || ""
    },
    banner2: {
      imageUrl: banner2?.imageUrl || "",
      title: banner2?.title || "",
      linkUrl: banner2?.linkUrl || ""
    }
  };
  saveDB();
  io.emit("banners_updated", dbData.banners);
  res.json({ success: true, banners: dbData.banners });
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ success: true, token: "sukoon_admin_auth_verified_2026" });
  }
  return res.status(401).json({ success: false, error: "अमान्य यूज़रनेम या पासवर्ड!" });
});

app.post("/api/auth", (req, res) => {
  const { email, password, role, channelName, category, avatar, schedule, bio } = req.body;
  if (!email || !password) return res.status(400).json({ error: "ईमेल और पासवर्ड आवश्यक हैं" });

  let user = dbData.registeredUsers.find(u => u.email === email);
  if (!user) {
    user = {
      id: "usr_" + Math.random().toString(36).substr(2, 7),
      email,
      password,
      role: role || "viewer",
      channelName: channelName || email.split("@")[0],
      category: category || "General",
      avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${email}`,
      schedule: schedule || "रोज़ाना लाइव",
      bio: bio || (role === "creator" ? "सुकून क्रिएटर" : "सुकून दर्शक"),
      coins: 0,
      isApprovedCreator: role === "creator" ? false : true,
      joinedAt: new Date().toLocaleString()
    };
    dbData.registeredUsers.push(user);
    saveDB();
  } else {
    if (user.password !== password) {
      return res.status(401).json({ error: "गलत पासवर्ड!" });
    }
  }
  broadcastAdminStats();
  res.json({ success: true, user });
});

app.post("/api/admin/approve-creator", (req, res) => {
  const { email, token } = req.body;
  if (token !== "sukoon_admin_auth_verified_2026") {
    return res.status(403).json({ error: "अनधिकृत एक्सेस" });
  }
  const user = dbData.registeredUsers.find(u => u.email === email);
  if (user) {
    user.isApprovedCreator = true;
    saveDB();
    broadcastAdminStats();
    return res.json({ success: true, user });
  }
  res.status(404).json({ error: "यूज़र नहीं मिला" });
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

const broadcastAdminStats = () => {
  io.to("admin_ops_room").emit("admin_metrics", {
    onlineUsers: io.engine.clientsCount,
    activeSessions: Object.keys(activeRooms).length,
    waitingPoolCount: waitingPool.length,
    totalConnections: dbData.totalConnectionsCount,
    registeredUsers: dbData.registeredUsers,
    liveStreamsCount: liveStreams.length,
    incidents: dbData.incidents,
    banners: dbData.banners
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
  dbData.totalConnectionsCount++;
  saveDB();
  broadcastAdminStats();

  socket.on("join_admin", (data) => {
    if (data && data.token === "sukoon_admin_auth_verified_2026") {
      socket.join("admin_ops_room");
      broadcastAdminStats();
    }
  });

  socket.on("start_stream", ({ email, title, category }) => {
    const user = dbData.registeredUsers.find(u => u.email === email);
    if (!user || user.role !== "creator" || !user.isApprovedCreator) {
      return socket.emit("stream_error", { message: "केवल स्वीकृत क्रिएटर ही लाइव स्ट्रीम कर सकते हैं।" });
    }
    const streamId = "stream_" + socket.id;
    liveStreams = liveStreams.filter(s => s.socketId !== socket.id);
    const streamData = {
      streamId,
      streamerEmail: email,
      channelName: user.channelName,
      avatar: user.avatar,
      schedule: user.schedule,
      bio: user.bio,
      title: title || `${user.channelName} लाइव`,
      category: category || user.category || "Gaming",
      socketId: socket.id,
      viewersCount: 0
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

  // दर्शक का जुड़ना व लाइव व्यूअर काउंट अपडेट
  socket.on("join_stream", ({ streamId }) => {
    socket.join(streamId);
    const stream = liveStreams.find(s => s.streamId === streamId);
    if (stream) {
      stream.viewersCount = (stream.viewersCount || 0) + 1;
      io.to(streamId).emit("stream_viewers_updated", { count: stream.viewersCount });
      io.to(stream.socketId).emit("viewer_joined", { viewerSocketId: socket.id });
    }
  });

  socket.on("leave_stream", ({ streamId }) => {
    socket.leave(streamId);
    const stream = liveStreams.find(s => s.streamId === streamId);
    if (stream && stream.viewersCount > 0) {
      stream.viewersCount -= 1;
      io.to(streamId).emit("stream_viewers_updated", { count: stream.viewersCount });
    }
  });

  socket.on("send_stream_chat", ({ streamId, text, senderName }) => {
    if (!streamId || !text) return;
    io.to(streamId).emit("receive_stream_chat", {
      id: Math.random().toString(),
      senderName: senderName || "दर्शक",
      text,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    });
  });

  socket.on("stream_signal", ({ to, signal }) => {
    io.to(to).emit("stream_signal", { from: socket.id, signal });
  });

  // वर्चुअल गिफ़्ट + हाइलाइटेड सुपरचैट कार्ड
  socket.on("send_gift", ({ streamId, giftName, coins, senderName }) => {
    const stream = liveStreams.find(s => s.streamId === streamId);
    if (stream) {
      const creator = dbData.registeredUsers.find(u => u.email === stream.streamerEmail);
      if (creator) {
        creator.coins = (creator.coins || 0) + coins;
        saveDB();
      }
      io.to(streamId).emit("gift_received", {
        giftName,
        coins,
        senderName: senderName || "अनाम दर्शक",
        channelName: stream.channelName,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      });
      broadcastAdminStats();
    }
  });

  // 1-क्लिक रिपोर्ट / ब्लॉक सिस्टम
  socket.on("report_partner", ({ reason }) => {
    const roomId = userRooms[socket.id];
    if (roomId) {
      dbData.incidents.unshift({
        id: Math.random().toString(),
        room: roomId,
        user: socket.id.slice(0, 5) + "***",
        reason: reason || "यूज़र द्वारा रिपोर्ट किया गया",
        time: new Date().toLocaleTimeString()
      });
      if (dbData.incidents.length > 50) dbData.incidents.pop();
      saveDB();
      broadcastAdminStats();
      socket.to(roomId).emit("partner_disconnected");
      cleanup();
    }
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
      dbData.incidents.unshift({
        id: Math.random().toString(),
        room: roomId,
        user: socket.id.slice(0, 5) + "***",
        reason: "अमर्यादित भाषा",
        time: new Date().toLocaleTimeString()
      });
      if (dbData.incidents.length > 50) dbData.incidents.pop();
      saveDB();
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
  console.log(`>>> Sukoon Master V9 Active on port ${PORT}`);
});
