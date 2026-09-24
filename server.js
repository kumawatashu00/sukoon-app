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

const DB_FILE = path.join(__dirname, "database.json");
let dbData = {
  registeredUsers: [], totalConnectionsCount: 0, posts: [], stories: [], userConnections: {},
  banner: { imageUrl: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=800&auto=format&fit=crop&q=60", title: "सुकून कम्युनिटी में आपका स्वागत है 🌿" }
};

if (fs.existsSync(DB_FILE)) { try { const raw = fs.readFileSync(DB_FILE, "utf-8"); dbData = { ...dbData, ...JSON.parse(raw) }; if(!dbData.stories) dbData.stories=[]; if(!dbData.userConnections) dbData.userConnections={}; } catch (e) {} }

let saveTimeout = null;
const saveDB = () => { if (saveTimeout) clearTimeout(saveTimeout); saveTimeout = setTimeout(() => { try { fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2)); } catch (e) {} }, 1000); };
setInterval(() => { const now = Date.now(); dbData.stories = dbData.stories.filter(s => now - s.timestamp < 86400000); saveDB(); }, 3600000);

let liveStreams = []; const onlineLoggedInUsers = {}; let audioRoomsHub = {};

function calculateDistanceKM(lat1, lon1, lat2, lon2) {
  const R = 6371; const dLat = (lat2 - lat1) * (Math.PI / 180); const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); return Math.round(R * c);
}

// ------------------------------------------
// 👑 ADMIN PANEL APIs (RESTORED & FIXED) 👑
// ------------------------------------------
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  // एडमिन लॉगिन डिटेल्स: Username -> admin, Password -> admin123
  if (username === "admin" && password === "admin123") {
    res.json({ success: true, token: "sukoon_admin_secure_token" });
  } else {
    res.status(401).json({ error: "यूज़रनेम या पासवर्ड गलत है!" });
  }
});

app.get("/api/admin/dashboard", (req, res) => {
  res.json({
    users: dbData.registeredUsers,
    totalPosts: dbData.posts.length,
    totalStories: dbData.stories.length,
    activeStreams: liveStreams.length
  });
});

app.post("/api/admin/approve-creator", (req, res) => {
  const { email } = req.body;
  const user = dbData.registeredUsers.find(u => u.email === email);
  if (user) {
    user.isApprovedCreator = true; saveDB();
    res.json({ success: true, message: "क्रिएटर अप्रूव हो गया!" });
  } else { res.status(404).json({ error: "यूज़र नहीं मिला!" }); }
});

app.post("/api/admin/delete-user", (req, res) => {
  const { email } = req.body;
  dbData.registeredUsers = dbData.registeredUsers.filter(u => u.email !== email); saveDB();
  res.json({ success: true, message: "अकाउंट डिलीट हो गया!" });
});
// ------------------------------------------

// Normal User APIs
app.get("/api/banner", (req, res) => res.json({ banner: dbData.banner }));
app.post("/api/auth", (req, res) => {
  const { email, password, role, channelName, category, schedule, bio } = req.body;
  if (!email || !password) return res.status(400).json({ error: "ईमेल और पासवर्ड आवश्यक हैं" });
  let user = dbData.registeredUsers.find(u => u.email === email);
  if (!user) {
    user = { id: "usr_" + Date.now(), email, password, role: role || "viewer", channelName: channelName || email.split("@")[0], avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${email}`, category: category || "General", schedule: schedule || "", bio: bio || "", isApprovedCreator: role !== "creator", isPremium: true, joinedAt: new Date().toLocaleDateString() };
    dbData.registeredUsers.push(user); saveDB();
  } else if (user.password !== password) return res.status(401).json({ error: "गलत पासवर्ड!" });
  res.json({ success: true, user });
});
app.post("/api/user/update-profile", (req, res) => {
  const { email, channelName, avatar, bio } = req.body; const user = dbData.registeredUsers.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: "Not found" });
  if (channelName) user.channelName = channelName; if (avatar) user.avatar = avatar; if(bio) user.bio = bio; saveDB(); res.json({ success: true, user });
});

app.get("/api/posts", (req, res) => res.json({ posts: dbData.posts || [] }));
app.post("/api/posts/create", (req, res) => {
  const { email, media, mediaType, caption } = req.body; const user = dbData.registeredUsers.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: "लॉगिन आवश्यक है" });
  const newPost = { id: "post_" + Date.now(), authorEmail: user.email, authorName: user.channelName, authorAvatar: user.avatar, media: media || null, mediaType: mediaType || "image", caption: caption || "", likes: [], createdAt: new Date().toLocaleDateString() };
  dbData.posts.unshift(newPost); saveDB(); io.emit("new_post_published", newPost); res.json({ success: true, post: newPost });
});

app.get("/api/stories", (req, res) => res.json({ stories: dbData.stories }));
app.post("/api/stories/create", (req, res) => {
  const { email, media, text } = req.body; const user = dbData.registeredUsers.find(u => u.email === email);
  if (!user || (!media && !text)) return res.status(400).json({ error: "Invalid" });
  const newStory = { id: "sty_"+Date.now(), authorName: user.channelName, authorAvatar: user.avatar, isPremium: user.isPremium, media, timestamp: Date.now() };
  dbData.stories.unshift(newStory); saveDB(); io.emit("new_story", newStory); res.json({ success: true });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] }, maxHttpBufferSize: 2e7 });

let waitingPool = []; const activeRooms = {}; const userRooms = {};

io.on("connection", (socket) => {
  dbData.totalConnectionsCount++; saveDB(); io.emit("global_online_count", io.engine.clientsCount);
  socket.on("register_user_presence", ({ email, channelName, avatar, lat, lon }) => { onlineLoggedInUsers[socket.id] = { socketId: socket.id, email, channelName: channelName || email, avatar, lat: lat || null, lon: lon || null }; if(!dbData.userConnections[email]) dbData.userConnections[email] = []; socket.emit("my_connections_data", { connections: dbData.userConnections[email] }); });
  socket.on("get_nearby_users", ({ maxDistanceKM }) => { const current = onlineLoggedInUsers[socket.id]; if (!current || !current.lat || !current.lon) return socket.emit("nearby_users_list", { users: [] }); const list = []; for (const sid in onlineLoggedInUsers) { if (sid === socket.id) continue; const other = onlineLoggedInUsers[sid]; if (other.lat && other.lon) { const dist = calculateDistanceKM(current.lat, current.lon, other.lat, other.lon); if (dist <= (maxDistanceKM||100)) list.push({ socketId: other.socketId, email: other.email, channelName: other.channelName, avatar: other.avatar, distanceKM: dist }); } } list.sort((a, b) => a.distanceKM - b.distanceKM); socket.emit("nearby_users_list", { users: list }); });
  socket.on("add_friend", ({ myEmail, partnerSocketId }) => { const partner = onlineLoggedInUsers[partnerSocketId]; if(partner && myEmail && partner.email !== myEmail) { if(!dbData.userConnections[myEmail]) dbData.userConnections[myEmail] = []; const exists = dbData.userConnections[myEmail].find(c => c.email === partner.email); if(!exists) { dbData.userConnections[myEmail].push({ email: partner.email, peerName: partner.channelName, avatar: partner.avatar, isFriend: true, lastChatAt: new Date().toLocaleDateString() }); saveDB(); socket.emit("my_connections_data", { connections: dbData.userConnections[myEmail] }); } } });
  socket.on("find_partner", ({ mode, tag }) => { waitingPool = waitingPool.filter(u => u.socketId !== socket.id); const user = { socketId: socket.id, mode: mode || "text", tag: tag || "All" }; let index = waitingPool.findIndex(c => c.socketId !== user.socketId && c.mode === user.mode && c.tag === user.tag && user.tag !== "All"); if(index === -1) index = waitingPool.findIndex(c => c.socketId !== user.socketId && c.mode === user.mode); let match = null; if (index !== -1) match = waitingPool.splice(index, 1)[0]; if (match && io.sockets.sockets.get(match.socketId)) { const roomId = `room_${socket.id}_${match.socketId}`; socket.join(roomId); io.sockets.sockets.get(match.socketId).join(roomId); activeRooms[roomId] = { u1: socket.id, u2: match.socketId, mode: user.mode }; userRooms[socket.id] = roomId; userRooms[match.socketId] = roomId; io.to(match.socketId).emit("partner_found", { roomId, isInitiator: true, mode: user.mode, partnerSocketId: socket.id }); io.to(socket.id).emit("partner_found", { roomId, isInitiator: false, mode: match.mode, partnerSocketId: match.socketId }); } else { waitingPool.push(user); socket.emit("waiting_in_queue"); } });
  socket.on("send_message", ({ text }) => { const roomId = userRooms[socket.id]; if (roomId && text) socket.to(roomId).emit("receive_message", { text }); });
  socket.on("send_media", ({ imageBase64 }) => { const roomId = userRooms[socket.id]; if (roomId) socket.to(roomId).emit("receive_media", { imageBase64 }); });
  socket.on("webrtc_signal", (data) => { const roomId = userRooms[socket.id]; if (roomId) socket.to(roomId).emit("webrtc_signal", data); });
  socket.on("typing", () => { const roomId = userRooms[socket.id]; if(roomId) socket.to(roomId).emit("partner_typing"); });
  socket.on("game_invite", () => { const roomId = userRooms[socket.id]; if(roomId) socket.to(roomId).emit("game_invite_received"); });
  socket.on("game_accept", () => { const roomId = userRooms[socket.id]; if(roomId) io.to(roomId).emit("game_started"); });
  socket.on("game_move", (idx) => { const roomId = userRooms[socket.id]; if(roomId) socket.to(roomId).emit("game_move_received", idx); });
  socket.on("start_stream", (streamData) => { const sId = "stream_" + socket.id; liveStreams.push({ streamId: sId, streamerSocketId: socket.id, streamerEmail: streamData.email, title: streamData.title || "Live", channelName: streamData.channelName || "Creator", avatar: streamData.avatar || "", viewers: 0 }); socket.join(sId); io.emit("stream_list_updated", liveStreams); socket.emit("stream_started", { streamId: sId }); });
  socket.on("get_streams", () => { socket.emit("stream_list_updated", liveStreams); });
  socket.on("join_stream", ({ streamId }) => { const stream = liveStreams.find(s => s.streamId === streamId); if (stream) { socket.join(streamId); stream.viewers++; io.emit("stream_list_updated", liveStreams); } });
  socket.on("leave_stream", ({ streamId }) => { const stream = liveStreams.find(s => s.streamId === streamId); if (stream) { socket.leave(streamId); stream.viewers = Math.max(0, stream.viewers - 1); io.emit("stream_list_updated", liveStreams); } });
  socket.on("send_stream_chat", ({ streamId, text, senderName }) => { io.to(streamId).emit("receive_stream_chat", { senderName, text }); });
  socket.on("get_audio_rooms", () => { socket.emit("audio_rooms_list", Object.values(audioRoomsHub)); });
  socket.on("create_audio_room", ({ roomName, userProfile }) => { const roomId = "audio_" + Date.now(); audioRoomsHub[roomId] = { roomId, roomName, creator: userProfile.channelName, participants: [] }; io.emit("audio_rooms_list", Object.values(audioRoomsHub)); socket.emit("audio_room_created", roomId); });
  socket.on("join_audio_room", ({ roomId, userProfile }) => { if(audioRoomsHub[roomId]) { const pData = { socketId: socket.id, profile: userProfile, isMuted: false, handRaised: false }; audioRoomsHub[roomId].participants.push(pData); socket.join(roomId); userRooms[socket.id] = roomId; socket.emit("audio_room_joined", { roomId, roomName: audioRoomsHub[roomId].roomName, participants: audioRoomsHub[roomId].participants }); socket.to(roomId).emit("audio_user_joined", pData); io.emit("audio_rooms_list", Object.values(audioRoomsHub)); } });
  socket.on("audio_webrtc_offer", ({ targetSocketId, sdp }) => { socket.to(targetSocketId).emit("audio_webrtc_offer", { fromSocketId: socket.id, sdp }); });
  socket.on("audio_webrtc_answer", ({ targetSocketId, sdp }) => { socket.to(targetSocketId).emit("audio_webrtc_answer", { fromSocketId: socket.id, sdp }); });
  socket.on("audio_webrtc_ice", ({ targetSocketId, candidate }) => { socket.to(targetSocketId).emit("audio_webrtc_ice", { fromSocketId: socket.id, candidate }); });
  socket.on("audio_toggle_mic", ({ roomId, isMuted }) => { if(audioRoomsHub[roomId]) { const p = audioRoomsHub[roomId].participants.find(x => x.socketId === socket.id); if(p) { p.isMuted = isMuted; io.to(roomId).emit("audio_participant_updated", p); } } });
  socket.on("audio_raise_hand", ({ roomId, handRaised }) => { if(audioRoomsHub[roomId]) { const p = audioRoomsHub[roomId].participants.find(x => x.socketId === socket.id); if(p) { p.handRaised = handRaised; io.to(roomId).emit("audio_participant_updated", p); } } });
  socket.on("audio_send_reaction", ({ roomId, emoji }) => { io.to(roomId).emit("audio_reaction_received", { socketId: socket.id, emoji }); });
  const cleanup = () => { delete onlineLoggedInUsers[socket.id]; waitingPool = waitingPool.filter(u => u.socketId !== socket.id); const roomId = userRooms[socket.id]; if (roomId && roomId.startsWith("audio_")) { if (audioRoomsHub[roomId]) { audioRoomsHub[roomId].participants = audioRoomsHub[roomId].participants.filter(x => x.socketId !== socket.id); socket.to(roomId).emit("audio_user_left", socket.id); if (audioRoomsHub[roomId].participants.length === 0) delete audioRoomsHub[roomId]; io.emit("audio_rooms_list", Object.values(audioRoomsHub)); } socket.leave(roomId); delete userRooms[socket.id]; } else if (roomId) { socket.to(roomId).emit("partner_disconnected"); socket.leave(roomId); delete activeRooms[roomId]; delete userRooms[socket.id]; } const streamIdx = liveStreams.findIndex(s => s.streamerSocketId === socket.id); if (streamIdx !== -1) { const sId = liveStreams[streamIdx].streamId; io.to(sId).emit("stream_ended"); liveStreams.splice(streamIdx, 1); io.emit("stream_list_updated", liveStreams); } io.emit("global_online_count", io.engine.clientsCount); };
  socket.on("leave_chat", cleanup); socket.on("leave_audio_room", cleanup); socket.on("disconnect", cleanup);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`>>> Sukoon Master Active with Admin APIs on port ${PORT}`));
