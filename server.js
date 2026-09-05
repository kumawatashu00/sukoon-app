const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7
});

app.use(express.static(path.join(__dirname, "public")));

const waitingQueues = {};
const activeRooms = {};
const userRooms = {};

io.on("connection", (socket) => {
  socket.on("find_partner", ({ topic }) => {
    const t = topic || "General";
    if (!waitingQueues[t]) waitingQueues[t] = [];

    if (waitingQueues[t].length > 0) {
      const partner = waitingQueues[t].shift();
      if (io.sockets.sockets.get(partner)) {
        const roomId = `room_${socket.id}_${partner}`;
        socket.join(roomId);
        io.sockets.sockets.get(partner).join(roomId);
        userRooms[socket.id] = roomId;
        userRooms[partner] = roomId;

        io.to(partner).emit("partner_found", { isInitiator: true });
        io.to(socket.id).emit("partner_found", { isInitiator: false });
      } else {
        waitingQueues[t].push(socket.id);
        socket.emit("waiting");
      }
    } else {
      waitingQueues[t].push(socket.id);
      socket.emit("waiting");
    }
  });

  socket.on("send_message", (msg) => {
    const r = userRooms[socket.id];
    if (r) socket.to(r).emit("receive_message", { text: msg, sender: "partner" });
  });

  socket.on("send_media", (base64) => {
    const r = userRooms[socket.id];
    if (r) socket.to(r).emit("receive_media", { image: base64 });
  });

  socket.on("webrtc_signal", (data) => {
    const r = userRooms[socket.id];
    if (r) socket.to(r).emit("webrtc_signal", data);
  });

  const leave = () => {
    const r = userRooms[socket.id];
    for (const k in waitingQueues) {
      waitingQueues[k] = waitingQueues[k].filter(id => id !== socket.id);
    }
    if (r) {
      socket.to(r).emit("partner_disconnected");
      socket.leave(r);
      delete userRooms[socket.id];
    }
  };

  socket.on("skip", leave);
  socket.on("disconnect", leave);
});

server.listen(5000, () => {
  console.log("=========================================");
  console.log(">>> SUKOON APP LIVE: http://localhost:5000");
  console.log("=========================================");
});
