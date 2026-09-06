const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ limit: "25mb", extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/ping", (req, res) => res.send("pong 24x7 active"));

const ADMIN_USER = "ashok_admin";
const ADMIN_PASS = "Sukoon@2026#Secure";
const DB_FILE = path.join(__dirname, "database.json");

let dbData = {
  registeredUsers: [],
  totalConnectionsCount: 0,
  incidents: [],
  userConnections: {}, // { email: [ { peerEmail, peerName, isFriend, isBlocked, lastChatAt } ] }
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

function calculateDistanceKM(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

let liveStreams = [];
const onlineLoggedInUsers = {};

app.get("/api/banners", (req, res) => {
  res.json({ banners: dbData.banners });
});

app.post("/api/admin/update-banners", (req, res) => {
  const { token, banner1, banner2 } = req.body;
  if (token !== "sukoon_admin_auth_verified_2026") {
    return res.status(403).json({ error: "अनधिकृत एक्सेस" });
  }
  dbData.banners = {
    banner1: { imageUrl: banner1?.imageUrl || "", title: banner1?.title || "", linkUrl: banner1?.linkUrl || "" },
    banner2: { imageUrl: banner2?.imageUrl || "", title: banner2?.title || "", linkUrl: banner2?.linkUrl || "" }
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

app.post("/api/user/update-profile", (req, res) => {
  const { email, channelName, avatar, bio } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const user = dbData.registeredUsers.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (channelName) user.channelName = channelName;
  if (avatar) user.avatar = avatar;
  if (bio !== undefined) user.bio = bio;

  saveDB();
  broadcastAdminStats();
  res.json({ success: true, user });
});

// 🔥 फ्रेंड टॉगल API (Add Friend / Unfriend / Block)
app.post("/api/user/manage-friend", (req, res) => {
  const { myEmail, peerEmail, action } = req.body; // action: 'add_friend', 'unfriend', 'block', 'unblock'
  if (!myEmail || !peerEmail) return res.status(400).json({ error: "Data missing" });

  if (!dbData.userConnections[myEmail]) dbData.userConnections[myEmail] = [];
  let item = dbData.userConnections[myEmail].find(c => c.peerEmail === peerEmail);

  if (!item) {
    const peerUser = dbData.registeredUsers.find(u => u.email === peerEmail);
    item = {
      peerEmail,
      peerName: peerUser?.channelName || peerEmail.split('@')[0],
      isFriend: false,
      isBlocked: false,
      lastChatAt: "आज"
    };
    dbData.userConnections[myEmail].unshift(item);
  }

  if (action === "add_friend") {
    item.isFriend = true;
    item.isBlocked = false;
  } else if (action === "unfriend") {
    item.isFriend = false;
  } else if (action === "block") {
    item.isBlocked = true;
    item.isFriend = false;
  } else if (action === "unblock") {
    item.isBlocked = false;
  }

  saveDB();
  res.json({ success: true, item });
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

function saveMutualConnection(email1, name1, email2, name2) {
  if (!email1 || !email2 || email1 === email2) return;
  if (!dbData.userConnections) dbData.userConnections = {};

  if (!dbData.userConnections[email1]) dbData.userConnections[email1] = [];
  if (!dbData.userConnections[email2]) dbData.userConnections[email2] = [];

  const timeStr = new Date().toLocaleDateString([], { month: "short", day: "numeric" });

  const idx1 = dbData.userConnections[email1].findIndex(c => c.peerEmail === email2);
  if (idx1 === -1) {
    dbData.userConnections[email1].unshift({ peerEmail: email2, peerName: name2 || email2.split('@')[0], isFriend: false, isBlocked: false, lastChatAt: timeStr });
  } else {
    dbData.userConnections[email1][idx1].lastChatAt = timeStr;
  }

  const idx2 = dbData.userConnections[email2].findIndex(c => c.peerEmail === email1);
  if (idx2 === -1) {
    dbData.userConnections[email2].unshift({ peerEmail: email1, peerName: name1 || email1.split('@')[0], isFriend: false, isBlocked: false, lastChatAt: timeStr });
  } else {
    dbData.userConnections[email2][idx2].lastChatAt = timeStr;
  }

  saveDB();
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

  socket.on("register_user_presence", ({ email, channelName, avatar, lat, lon }) => {
    onlineLoggedInUsers[socket.id] = {
      socketId: socket.id,
      email,
      channelName: channelName || email.split('@')[0],
      avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${email}`,
      lat: lat || null,
      lon: lon || null
    };
    io.emit("presence_updated");
  });

  socket.on("get_nearby_users", ({ maxDistanceKM }) => {
    const current = onlineLoggedInUsers[socket.id];
    if (!current || !current.lat || !current.lon) {
      return socket.emit("nearby_users_list", { users: [] });
    }
    const limit = maxDistanceKM || 100;
    const list = [];

    for (const sid in onlineLoggedInUsers) {
      if (sid === socket.id) continue;
      const other = onlineLoggedInUsers[sid];
      if (other.lat && other.lon) {
        const dist = calculateDistanceKM(current.lat, current.lon, other.lat, other.lon);
        if (dist <= limit) {
          list.push({
            socketId: other.socketId,
            email: other.email,
            channelName: other.channelName,
            avatar: other.avatar,
            distanceKM: dist
          });
        }
      }
    }
    list.sort((a, b) => a.distanceKM - b.distanceKM);
    socket.emit("nearby_users_list", { users: list });
  });

  // कनेक्शन्स व फ्रेंड्स लोड करना
  socket.on("get_my_connections", ({ email }) => {
    if (!email) return;
    const history = (dbData.userConnections && dbData.userConnections[email]) || [];
    const onlineEmails = new Set(Object.values(onlineLoggedInUsers).map(u => u.email));

    const enriched = history.map(conn => {
      const reg = dbData.registeredUsers.find(r => r.email === conn.peerEmail);
      return {
        ...conn,
        avatar: reg?.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${conn.peerEmail}`,
        isOnline: onlineEmails.has(conn.peerEmail),
        isFriend: !!conn.isFriend,
        isBlocked: !!conn.isBlocked
      };
    });

    socket.emit("my_connections_data", { connections: enriched });
  });

  socket.on("send_nearby_request", ({ toSocketId }) => {
    const sender = onlineLoggedInUsers[socket.id];
    if (sender && io.sockets.sockets.get(toSocketId)) {
      io.to(toSocketId).emit("receive_chat_request", {
        fromSocketId: socket.id,
        fromName: sender.channelName,
        fromAvatar: sender.avatar,
        fromEmail: sender.email
      });
    }
  });

  socket.on("accept_chat_request", ({ fromSocketId }) => {
    const receiver = onlineLoggedInUsers[socket.id];
    const sender = onlineLoggedInUsers[fromSocketId];

    if (sender && receiver && io.sockets.sockets.get(fromSocketId)) {
      const roomId = `pvt_${socket.id}_${fromSocketId}`;
      socket.join(roomId);
      io.sockets.sockets.get(fromSocketId).join(roomId);

      activeRooms[roomId] = { u1: socket.id, u2: fromSocketId, mode: "text", createdAt: Date.now() };
      userRooms[socket.id] = roomId;
      userRooms[fromSocketId] = roomId;

      saveMutualConnection(sender.email, sender.channelName, receiver.email, receiver.channelName);

      io.to(fromSocketId).emit("partner_found", { roomId, isInitiator: true, tag: "Nearby", partnerName: receiver.channelName, partnerEmail: receiver.email });
      io.to(socket.id).emit("partner_found", { roomId, isInitiator: false, tag: "Nearby", partnerName: sender.channelName, partnerEmail: sender.email });
      broadcastAdminStats();
    }
  });

  // लाइव स्ट्रीमिंग
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

  socket.on("find_partner", ({ mode, tag, email, name }) => {
    waitingPool = waitingPool.filter(u => u.socketId !== socket.id);
    const user = { socketId: socket.id, mode: mode || "text", tag: tag || "All", email, name };
    const match = attemptSmartMatch(user);

    if (match && io.sockets.sockets.get(match.socketId)) {
      const roomId = `room_${socket.id}_${match.socketId}`;
      socket.join(roomId);
      io.sockets.sockets.get(match.socketId).join(roomId);

      activeRooms[roomId] = { u1: socket.id, u2: match.socketId, mode: user.mode, createdAt: Date.now() };
      userRooms[socket.id] = roomId;
      userRooms[match.socketId] = roomId;

      if (user.email && match.email) {
        saveMutualConnection(user.email, user.name, match.email, match.name);
      }

      io.to(match.socketId).emit("partner_found", { roomId, isInitiator: true, tag: user.tag, partnerName: user.name, partnerEmail: user.email });
      io.to(socket.id).emit("partner_found", { roomId, isInitiator: false, tag: match.tag, partnerName: match.name, partnerEmail: match.email });
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
    delete onlineLoggedInUsers[socket.id];
    io.emit("presence_updated");

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
  console.log(`>>> Sukoon Master V11 (Friends & Blocking System) Active on port ${PORT}`);
});
