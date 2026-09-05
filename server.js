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

const CRISIS_WORDS = ["suicide", "mar jana", "die", "kill myself", "zehar", "faansi", "depressed", "help me die"];
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
    incidents: incidentReports
  });
};

function attemptMatch(user) {
  const index = waitingPool.findIndex((candidate) => {
    if (candidate.socketId === user.socketId) return false;
    const topicMatch = candidate.topic === user.topic || user.topic === "General" || candidate.topic === "General";
    if (!topicMatch) return false;
    const candidateWantsUser = candidate.lookingFor === "any" || candidate.lookingFor === user.gender;
    const userWantsCandidate = user.lookingFor === "any" || user.lookingFor === candidate.gender;
    return candidateWantsUser && userWantsCandidate;
  });

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

  socket.on("find_partner", (payload) => {
    const user = {
      socketId: socket.id,
      gender: payload.gender || "male",
      lookingFor: payload.lookingFor || "any",
      topic: payload.topic || "General",
      mood: payload.mood || "सामान्य ☕",
      isGuest: payload.isGuest ?? true
    };

    waitingPool = waitingPool.filter(u => u.socketId !== socket.id);
    const match = attemptMatch(user);

    if (match && io.sockets.sockets.get(match.socketId)) {
      const roomId = `room_${socket.id}_${match.socketId}`;
      socket.join(roomId);
      io.sockets.sockets.get(match.socketId).join(roomId);

      activeRooms[roomId] = {
        u1: socket.id,
        u2: match.socketId,
        topic: user.topic,
        createdAt: Date.now(),
        callConsented: false
      };

      userRooms[socket.id] = roomId;
      userRooms[match.socketId] = roomId;

      io.to(match.socketId).emit("partner_found", {
        roomId,
        isInitiator: true,
        partnerGender: user.gender,
        partnerMood: user.mood
      });

      io.to(socket.id).emit("partner_found", {
        roomId,
        isInitiator: false,
        partnerGender: match.gender,
        partnerMood: match.mood
      });
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

    if (CRISIS_WORDS.some(w => lower.includes(w))) {
      socket.emit("crisis_alert", {
        message: "आपका जीवन अनमोल है। Tele-MANAS (14416) पर तुरंत निःशुल्क सहायता प्राप्त करें।"
      });
    }

    if (ABUSE_WORDS.some(w => lower.includes(w))) {
      socket.emit("message_rejected", {
        reason: "यह संदेश सुरक्षा नीति का उल्लंघन करता है। कृपया मर्यादित भाषा का प्रयोग करें।"
      });
      incidentReports.unshift({
        id: Math.random().toString(),
        room: roomId,
        user: socket.id.slice(0, 5) + "***",
        reason: "Toxic language detected",
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
      type: "text",
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
        type: "image",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      });
    }
  });

  socket.on("request_icebreaker", () => {
    const roomId = userRooms[socket.id];
    if (roomId) {
      const ICEBREAKERS = [
        "अगर आज आप किसी एक चीज़ को अपनी ज़िंदगी से मिटा सकें, तो वह क्या होगी?",
        "आखिरी बार आप दिल खोलकर कब हँसे थे?",
        "आज के दिन को 10 में से कितने नंबर दोगे और क्यों?",
        "कोई ऐसा गाना जिसे सुनकर आपका मन शांत हो जाता है?",
        "जिंदगी की वह कौन सी बात है जो आप किसी अपने को नहीं बता पाते?"
      ];
      const randomQ = ICEBREAKERS[Math.floor(Math.random() * ICEBREAKERS.length)];
      io.to(roomId).emit("new_icebreaker", { question: randomQ });
    }
  });

  socket.on("request_call_consent", () => {
    const roomId = userRooms[socket.id];
    if (roomId) socket.to(roomId).emit("incoming_call_request");
  });

  socket.on("accept_call_consent", () => {
    const roomId = userRooms[socket.id];
    if (roomId && activeRooms[roomId]) {
      activeRooms[roomId].callConsented = true;
      io.to(roomId).emit("call_consent_granted");
    }
  });

  socket.on("webrtc_signal", (data) => {
    const roomId = userRooms[socket.id];
    if (roomId) socket.to(roomId).emit("webrtc_signal", data);
  });

  socket.on("report_user", ({ reason }) => {
    const roomId = userRooms[socket.id];
    incidentReports.unshift({
      id: Math.random().toString(),
      room: roomId || "N/A",
      user: socket.id.slice(0, 5) + "***",
      reason: reason || "User Report",
      time: new Date().toLocaleTimeString()
    });
    broadcastAdminStats();
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

  socket.on("skip_partner", cleanup);
  socket.on("disconnect", cleanup);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`>>> Sukoon India Engine active on port ${PORT}`);
});
