# KidRide Backend

Express 5 REST API for the KidRide web, Parent mobile, and Driver mobile clients. Supabase provides authentication, PostgreSQL data, and private document storage. Production API: `https://kidride-backend.vercel.app/api`.

## Development

Use Node.js 22 or newer:

```sh
npm ci
npm start
npm test
```

The local server defaults to port 5000. Configure the environment before starting; Supabase credentials are required at import time.

## Environment

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Password login client key |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend-only auth administration, database, and storage access |
| `JWT_SECRET` | Strong private secret for KidRide JWTs; tokens expire after 30 days |
| `FRONTEND_URLS` | Comma-separated allowed web origins |
| `NODE_ENV` | Set to `production` to use database-backed rate counters |
| `TRUST_PROXY_HOPS` | Verified trusted proxy count; defaults to 1 on Vercel, 0 elsewhere |
| `SERVICE_PRICES_JSON` | Approved positive USD fixed fares by service type |
| `GEMINI_API_KEY` | Backend-only Gemini key for safety chat |
| `EXPO_ACCESS_TOKEN` | Optional Expo server access token when enhanced push security is enabled |
| `CRON_SECRET` | Private bearer secret for scheduled receipt processing |
| `PORT` | Local listener port, default 5000 |

Supported fare keys: `pickup_only`, `dropoff_only`, `pickup_and_dropoff`, `stay_with_child_and_dropoff`. Values must be positive numbers with at most two decimal places. Missing/malformed pricing returns 503 for that service; no default free ride is created. This is fixed-service pricing, not distance-based fare calculation, payment collection, or payouts.

Optional throttle controls: `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS` (default 1000 per 15 minutes), `AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX_ATTEMPTS` (20 per 15 minutes), `RIDE_REQUEST_RATE_LIMIT_WINDOW_MS`, and `RIDE_REQUEST_RATE_LIMIT_MAX_REQUESTS` (10 per minute). IPs come from Express's configured trusted-proxy chain, not arbitrary forwarded header values. Production counters are shared through a database RPC and fail closed if unavailable.

Never put service-role, JWT, Gemini, cron, or Expo server secrets in client bundles. Revoke any Gemini key previously embedded in the web frontend.

## Database setup and deployment order

1. For a new project, run `supabase/schema.sql` first.
2. Apply `supabase/migrations/2026-10-04_security_services.sql` for new and existing projects. It adds private service tables, GPS data, active-ride uniqueness, distributed rate limiting, and the private verification bucket. It removes direct client write permissions.
3. If unique-index creation fails because an account has multiple active rides, the migration aborts. Review those rides with their participants and resolve them deliberately before retrying; the migration never silently cancels live trips.
4. Configure environment variables and operator-approved fare values, then deploy this backend.
5. Deploy the coordinated web/mobile clients. Old clients do not support quotes and signed verification uploads.
6. Configure both mobile EAS projects' APNs/FCM credentials and Maps SDK keys. Test notifications and foreground GPS on physical devices.
7. Schedule `GET /api/notification-receipts` every 15 minutes with `Authorization: Bearer <CRON_SECRET>`. Keep this secret on the scheduler/server only.

Existing Supabase grants/policies must be reviewed if you have customized them beyond the repository schema. Admin accounts are provisioned through controlled database administration; **public registration never creates admins**. Review pre-existing admin accounts because earlier versions permitted public admin signup.

## API

All paths below are relative to `/api`. Except registration/login and the scheduler endpoint, requests require `Authorization: Bearer <KidRide JWT>`.

| Method and path | Access / purpose |
| --- | --- |
| `POST /auth/register` | Public; `name`, `email`, `password`, role `parent` or `driver` |
| `POST /auth/login` | Public password login |
| `GET /auth/me` | Current profile |
| `GET /users/profile`, `PUT /users/profile` | Own profile; editable name, phone, photo URL only |
| `GET /users/children`, `POST /users/children` | Own child profiles |
| `POST /users/verification-upload` | Driver; `kind`, `contentType`; returns `path`, `signedUrl` |
| `POST /users/driver-application` | Driver; phone, complete vehicle details, six uploaded `documents` paths |
| `GET /users/driver-applications/:id` | Admin; five-minute signed document download URLs |
| `PUT /users/driver-applications/:id/review` | Admin; approve/reject a pending application after actual verification |
| `POST /users/push-token`, `DELETE /users/push-token` | Register/remove own device token |
| `POST /rides/quote` | Parent; `serviceType`; returns server fare and USD currency |
| `POST /rides/request` | Parent; owned `childId`, pickup/dropoff, pickupTime, serviceType, quotedPrice |
| `GET /rides` | Own rides; admin can list all; scope and capped limit filters |
| `GET /rides/open` | Approved verified driver; redacted available offers; admin access allowed |
| `GET /rides/active` | Latest nonterminal ride belonging to the caller |
| `GET /rides/:id` | Ride participant or admin |
| `PUT /rides/:id/accept` | Approved verified driver; atomic assignment, one active trip per driver |
| `PUT /rides/:id/decline` | Approved verified driver; dismiss open offer |
| `PUT /rides/:id/status` | Assigned driver; valid transition only; controlled admin override |
| `PUT /rides/:id/cancel` | Parent, assigned driver, or admin; ordinary cancellation blocked after pickup |
| `PUT /rides/:id/location` | Assigned approved driver; latitude, longitude, optional accuracy |
| `POST /safety-chat` | Signed-in guidance request, up to 2000 characters; per-user throttled |
| `GET /notification-receipts` | Scheduler bearer secret; Expo receipt processing |

## Ride authorization and concurrency

A driver must have both `is_verified_driver=true` and `driver_application_status=approved` to see offers or accept. Booking checks child ownership and recomputes server fares. Active-ride unique indexes protect against simultaneous double booking. Acceptance uses an atomic unassigned/status predicate. Status/cancellation updates compare the saved status so stale concurrent requests receive 409 instead of overwriting newer state. Terminal rides cannot be reopened.

Open offers omit child identifiers, parent identity, trip codes, and safe words. Assigned participants receive safety credentials. Trip codes and safe words use cryptographic randomness. Socket.IO connections require a valid JWT, join only server-selected rooms, and cannot submit ride/location writes; clients use the REST API.

## Driver verification

The private `driver-verification` bucket accepts JPEG, PNG, and PDF files up to 5 MB. Required kinds: `license`, `insurance`, `registration`, `photo_front`, `photo_left`, `photo_right`. Photos must be images. Signed upload paths are user/kind scoped. Application submission checks ownership, existence, MIME, and size for every object.

Files remain private. Only admins receive short-lived review links. Photos support manual review, **not automated liveness detection**. This repository does not integrate a background-check provider. Approval must follow the operator's actual verification process; submitting an application grants no ride access. Plan a private-document retention/deletion process appropriate to your operation.

Application review: fetch the private document links first, then include the returned `submittedAt` with `status` in the review request. A changed submission returns 409; submission and review are serialized in the database.

## GPS, notifications, and safety

Driver coordinates are stored on the ride with server timestamps and returned only to authorized participants. Clients show missing/stale GPS explicitly. Current mobile/browser reporting is foreground-only; background or terminated-app tracking requires additional native infrastructure and device testing.

Saved status changes trigger bounded Expo push attempts to participant devices. Delivery failures do not undo rides. Tickets are stored for scheduled receipt checks; `DeviceNotRegistered` tokens are removed. Push notifications are best effort, not guaranteed delivery.

Safety chat uses a server-side Gemini request and is general guidance only. It cannot dispatch emergency responders, verify drivers, or guarantee safety. SOS dialing is a client feature; configure the operating region's emergency number in the mobile app.

## Validation and limitations

`npm test` runs regression checks for signup roles, ownership, approval, fare authority, credential redaction, coordinate validation, status/cancellation concurrency, and throttling. Validate the migration in staging, then exercise the complete ride flow, signed uploads, push credentials/receipts, and physical-device GPS before operational use.

Payment processing, driver payouts, automated background checks, automated liveness verification, carpool publishing, and continuous background GPS are not implemented. This code update does not itself deploy database changes or provision third-party credentials.
