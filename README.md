# KidRide Backend API

Express + Supabase backend for KidRide authentication, profile management, child profiles, and ride lifecycle operations.

## Production
- API base URL: `https://kidride-backend.vercel.app/api`
- Primary frontend URL: `https://kid-ride.vercel.app/`

## Tech Stack
- Node.js
- Express 5
- Supabase Auth
- Supabase Postgres
- JWT session tokens for the frontend
- Socket.IO

## Project Structure
```text
kidride-backend/
  config/
    db.js                # Startup env validation
    supabase.js          # Supabase clients
  lib/
    repository.js        # Shared profile/child/ride queries + formatters
  middleware/
    authMiddleware.js    # JWT guard backed by Supabase profiles
  routes/
    authRoutes.js        # /api/auth/*
    userRoutes.js        # /api/users/*
    rideRoutes.js        # /api/rides/*
  supabase/
    schema.sql           # Tables, triggers, and baseline RLS policies
  server.js              # App bootstrap, CORS, Socket.IO
```

## Prerequisites
- Node.js 18+ (Node.js 20+ recommended)
- npm
- A Supabase project

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. In Supabase, run [`supabase/schema.sql`](./supabase/schema.sql) in the SQL editor.
3. Create `.env` in `kidride-backend/`:
   ```bash
   SUPABASE_URL=https://your-project-ref.supabase.co
   SUPABASE_ANON_KEY=your_supabase_anon_key
   SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
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
4. Start the server:
   ```bash
   npm start
   ```

## Environment Variables
- `SUPABASE_URL` required, project URL.
- `SUPABASE_ANON_KEY` required, used for password login.
- `SUPABASE_SERVICE_ROLE_KEY` required, used for admin auth actions and server-side table access.
- `JWT_SECRET` required, signing key for KidRide session tokens returned to the frontend.
- `PORT` optional, defaults to `5000`.
- `FRONTEND_URLS` optional, comma-separated CORS allowlist for HTTP + Socket.IO.
- `RATE_LIMIT_WINDOW_MS` optional, global limit window in ms (default `900000`).
- `RATE_LIMIT_MAX_REQUESTS` optional, global max requests per window (default `300`).
- `AUTH_RATE_LIMIT_WINDOW_MS` optional, auth routes window in ms (default `900000`).
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS` optional, max auth attempts per window (default `20`).
- `RIDE_REQUEST_RATE_LIMIT_WINDOW_MS` optional, ride request window in ms (default `60000`).
- `RIDE_REQUEST_RATE_LIMIT_MAX_REQUESTS` optional, max ride requests per window (default `10`).

## Authentication Model
- Supabase Auth stores credentials and validates email/password.
- The backend still issues a 30-day KidRide JWT after login/register so the frontend contract stays the same.
- Protected routes require:
  - Header: `Authorization: Bearer <token>`

## Supabase Tables
- `profiles`
  - App-facing user record keyed to `auth.users.id`
- `children`
  - Child profiles owned by a parent profile
- `rides`
  - Ride requests, assignments, and trip lifecycle data

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
Server events are still configured in `server.js`.

### Client to Server
- `join_driver_room`
- `request_ride`
- `accept_ride`
- `update_location`

### Server to Client
- `ride_available`
- `ride_accepted`
- `driver_location`
- `ride_status_updated`

## Notes for Frontend Integration
- The frontend still receives the same payload shape for:
  - `id`, `name`, `email`, `role`, `children`, `driverApplicationStatus`
  - ride fields like `id/_id`, `child`, `driver`, `pickupLocation`, `dropoffLocation`, `status`, `serviceType`
- This lets the React app keep calling the same REST endpoints while Supabase replaces MongoDB under the hood.

## Operational Notes
- No automated backend test suite is configured yet.
- The tracked `.env` file should only contain placeholders; use real project secrets locally or in deployment config.
