const express = require('express');
const http = require('http');
const dotenv = require('dotenv');
const cors = require('cors');
const { Server } = require('socket.io');
const connectDB = require('./config/db');

// Load config
dotenv.config();
connectDB();

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/rides', require('./routes/rideRoutes'));

// Socket.io Setup
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000", // Your Frontend URL
    methods: ["GET", "POST"]
  }
});

// Pass io to routes via request object if needed, or handle here
app.set('io', io);

io.on('connection', (socket) => {
  console.log('User Connected:', socket.id);

  socket.on('join_driver_room', () => {
    socket.join('drivers');
  });

  socket.on('request_ride', (data) => {
    // Broadcast to all drivers
    socket.to('drivers').emit('ride_available', data);
  });

  socket.on('accept_ride', (data) => {
    // Notify specific parent
    io.to(data.parentId).emit('ride_accepted', data);
  });
  
  socket.on('update_location', (data) => {
    // Send live coordinates to parent
    io.to(data.parentId).emit('driver_location', data.coords);
  });

  socket.on('disconnect', () => {
    console.log('User Disconnected');
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));