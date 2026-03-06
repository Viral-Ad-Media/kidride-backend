# KidRide Backend API

Express + MongoDB backend for KidRide authentication, profile management, child profiles, and ride lifecycle operations.

## Production
- API base URL: `https://kidride-backend.vercel.app/api`
- Primary frontend URL: `https://kid-ride.vercel.app/`

## Tech Stack
- Node.js
- Express 5
- MongoDB + Mongoose
- JWT authentication
- Socket.IO

## Project Structure
```text
kidride-backend/
  config/
    db.js                # Mongo connection
  middleware/
    authMiddleware.js    # JWT guard
  models/
    User.js              # User + embedded children schema
    Ride.js              # Ride lifecycle schema
  routes/
    authRoutes.js        # /api/auth/*
    userRoutes.js        # /api/users/*
    rideRoutes.js        # /api/rides/*
  server.js              # App bootstrap, CORS, Socket.IO
```

## Prerequisites
- Node.js 18+ (Node.js 20+ recommended)
- npm
- MongoDB connection string

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create `.env` in project root:
   ```bash
   MONGO_URI=your_mongodb_connection_string
   JWT_SECRET=replace_with_long_random_secret
   PORT=5000
   FRONTEND_URLS=http://localhost:3000,http://localhost:5173,https://kid-ride.vercel.app
   RATE_LIMIT_WINDOW_MS=900000
   RATE_LIMIT_MAX_REQUESTS=300
   AUTH_RATE_LIMIT_WINDOW_MS=900000
   AUTH_RATE_LIMIT_MAX_ATTEMPTS=20
   RIDE_REQUEST_RATE_LIMIT_WINDOW_MS=60000
   RIDE_REQUEST_RATE_LIMIT_MAX_REQUESTS=10
   ```
3. Start the server:
   ```bash
   node server.js
   ```

## Environment Variables
- `MONGO_URI` required, MongoDB connection URI.
- `JWT_SECRET` required, signing key for JWT access tokens.
- `PORT` optional, defaults to `5000`.
- `FRONTEND_URLS` optional, comma-separated CORS allowlist for HTTP + Socket.IO.
- `RATE_LIMIT_WINDOW_MS` optional, global limit window in ms (default `900000`).
- `RATE_LIMIT_MAX_REQUESTS` optional, global max requests per window (default `300`).
- `AUTH_RATE_LIMIT_WINDOW_MS` optional, auth routes window in ms (default `900000`).
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS` optional, max auth attempts per window (default `20`).
- `RIDE_REQUEST_RATE_LIMIT_WINDOW_MS` optional, ride request window in ms (default `60000`).
- `RIDE_REQUEST_RATE_LIMIT_MAX_REQUESTS` optional, max ride requests per window (default `10`).

## Authentication
- Protected routes require:
  - Header: `Authorization: Bearer <token>`
- Token generation:
  - 30-day expiry (`jsonwebtoken`)

## API Endpoints

### Auth (`/api/auth`)
- `POST /register`
  - Body: `name`, `email`, `password`, optional `role` (`parent|driver|admin`)
- `POST /login`
  - Body: `email`, `password`
- `GET /me` (protected)
  - Returns current authenticated user payload

### Users (`/api/users`) (all protected)
- `GET /profile`
  - Returns user profile
- `PUT /profile`
  - Body (optional): `name`, `phone`, `photoUrl`
- `GET /children`
  - Returns current user children array
- `POST /children`
  - Body: `name`, `age`, optional `notes`, `photoUrl`
- `POST /driver-application`
  - Body: optional `phone`, and vehicle either as `vehicle` object or individual `make/model/year/color/plate`
  - Sets `driverApplicationStatus` to `pending`

### Rides (`/api/rides`) (all protected)
- `POST /request`
  - Body supports:
    - `childId` or `child`
    - `pickup` or `pickupLocation`
    - `dropoff` or `dropoffLocation`
    - `price`
    - optional `pickupTime`, `serviceType`
- `GET /open`
  - Driver/Admin only
  - Query: `limit` (default `20`, max `100`)
- `GET /active`
  - Returns latest non-terminal ride for parent or driver
- `GET /`
  - Query:
    - `scope=all|active|upcoming|past`
    - `limit` (default `50`, max `100`)
- `GET /:id`
  - Parent, assigned driver, or admin
- `PUT /:id/accept`
  - Driver/Admin only
  - Assigns current driver and sets status to `driver_assigned`
- `PUT /:id/status`
  - Driver/Admin only
  - Body: `status`
- `PUT /:id/cancel`
  - Parent, assigned driver, or admin

## Ride Statuses
- `requested`
- `searching_driver`
- `driver_assigned`
- `driver_arrived_at_pickup`
- `child_picked_up`
- `completed`
- `cancelled`

## Driver Status Transition Rules
- `driver_assigned` -> `driver_arrived_at_pickup` or `cancelled`
- `driver_arrived_at_pickup` -> `child_picked_up` or `cancelled`
- `child_picked_up` -> `completed`

## Socket.IO Events
Server events configured in `server.js`.

### Client to Server
- `join_driver_room`
- `request_ride`
- `accept_ride`
- `update_location`

### Server to Client
- `ride_available`
- `ride_accepted`
- `driver_location`
- `ride_status_updated` (emitted by route handlers)

## CORS
- HTTP and Socket.IO both use `FRONTEND_URLS`.
- Default allowlist if env is missing:
  - `http://localhost:3000`
  - `http://localhost:5173`

## Rate Limiting
- Global limiter is applied to all API routes.
- Stricter limiter is applied to:
  - `POST /api/auth/register`
  - `POST /api/auth/login`
- Per-user limiter is applied to:
  - `POST /api/rides/request`

When exceeded, API returns:
- `429 Too Many Requests`
- `Retry-After` header
- JSON body with `message` and `retryAfterSeconds`

## Notes for Frontend Integration
- Frontend expects user payload shape with:
  - `id`, `name`, `email`, `role`, `children`, `driverApplicationStatus`
- Frontend maps ride payloads from:
  - `id/_id`, `child`, `driver`, `pickupLocation`, `dropoffLocation`, `status`, `serviceType`

## Operational Notes
- No test suite is currently configured in `package.json`.
- For local development, run frontend and backend concurrently with matching CORS origins.
