# P-Pick — India Home Maintenance Platform (Complete Source Code)

## Overview
Full-stack multi-portal web & installable PWA platform for pan-India home maintenance:
- Master Hub (`/`)
- Customer App (`/customer`)
- Technician Partner App (`/technician`)
- Admin Operations App (`/admin`)
- Brand & Press Kit (`/press-kit`)

## Architecture & Key Files
- `server.ts` — Express API server, WebSocket (`/ws`) + SSE (`/api/events`) real-time sync, portal-aware HTML meta injection, and file-backed JSON database integration (`.data/ppick-db.json`).
- `.data/ppick-db.json` — Database state & seed records (`users`, `service_categories`, `professionals`, `bookings`, `messages`, `reviews`, `liveEvents`, `platformState`).
- `src/App.tsx` — Multi-portal SPA shell, WebSocket/SSE live state sync, and mobile bottom navigation.
- `src/components/` — All UI screens and modals (Customer, Technician, Admin, Live Map, KYC Document Upload, Profile Photo Capture, Press Kit, PWA Install / App Export).
- `src/data/` — Service catalog, ₹100 flat visit fee rules, required KYC docs, and pan-India states/districts/cities.
- `src/lib/` — Typed API client, Web Audio alerts, document upload helpers, and share helpers.
- `src/hooks/` — Online status and PWA installation hooks.
- `public/` — App manifests (`manifest-*.webmanifest`), adaptive & Apple icons, and press-kit assets.

## Setup & Run
1. Copy `.env.example` to `.env` and fill in optional keys (`VITE_GOOGLE_MAPS_API_KEY`, `GEMINI_API_KEY`, etc.).
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run development server (port 3000):
   ```bash
   npm run dev
   ```
4. Build & run production bundle:
   ```bash
   npm run build
   npm start
   ```
