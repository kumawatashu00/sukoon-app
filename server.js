const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/ping", (req, res) => res.send("pong active"));

const DB_FILE = path.join(__dirname, "database.json");
let dbData = {
  registeredUsers: [], totalConnectionsCount: 0, incidents: [],
  userConnections: {}, posts: [], follows: {}, stories: [],
  banner: { imageUrl: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=800&auto=format&fit=crop&q=60", title: "सुकून कम्युनिटी में आपका स्वागत है 🌿", linkUrl: "" }
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf-8");
    dbData = { ...dbData, ...JSON.parse(raw) };
    if (!dbData.stories) dbData.stories = [];
  } catch (e) {}
}

let saveTimeout = null;
const saveDB = () => { if (saveTimeout) clearTimeout(saveTimeout); saveTimeout = setTimeout(() => { try { fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2)); } catch (e) {} }, 1000); };

// Stories Cleanup (24h)
setInterval(() => {
  const now = Date.now(); const oldLen = dbData.stories.length;
  dbData.stories = dbData.stories.filter(s => now - s.timestamp < 86400000);
  if(dbData.stories.length !== oldLen) saveDB();
}, 3600000);

let liveStreams = []; const onlineLoggedInUsers = {};

function calculateDistanceKM(lat1, lon1, lat2, lon2) {
  const R = 6371; const dLat = (lat2 - lat1) * (Math.PI / 180); const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); return Math.round(R * c);
}

// APIs
app.get("/api/banner", (req, res) => res.json({ banner: dbData.banner }));
app.post("/api/auth", (req, res) => {
  const { email, password, role, channelName, category, avatar, schedule, bio } = req.body;
  if (!email || !password) return res.status(400).json({ error: "ईमेल और पासवर्ड आवश्यक हैं" });
  let user = dbData.registeredUsers.find(u => u.email === email);
  if (!user) {
    user = { id: "usr_" + Math.random().toString(36).substr(2, 7), email, password, role: role || "viewer", channelName: channelName || email.split("@")[0], category: category || "General", avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${email}`, schedule: schedule || "रोज़ाना लाइव", bio: bio || "सुकून यूज़र", coins: 0, isApprovedCreator: role !== "creator", isBanned: false, isPremium: false, joinedAt: new Date().toLocaleDateString() };
    dbData.registeredUsers.push(user); saveDB();
  } else {
    if (user.password !== password) return res.status(401).json({ error: "गलत पासवर्ड!" });
    if (user.isBanned) return res.status(403).json({ error: "अकाउंट बैन है!" });
  }
  res.json({ success: true, user });
});
app.post("/api/user/update-profile", (req, res) => {
  const { email, channelName, avatar, bio } = req.body; const user = dbData.registeredUsers.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (channelName) user.channelName = channelName; if (avatar) user.avatar = avatar; if (bio !== undefined) user.bio = bio; saveDB(); res.json({ success: true, user });
});
app.get("/api/posts", (req, res) => res.json({ posts: dbData.posts || [] }));
app.post("/api/posts/create", (req, res) => {
  const { email, media, mediaType, caption } = req.body; const user = dbData.registeredUsers.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: "लॉगिन आवश्यक है" });
  const newPost = { id: "post_" + Date.now(), authorEmail: user.email, authorName: user.channelName, authorAvatar: user.avatar, media: media || null, mediaType: mediaType || "image", caption: caption || "", likes: [], createdAt: new Date().toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) };
  dbData.posts.unshift(newPost); saveDB(); io.emit("new_post_published", newPost); res.json({ success: true, post: newPost });
});
app.post("/api/posts/like", (req, res) => {
  const { postId, email } = req.body; const post = dbData.posts.find(p => p.id === postId); if (!post || !email) return res.status(404).json({ error: "Error" });
  const idx = post.likes.indexOf(email); if (idx === -1) post.likes.push(email); else post.likes.splice(idx, 1);
  saveDB(); io.emit("post_liked", { postId, likesCount: post.likes.length, likes: post.likes }); res.json({ success: true });
});
app.get("/api/stories", (req, res) => res.json({ stories: dbData.stories }));
app.post("/api/stories/create", (req, res) => {
  const { email, media, text } = req.body; const user = dbData.registeredUsers.find(u => u.email === email);
  if (!user || (!media && !text)) return res.status(400).json({ error: "Invalid" });
  const newStory = { id: "sty_"+Date.now(), authorEmail: user.email, authorName: user.channelName, authorAvatar: user.avatar, isPremium: user.isPremium, media, text, timestamp: Date.now() };
  dbData.stories.unshift(newStory); saveDB(); io.emit("new_story", newStory); res.json({ success: true });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] }, maxHttpBufferSize: 2e7 });

let waitingPool = []; const activeRooms = {}; const userRooms = {};

io.on("connection", (socket) => {
  dbData.totalConnectionsCount++; saveDB(); io.emit("global_online_count", io.engine.clientsCount);
  
  socket.on("register_user_presence", ({ email, channelName, avatar, lat, lon }) => { onlineLoggedInUsers[socket.id] = { socketId: socket.id, email, channelName: channelName || email, avatar, lat: lat || null, lon: lon || null }; });
  
  socket.on("get_nearby_users", ({ maxDistanceKM }) => {
    const current = onlineLoggedInUsers[socket.id]; if (!current || !current.lat || !current.lon) return socket.emit("nearby_users_list", { users: [] });
    const list = [];
    for (const sid in onlineLoggedInUsers) {
      if (sid === socket.id) continue; const other = onlineLoggedInUsers[sid];
      if (other.lat && other.lon) {
        const dist = calculateDistanceKM(current.lat, current.lon, other.lat, other.lon);
        if (dist <= (maxDistanceKM||100)) list.push({ socketId: other.socketId, email: other.email, channelName: other.channelName, avatar: other.avatar, distanceKM: dist });
      }
    }
    list.sort((a, b) => a.distanceKM - b.distanceKM); socket.emit("nearby_users_list", { users: list });
  });

  socket.on("find_partner", ({ mode, tag, email, name }) => {
    waitingPool = waitingPool.filter(u => u.socketId !== socket.id);
    const user = { socketId: socket.id, mode: mode || "text", tag: tag || "All", email, name };
    let index = waitingPool.findIndex(c => c.socketId !== user.socketId && c.mode === user.mode && c.tag === user.tag && user.tag !== "All");
    if (index === -1) index = waitingPool.findIndex(c => c.socketId !== user.socketId && c.mode === user.mode);
    let match = null; if (index !== -1) match = waitingPool.splice(index, 1)[0];
    if (match && io.sockets.sockets.get(match.socketId)) {
      const roomId = `room_${socket.id}_${match.socketId}`; socket.join(roomId); io.sockets.sockets.get(match.socketId).join(roomId);
      activeRooms[roomId] = { u1: socket.id, u2: match.socketId, mode: user.mode, createdAt: Date.now() }; userRooms[socket.id] = roomId; userRooms[match.socketId] = roomId;
      io.to(match.socketId).emit("partner_found", { roomId, isInitiator: true, tag: user.tag, partnerName: user.name, mode: user.mode });
      io.to(socket.id).emit("partner_found", { roomId, isInitiator: false, tag: match.tag, partnerName: match.name, mode: match.mode });
    } else { waitingPool.push(user); socket.emit("waiting_in_queue"); }
  });

  socket.on("send_message", ({ text }) => { const roomId = userRooms[socket.id]; if (roomId && text) socket.to(roomId).emit("receive_message", { text }); });
  socket.on("send_media", ({ imageBase64 }) => { const roomId = userRooms[socket.id]; if (roomId) socket.to(roomId).emit("receive_media", { imageBase64 }); });
  socket.on("webrtc_signal", (data) => { const roomId = userRooms[socket.id]; if (roomId) socket.to(roomId).emit("webrtc_signal", data); });
  
  // 🎮 GAME SOCKETS
  socket.on("game_invite", () => { const roomId = userRooms[socket.id]; if(roomId) socket.to(roomId).emit("game_invite_received"); });
  socket.on("game_accept", () => { const roomId = userRooms[socket.id]; if(roomId) io.to(roomId).emit("game_started"); });
  socket.on("game_move", (idx) => { const roomId = userRooms[socket.id]; if(roomId) socket.to(roomId).emit("game_move_received", idx); });

  const cleanup = () => {
    delete onlineLoggedInUsers[socket.id]; waitingPool = waitingPool.filter(u => u.socketId !== socket.id);
    const roomId = userRooms[socket.id];
    if (roomId) { socket.to(roomId).emit("partner_disconnected"); socket.leave(roomId); delete activeRooms[roomId]; delete userRooms[socket.id]; }
    io.emit("global_online_count", io.engine.clientsCount);
  };
  socket.on("leave_chat", cleanup); socket.on("disconnect", cleanup);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`>>> Sukoon Ultra-Pro Active on port ${PORT}`));
