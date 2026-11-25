import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  Booking,
  BookingStatus,
  CertificationDocument,
  ChatMessage,
  LiveEvent,
  LiveEventType,
  ProfessionalProfile,
  Review,
  ServiceCategory,
  UserProfile,
  UserRole,
  VerificationDocType,
} from './src/types.ts';
import {
  ADMIN_EMAIL,
  REQUIRED_TECHNICIAN_DOCS,
  SERVICE_CATEGORIES,
  SERVICE_CHARGE_INR,
} from './src/data/services.ts';
import { DEFAULT_CITY, DEFAULT_DISTRICT, DEFAULT_STATE } from './src/data/indiaLocations.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '.data');
const DB_FILE = path.join(DATA_DIR, 'ppick-db.json');

interface PlatformState {
  maintenanceMode: boolean;
  lastBroadcastAt: string | null;
  lastBroadcastMessage: string | null;
  lastNotifiedCount: number;
}

interface DatabaseState {
  users: Record<string, UserProfile>;
  service_categories: ServiceCategory[];
  professionals: Record<string, ProfessionalProfile>;
  bookings: Record<string, Booking>;
  messages: Record<string, ChatMessage[]>;
  reviews: Record<string, Review>;
  liveEvents: LiveEvent[];
  platformState: PlatformState;
}

function createInitialDb(): DatabaseState {
  return {
    users: {},
    service_categories: SERVICE_CATEGORIES.map((cat) => ({
      ...cat,
      subServices: cat.subServices.map((s) => ({ ...s })),
    })),
    professionals: {},
    bookings: {},
    messages: {},
    reviews: {},
    liveEvents: [],
    platformState: {
      maintenanceMode: false,
      lastBroadcastAt: null,
      lastBroadcastMessage: null,
      lastNotifiedCount: 0,
    },
  };
}

function loadDb(): DatabaseState {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      const initial = createInitialDb();
      fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DatabaseState>;
    const db: DatabaseState = {
      users: parsed.users ?? {},
      service_categories:
        parsed.service_categories && parsed.service_categories.length > 0
          ? parsed.service_categories
          : SERVICE_CATEGORIES,
      professionals: parsed.professionals ?? {},
      bookings: parsed.bookings ?? {},
      messages: parsed.messages ?? {},
      reviews: parsed.reviews ?? {},
      liveEvents: Array.isArray(parsed.liveEvents) ? parsed.liveEvents : [],
      platformState: parsed.platformState ?? {
        maintenanceMode: false,
        lastBroadcastAt: null,
        lastBroadcastMessage: null,
        lastNotifiedCount: 0,
      },
    };
    return db;
  } catch (err) {
    console.error('Failed to load DB, initializing fresh state:', err);
    return createInitialDb();
  }
}

const db: DatabaseState = loadDb();

function saveDb() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmpFile, DB_FILE);
  } catch (err) {
    console.error('Failed to persist DB:', err);
  }
}

type SseClient = {
  id: string;
  res: express.Response;
};

const sseClients: SseClient[] = [];
const wsClients = new Set<WebSocket>();

function broadcastEvent(event: string, payload: unknown) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(data);
    } catch {
      // Ignore closed streams; cleanup happens on close
    }
  }
  const wsPayload = JSON.stringify({ event, payload });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(wsPayload);
      } catch {
        // Ignore broken sockets; cleanup happens on close
      }
    }
  }
}

function recordLiveEvent(input: {
  type: LiveEventType;
  title: string;
  detail: string;
  state?: string;
  district?: string;
  city?: string;
  bookingId?: string;
  professionalId?: string;
  lat?: number;
  lng?: number;
}) {
  const evt: LiveEvent = {
    eventId: `evt_${crypto.randomBytes(5).toString('hex')}`,
    ...input,
    timestamp: new Date().toISOString(),
  };
  db.liveEvents.unshift(evt);
  if (db.liveEvents.length > 60) {
    db.liveEvents.length = 60;
  }
  saveDb();
  broadcastEvent('live_event', evt);
  return evt;
}

function normalizePhone(input: unknown): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  return digits;
}

function isValidIndianPhone(phone: string): boolean {
  return /^[6-9]\d{9}$/.test(phone) || /^\d{10}$/.test(phone);
}

function isAdminRequest(req: express.Request): boolean {
  const uid = String(req.header('x-user-id') ?? '').trim();
  const headerEmail = String(req.header('x-user-email') ?? '')
    .trim()
    .toLowerCase();
  if (uid && db.users[uid]) {
    return db.users[uid].email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  }
  return headerEmail === ADMIN_EMAIL.toLowerCase();
}

function isProfileOwnerOrAdmin(req: express.Request, uid: string): boolean {
  if (isAdminRequest(req)) return true;
  const actorId = String(req.header('x-user-id') ?? '').trim();
  if (!actorId || actorId !== uid) return false;
  const user = db.users[uid];
  if (!user) return false;
  const headerEmail = String(req.header('x-user-email') ?? '')
    .trim()
    .toLowerCase();
  if (headerEmail && headerEmail !== user.email.toLowerCase()) {
    return false;
  }
  return true;
}

function toBroadcastSafeProfessional(pro: ProfessionalProfile) {
  return {
    uid: pro.uid,
    legalName: pro.legalName,
    tradeCategory: pro.tradeCategory,
    state: pro.state,
    district: pro.district,
    city: pro.city,
    verificationStatus: pro.verificationStatus,
    isAvailable: pro.isAvailable,
    updatedAt: pro.updatedAt,
  };
}

const MAX_CERT_IMAGE_BYTES = 1_500_000; // 1.5 MB decoded image cap
const MAX_CERTS_PER_PRO = REQUIRED_TECHNICIAN_DOCS.length;

function validateAndInspectImageDataUrl(raw: string):
  | {
      ok: true;
      mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
      normalizedDataUrl: string;
      fileSizeBytes: number;
      sha256Checksum: string;
    }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: 'Only JPG, PNG, or WebP base64 image data URLs are allowed.',
    };
  }

  const mimeType = match[1] as 'image/jpeg' | 'image/png' | 'image/webp';
  const base64Body = match[2];
  if (base64Body.length > 2_100_000) {
    return { ok: false, error: 'Encoded image exceeds 1.5 MB limit.' };
  }

  const buffer = Buffer.from(base64Body, 'base64');
  if (buffer.length < 32 || buffer.length > MAX_CERT_IMAGE_BYTES) {
    return {
      ok: false,
      error: 'Verification image must be between 32 bytes and 1.5 MB.',
    };
  }

  // Verify binary magic bytes match declared MIME type
  let validMagic = false;
  if (mimeType === 'image/jpeg') {
    validMagic = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  } else if (mimeType === 'image/png') {
    validMagic =
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47;
  } else if (mimeType === 'image/webp') {
    validMagic =
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }

  if (!validMagic) {
    return {
      ok: false,
      error: 'Uploaded file signature does not match a valid JPG, PNG, or WebP image.',
    };
  }

  const sha256Checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    ok: true,
    mimeType,
    normalizedDataUrl: `data:${mimeType};base64,${base64Body}`,
    fileSizeBytes: buffer.length,
    sha256Checksum,
  };
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Server-Sent Events stream for real-time updates
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const id = crypto.randomUUID();
  sseClients.push({ id, res });

  res.write(`event: connected\ndata: ${JSON.stringify({ id })}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // ignore
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const idx = sseClients.findIndex((c) => c.id === id);
    if (idx !== -1) {
      sseClients.splice(idx, 1);
    }
  });
});

// Auth / Session upsert
app.post('/api/auth/session', (req, res) => {
  const body = req.body as Partial<UserProfile> & { requestedRole?: UserRole };
  const email = String(body.email ?? '').trim().toLowerCase();
  const phone = normalizePhone(body.phone);
  const displayName = String(body.displayName ?? '').trim();
  const requestedRole = (body.requestedRole ?? body.activeRole ?? 'customer') as UserRole;

  if (!email && !isValidIndianPhone(phone)) {
    res.status(400).json({ error: 'Provide a valid email or 10-digit +91 mobile number.' });
    return;
  }
  if (phone && !isValidIndianPhone(phone)) {
    res.status(400).json({ error: 'Mobile number must be exactly 10 digits.' });
    return;
  }
  if (requestedRole === 'admin' && email !== ADMIN_EMAIL.toLowerCase()) {
    res.status(403).json({
      error: `Admin role is restricted to verified administrator email ${ADMIN_EMAIL}.`,
    });
    return;
  }

  // Find existing user by email or phone
  const existing = Object.values(db.users).find(
    (u) =>
      (email && u.email.toLowerCase() === email) ||
      (phone && u.phone === phone && (!email || !u.email))
  );

  const now = new Date().toISOString();
  const effectiveRole: UserRole =
    email === ADMIN_EMAIL.toLowerCase() && requestedRole === 'admin'
      ? 'admin'
      : requestedRole === 'technician'
      ? 'technician'
      : 'customer';

  if (existing) {
    existing.displayName = displayName || existing.displayName || 'P-Pick User';
    if (email) existing.email = email;
    if (phone) existing.phone = phone;
    existing.activeRole = effectiveRole;
    existing.updatedAt = now;
    db.users[existing.userId] = existing;
    saveDb();
    res.json({ user: existing });
    return;
  }

  const userId =
    email === ADMIN_EMAIL.toLowerCase()
      ? 'usr_admin_ppick'
      : `usr_${crypto.randomBytes(6).toString('hex')}`;

  const newUser: UserProfile = {
    userId,
    displayName: displayName || (email ? email.split('@')[0] : `Member ${phone.slice(-4)}`),
    email: email || `${phone}@phone.ppick.in`,
    phone: phone || '',
    state: body.state || DEFAULT_STATE,
    district: body.district || DEFAULT_DISTRICT,
    city: body.city || body.district || DEFAULT_CITY,
    activeRole: effectiveRole,
    createdAt: now,
    updatedAt: now,
  };

  db.users[userId] = newUser;
  saveDb();
  res.status(201).json({ user: newUser });
});

app.get('/api/users/:uid', (req, res) => {
  const user = db.users[req.params.uid];
  if (!user) {
    res.status(404).json({ error: 'User profile not found.' });
    return;
  }
  res.json({ user });
});

app.patch('/api/users/:uid', (req, res) => {
  const user = db.users[req.params.uid];
  if (!user) {
    res.status(404).json({ error: 'User profile not found.' });
    return;
  }
  const body = req.body as Partial<UserProfile>;

  if (body.displayName !== undefined) {
    const name = String(body.displayName).trim();
    if (name.length < 2 || name.length > 80) {
      res.status(400).json({ error: 'Display name must be between 2 and 80 characters.' });
      return;
    }
    user.displayName = name;
  }
  if (body.phone !== undefined) {
    const phone = normalizePhone(body.phone);
    if (phone && !isValidIndianPhone(phone)) {
      res.status(400).json({ error: 'Mobile number must be 10 digits.' });
      return;
    }
    user.phone = phone;
  }
  if (body.state !== undefined) {
    user.state = String(body.state).trim() || DEFAULT_STATE;
  }
  if (body.district !== undefined) {
    user.district = String(body.district).trim() || DEFAULT_DISTRICT;
  }
  if (body.city !== undefined) {
    user.city = String(body.city).trim() || user.district || DEFAULT_CITY;
  }
  if (body.activeRole !== undefined) {
    if (
      body.activeRole === 'admin' &&
      user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()
    ) {
      res.status(403).json({ error: 'Admin role is restricted.' });
      return;
    }
    user.activeRole = body.activeRole;
  }

  user.updatedAt = new Date().toISOString();
  db.users[user.userId] = user;
  saveDb();
  res.json({ user });
});

// Service Categories
app.get('/api/services', (_req, res) => {
  res.json({ categories: db.service_categories.filter((c) => c.active) });
});

// Verified professionals offering Free Base Service (mandatory ₹100 service fee still applies)
app.get('/api/services/free-offers', (_req, res) => {
  const list = Object.values(db.professionals)
    .filter((p) => p.verificationStatus === 'approved' && p.offersFreeService === true)
    .map((p) => ({
      uid: p.uid,
      legalName: p.legalName,
      tradeCategory: p.tradeCategory,
      state: p.state,
      district: p.district,
      city: p.city,
      experienceYears: p.experienceYears,
      verificationStatus: p.verificationStatus,
      offersFreeService: true,
      isAvailable: p.isAvailable,
      photoBase64: p.photoBase64,
      photoLocked: p.photoLocked ?? Boolean(p.photoBase64),
    }));
  res.json({ professionals: list });
});

// Bookings
app.get('/api/bookings', (req, res) => {
  const { customerId, professionalId, district, state, tradeCategory, status, scope } =
    req.query as Record<string, string | undefined>;

  let list = Object.values(db.bookings);

  if (scope === 'admin') {
    if (!isAdminRequest(req)) {
      res.status(403).json({ error: 'Admin privileges required.' });
      return;
    }
  } else {
    if (customerId) {
      list = list.filter((b) => b.customerId === customerId);
    }
    if (professionalId) {
      list = list.filter((b) => b.professionalId === professionalId);
    }
    if (status) {
      list = list.filter((b) => b.status === status);
    }
    if (tradeCategory) {
      list = list.filter((b) => b.tradeCategory === tradeCategory);
    }
    if (state) {
      list = list.filter((b) => b.state === state);
    }
    if (district) {
      list = list.filter((b) => b.district === district);
    }
  }

  list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ bookings: list });
});

app.post('/api/bookings', (req, res) => {
  const body = req.body as Partial<Booking> & {
    isFree?: boolean;
    pricingMode?: 'standard' | 'free';
  };
  const customerId = String(body.customerId ?? '').trim();
  const customerName = String(body.customerName ?? '').trim();
  const customerPhone = normalizePhone(body.customerPhone);
  const address = String(body.address ?? '').trim();
  const state = String(body.state ?? DEFAULT_STATE).trim();
  const district = String(body.district ?? DEFAULT_DISTRICT).trim();
  const city = String(body.city ?? district ?? DEFAULT_CITY).trim();
  const tradeCategory = body.tradeCategory;
  const subServiceId = String(body.subServiceId ?? '').trim();
  const preferredDate = String(body.preferredDate ?? '').trim();
  const timeSlot = String(body.timeSlot ?? '').trim();
  const notes = String(body.notes ?? '').trim().slice(0, 400);
  const preferredProfessionalId = body.preferredProfessionalId
    ? String(body.preferredProfessionalId).trim()
    : undefined;

  if (!customerId || !db.users[customerId]) {
    res.status(401).json({ error: 'Authenticated user required to place booking.' });
    return;
  }
  if (customerName.length < 2) {
    res.status(400).json({ error: 'Customer name is required.' });
    return;
  }
  if (!isValidIndianPhone(customerPhone)) {
    res.status(400).json({ error: 'Valid 10-digit +91 mobile number is required.' });
    return;
  }
  if (address.length < 5) {
    res.status(400).json({ error: 'Complete address must be at least 5 characters.' });
    return;
  }
  if (!preferredDate || !timeSlot) {
    res.status(400).json({ error: 'Preferred date and time slot are required.' });
    return;
  }

  const category = db.service_categories.find((c) => c.categoryId === tradeCategory && c.active);
  const subService = category?.subServices.find((s) => s.id === subServiceId);
  if (!category || !subService) {
    res.status(400).json({ error: 'Selected trade category or sub-service is unavailable.' });
    return;
  }

  const preferredPro = preferredProfessionalId
    ? db.professionals[preferredProfessionalId]
    : undefined;
  const validPreferredPro =
    preferredPro &&
    preferredPro.verificationStatus === 'approved' &&
    preferredPro.tradeCategory === category.categoryId
      ? preferredPro
      : undefined;

  const lat =
    typeof body.lat === 'number' &&
    Number.isFinite(body.lat) &&
    body.lat >= -90 &&
    body.lat <= 90
      ? body.lat
      : undefined;
  const lng =
    typeof body.lng === 'number' &&
    Number.isFinite(body.lng) &&
    body.lng >= -180 &&
    body.lng <= 180
      ? body.lng
      : undefined;
  const placeId = body.placeId ? String(body.placeId).trim().slice(0, 120) : undefined;

  // Enforce mandatory ₹100 service fee on all bookings, including those marked 'free' by the professional or catalog
  const isFreeService = Boolean(
    subService.isFree ||
      subService.priceInr === 0 ||
      body.isFree === true ||
      body.isFreeService === true ||
      body.pricingMode === 'free' ||
      validPreferredPro?.offersFreeService === true
  );
  const baseServicePrice = isFreeService ? 0 : subService.priceInr;
  const serviceCharge = SERVICE_CHARGE_INR; // Mandatory ₹100 service fee (non-waivable)
  const estimatedPrice = baseServicePrice + serviceCharge;

  const now = new Date().toISOString();
  const bookingId = `bk_${crypto.randomBytes(5).toString('hex')}`;
  const booking: Booking = {
    bookingId,
    customerId,
    customerName,
    customerPhone,
    address,
    state,
    district,
    city,
    lat,
    lng,
    placeId,
    tradeCategory: category.categoryId,
    tradeTitle: category.title,
    subServiceId: subService.id,
    subServiceTitle: subService.title,
    baseServicePrice,
    serviceCharge,
    isFreeService,
    estimatedPrice,
    preferredProfessionalId: validPreferredPro?.uid,
    preferredProfessionalName: validPreferredPro?.legalName,
    preferredDate,
    timeSlot,
    notes: notes || undefined,
    status: 'requested',
    createdAt: now,
    updatedAt: now,
  };

  db.bookings[bookingId] = booking;
  saveDb();
  broadcastEvent('booking_created', booking);
  recordLiveEvent({
    type: 'booking_created',
    title: `New ${booking.tradeTitle} Request`,
    detail: isFreeService
      ? `${booking.subServiceTitle} in ${booking.city || booking.district}, ${booking.state} (Free base · ₹${serviceCharge} mandatory service fee)`
      : `${booking.subServiceTitle} in ${booking.city || booking.district}, ${booking.state} (₹${booking.estimatedPrice})`,
    state: booking.state,
    district: booking.district,
    city: booking.city,
    bookingId: booking.bookingId,
    lat: booking.lat,
    lng: booking.lng,
  });
  res.status(201).json({ booking });
});

app.patch('/api/bookings/:bookingId', (req, res) => {
  const booking = db.bookings[req.params.bookingId];
  if (!booking) {
    res.status(404).json({ error: 'Booking not found.' });
    return;
  }

  const { action, actorId } = req.body as {
    action: 'cancel' | 'accept' | 'on_the_way' | 'start' | 'complete' | 'mark_free';
    actorId?: string;
  };
  const now = new Date().toISOString();

  if (action === 'cancel') {
    if (booking.customerId !== actorId && !isAdminRequest(req)) {
      res.status(403).json({ error: 'Only the booking customer can cancel this request.' });
      return;
    }
    if (booking.status !== 'requested') {
      res.status(400).json({ error: 'Only requested bookings can be cancelled.' });
      return;
    }
    booking.status = 'cancelled';
    booking.updatedAt = now;
  } else if (action === 'accept') {
    if (!actorId) {
      res.status(401).json({ error: 'Technician ID required.' });
      return;
    }
    const pro = db.professionals[actorId];
    if (!pro || pro.verificationStatus !== 'approved') {
      res.status(403).json({ error: 'Only verified technicians can accept jobs.' });
      return;
    }
    if (booking.status !== 'requested') {
      res.status(400).json({ error: 'This booking has already been claimed or closed.' });
      return;
    }
    booking.status = 'accepted';
    booking.professionalId = pro.uid;
    booking.professionalName = pro.legalName;
    booking.professionalPhone = pro.phone;
    booking.professionalUpi = pro.upiId;
    booking.professionalPhotoBase64 = pro.photoBase64;
    booking.updatedAt = now;
  } else if (action === 'mark_free') {
    if (booking.professionalId !== actorId) {
      res.status(403).json({ error: 'Only the assigned technician can mark this booking free.' });
      return;
    }
    if (
      booking.status !== 'accepted' &&
      booking.status !== 'on_the_way' &&
      booking.status !== 'in_progress'
    ) {
      res.status(400).json({
        error: 'Only active assigned bookings can be marked free by the technician.',
      });
      return;
    }
    booking.isFreeService = true;
    booking.baseServicePrice = 0;
    booking.serviceCharge = SERVICE_CHARGE_INR; // Mandatory ₹100 service fee remains enforced
    booking.estimatedPrice = SERVICE_CHARGE_INR;
    booking.updatedAt = now;
  } else if (action === 'on_the_way') {
    if (booking.professionalId !== actorId) {
      res.status(403).json({ error: 'Only the assigned technician can mark on the way.' });
      return;
    }
    if (booking.status !== 'accepted') {
      res.status(400).json({ error: 'Booking must be accepted before marking on the way.' });
      return;
    }
    booking.status = 'on_the_way';
    booking.updatedAt = now;
  } else if (action === 'start') {
    if (booking.professionalId !== actorId) {
      res.status(403).json({ error: 'Only the assigned technician can start work.' });
      return;
    }
    if (booking.status !== 'accepted' && booking.status !== 'on_the_way') {
      res.status(400).json({
        error: 'Booking must be accepted or on the way to start work.',
      });
      return;
    }
    booking.status = 'in_progress';
    booking.updatedAt = now;
  } else if (action === 'complete') {
    if (booking.professionalId !== actorId) {
      res.status(403).json({ error: 'Only the assigned technician can mark complete.' });
      return;
    }
    if (booking.status !== 'in_progress') {
      res.status(400).json({ error: 'Booking must be in progress to mark completed.' });
      return;
    }
    booking.status = 'completed';
    booking.updatedAt = now;
  } else {
    res.status(400).json({ error: 'Unsupported booking action.' });
    return;
  }

  db.bookings[booking.bookingId] = booking;
  saveDb();
  broadcastEvent('booking_updated', booking);
  const statusLabels: Record<BookingStatus, string> = {
    requested: 'Requested',
    accepted: `Accepted by ${booking.professionalName || 'Technician'}`,
    on_the_way: `${booking.professionalName || 'Technician'} is On the Way`,
    in_progress: 'Work Started',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  recordLiveEvent({
    type: 'booking_updated',
    title: `Booking #${booking.bookingId.slice(-6)} · ${statusLabels[booking.status]}`,
    detail: `${booking.subServiceTitle} in ${booking.city || booking.district}, ${booking.state}`,
    state: booking.state,
    district: booking.district,
    city: booking.city,
    bookingId: booking.bookingId,
    professionalId: booking.professionalId,
    lat: booking.lat,
    lng: booking.lng,
  });
  res.json({ booking });
});

// Booking Chat Messages
app.get('/api/bookings/:bookingId/messages', (req, res) => {
  const booking = db.bookings[req.params.bookingId];
  if (!booking) {
    res.status(404).json({ error: 'Booking not found.' });
    return;
  }
  const actorId = String(req.header('x-user-id') ?? '').trim();
  if (
    actorId !== booking.customerId &&
    actorId !== booking.professionalId &&
    !isAdminRequest(req)
  ) {
    res.status(403).json({ error: 'Access denied to booking chat.' });
    return;
  }
  const msgs = db.messages[booking.bookingId] ?? [];
  res.json({ messages: msgs });
});

app.post('/api/bookings/:bookingId/messages', (req, res) => {
  const booking = db.bookings[req.params.bookingId];
  if (!booking) {
    res.status(404).json({ error: 'Booking not found.' });
    return;
  }
  if (
    booking.status !== 'accepted' &&
    booking.status !== 'on_the_way' &&
    booking.status !== 'in_progress'
  ) {
    res.status(400).json({
      error: 'Messaging is active only for accepted, on-the-way, or in-progress bookings.',
    });
    return;
  }

  const body = req.body as {
    senderId?: string;
    senderName?: string;
    text?: string;
  };
  const senderId = String(body.senderId ?? '').trim();
  const text = String(body.text ?? '').trim();

  if (!senderId || (senderId !== booking.customerId && senderId !== booking.professionalId)) {
    res.status(403).json({ error: 'Only the customer or assigned technician can send messages.' });
    return;
  }
  if (text.length < 1 || text.length > 500) {
    res.status(400).json({ error: 'Message must be between 1 and 500 characters.' });
    return;
  }

  const senderRole: 'customer' | 'professional' =
    senderId === booking.customerId ? 'customer' : 'professional';
  const senderName =
    String(body.senderName ?? '').trim() ||
    (senderRole === 'customer' ? booking.customerName : booking.professionalName || 'Technician');

  const message: ChatMessage = {
    messageId: `msg_${crypto.randomBytes(5).toString('hex')}`,
    bookingId: booking.bookingId,
    senderId,
    senderName,
    senderRole,
    text,
    createdAt: new Date().toISOString(),
  };

  if (!db.messages[booking.bookingId]) {
    db.messages[booking.bookingId] = [];
  }
  db.messages[booking.bookingId].push(message);
  saveDb();
  broadcastEvent('message_created', message);
  recordLiveEvent({
    type: 'message_created',
    title: `New Chat Message`,
    detail: `${message.senderName} messaged on ${booking.subServiceTitle} (#${booking.bookingId.slice(-6)})`,
    state: booking.state,
    district: booking.district,
    city: booking.city,
    bookingId: booking.bookingId,
  });
  res.status(201).json({ message });
});

// Reviews & Aggregated Technician Ratings
app.get('/api/reviews', (req, res) => {
  const { customerId, professionalId } = req.query as Record<
    string,
    string | undefined
  >;
  let list = Object.values(db.reviews);
  if (customerId) {
    list = list.filter((r) => r.customerId === customerId);
  }
  if (professionalId) {
    list = list.filter((r) => r.professionalId === professionalId);
  }
  list.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const totalReviews = list.length;
  const averageRating =
    totalReviews > 0
      ? Number(
          (list.reduce((sum, r) => sum + r.rating, 0) / totalReviews).toFixed(1)
        )
      : 0;
  res.json({ reviews: list, averageRating, totalReviews });
});

app.post('/api/bookings/:bookingId/review', (req, res) => {
  const booking = db.bookings[req.params.bookingId];
  if (!booking) {
    res.status(404).json({ error: 'Booking not found.' });
    return;
  }
  if (booking.status !== 'completed') {
    res.status(400).json({ error: 'Reviews can only be submitted after job completion.' });
    return;
  }
  if (!booking.professionalId) {
    res.status(400).json({ error: 'Booking has no assigned technician to review.' });
    return;
  }
  const actorId = String(
    req.header('x-user-id') ?? (req.body as { customerId?: string }).customerId ?? ''
  ).trim();
  if (actorId !== booking.customerId) {
    res.status(403).json({ error: 'Only the booking customer can leave a review.' });
    return;
  }
  if (db.reviews[booking.bookingId]) {
    res.status(409).json({ error: 'A review has already been submitted for this booking.' });
    return;
  }

  const { rating, comment } = req.body as { rating?: number; comment?: string };
  const numericRating = Math.round(Number(rating));
  const cleanComment = String(comment ?? '').trim();

  if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
    res.status(400).json({ error: 'Rating must be between 1 and 5 stars.' });
    return;
  }
  if (cleanComment.length < 2 || cleanComment.length > 400) {
    res.status(400).json({ error: 'Review comment must be between 2 and 400 characters.' });
    return;
  }

  const review: Review = {
    reviewId: `rev_${crypto.randomBytes(5).toString('hex')}`,
    bookingId: booking.bookingId,
    customerId: booking.customerId,
    customerName: booking.customerName,
    professionalId: booking.professionalId,
    professionalName: booking.professionalName || 'Verified Technician',
    tradeCategory: booking.tradeCategory,
    subServiceTitle: booking.subServiceTitle,
    rating: numericRating,
    comment: cleanComment,
    createdAt: new Date().toISOString(),
  };

  db.reviews[booking.bookingId] = review;
  saveDb();
  broadcastEvent('review_created', review);
  recordLiveEvent({
    type: 'review_created',
    title: `${review.rating}★ Customer Review Posted`,
    detail: `${review.customerName} rated ${review.professionalName} for ${review.subServiceTitle}`,
    state: booking.state,
    district: booking.district,
    city: booking.city,
    bookingId: booking.bookingId,
    professionalId: booking.professionalId,
  });
  res.status(201).json({ review });
});

// Professionals / Technician Partner Portal
app.get('/api/professionals', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: 'Admin verification required to list all applications.' });
    return;
  }
  const list = Object.values(db.professionals).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  res.json({ professionals: list });
});

// Public sanitized directory of verified professionals for Customer Service view
app.get('/api/professionals/public', (req, res) => {
  const { state, district, tradeCategory } = req.query as Record<
    string,
    string | undefined
  >;
  let list = Object.values(db.professionals).filter(
    (p) => p.verificationStatus === 'approved'
  );
  if (state) {
    list = list.filter((p) => p.state === state);
  }
  if (district) {
    list = list.filter((p) => p.district === district);
  }
  if (tradeCategory) {
    list = list.filter((p) => p.tradeCategory === tradeCategory);
  }
  list.sort((a, b) => {
    if (a.isAvailable !== b.isAvailable) return a.isAvailable ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  res.json({
    professionals: list.map((p) => ({
      uid: p.uid,
      legalName: p.legalName,
      tradeCategory: p.tradeCategory,
      state: p.state,
      district: p.district,
      city: p.city,
      experienceYears: p.experienceYears,
      verificationStatus: p.verificationStatus,
      isAvailable: p.isAvailable,
      offersFreeService: Boolean(p.offersFreeService),
      photoBase64: p.photoBase64,
      photoLocked: p.photoLocked ?? Boolean(p.photoBase64),
      photoCapturedAt: p.photoCapturedAt ?? p.createdAt,
      photoCaptureMode: p.photoCaptureMode ?? 'upload',
    })),
  });
});

app.get('/api/professionals/:uid', (req, res) => {
  const pro = db.professionals[req.params.uid];
  if (!pro) {
    res.status(404).json({ error: 'Technician profile not found.' });
    return;
  }
  const normalizedPro: ProfessionalProfile = {
    ...pro,
    photoLocked: pro.photoLocked ?? Boolean(pro.photoBase64),
  };
  if (!isProfileOwnerOrAdmin(req, pro.uid)) {
    // Redact sensitive KYC and certification documents for non-owner viewers
    const redacted: ProfessionalProfile = {
      ...normalizedPro,
      aadhaarNumber: `XXXXXXXX${pro.aadhaarNumber.slice(-4)}`,
      certificationDocuments: undefined,
    };
    res.json({ professional: redacted });
    return;
  }
  res.json({ professional: normalizedPro });
});

app.put('/api/professionals/:uid', (req, res) => {
  const uid = req.params.uid;
  if (!db.users[uid]) {
    res.status(404).json({ error: 'User account not found.' });
    return;
  }
  if (!isProfileOwnerOrAdmin(req, uid)) {
    res.status(403).json({ error: 'Only the technician profile owner can modify this profile.' });
    return;
  }
  const existing = db.professionals[uid];
  const body = req.body as Partial<ProfessionalProfile>;

  // Availability toggle fast-path for approved technicians
  if (
    existing &&
    Object.keys(body).length === 1 &&
    typeof body.isAvailable === 'boolean'
  ) {
    if (existing.verificationStatus !== 'approved') {
      res.status(403).json({ error: 'Only approved technicians can go online.' });
      return;
    }
    existing.isAvailable = body.isAvailable;
    existing.updatedAt = new Date().toISOString();
    db.professionals[uid] = existing;
    saveDb();
    broadcastEvent('professional_updated', toBroadcastSafeProfessional(existing));
    recordLiveEvent({
      type: 'professional_updated',
      title: existing.isAvailable ? 'Technician Came Online' : 'Technician Went Offline',
      detail: `${existing.legalName} (${existing.city || existing.district}, ${existing.state})`,
      state: existing.state,
      district: existing.district,
      city: existing.city,
      professionalId: existing.uid,
      lat: existing.lat,
      lng: existing.lng,
    });
    res.json({ professional: existing });
    return;
  }

  // Free Base Service Offer toggle fast-path for approved technicians
  if (
    existing &&
    Object.keys(body).length === 1 &&
    typeof body.offersFreeService === 'boolean'
  ) {
    if (existing.verificationStatus !== 'approved') {
      res.status(403).json({
        error: 'Only approved technicians can offer free base service visits.',
      });
      return;
    }
    existing.offersFreeService = body.offersFreeService;
    existing.updatedAt = new Date().toISOString();
    db.professionals[uid] = existing;
    saveDb();
    broadcastEvent('professional_updated', toBroadcastSafeProfessional(existing));
    recordLiveEvent({
      type: 'professional_updated',
      title: existing.offersFreeService
        ? 'Free Base Service Offer Enabled'
        : 'Free Base Service Offer Paused',
      detail: `${existing.legalName} (${existing.city || existing.district}, ${existing.state}) · ₹${SERVICE_CHARGE_INR} mandatory service fee applies`,
      state: existing.state,
      district: existing.district,
      city: existing.city,
      professionalId: existing.uid,
    });
    res.json({ professional: existing });
    return;
  }

  const legalName = String(body.legalName ?? existing?.legalName ?? '').trim();
  const tradeCategory = body.tradeCategory ?? existing?.tradeCategory;
  const state = String(body.state ?? existing?.state ?? DEFAULT_STATE).trim();
  const district = String(body.district ?? existing?.district ?? DEFAULT_DISTRICT).trim();
  const city = String(body.city ?? existing?.city ?? district ?? DEFAULT_CITY).trim();
  const phone = normalizePhone(body.phone ?? existing?.phone);
  const aadhaarNumber = String(body.aadhaarNumber ?? existing?.aadhaarNumber ?? '').replace(/\D/g, '');
  const upiId = String(body.upiId ?? existing?.upiId ?? '').trim();
  const experienceYears = Number(body.experienceYears ?? existing?.experienceYears ?? 0);

  // Permanent photo lock check: once a technician's live profile photo is captured,
  // nobody (including the technician or Admin) can remove or overwrite it.
  if (existing && existing.photoBase64) {
    if (body.photoBase64 !== undefined) {
      const requestedPhoto =
        typeof body.photoBase64 === 'string' ? body.photoBase64.trim() : '';
      if (!requestedPhoto || requestedPhoto !== existing.photoBase64) {
        res.status(403).json({
          error:
            'Technician profile photo is permanently locked after capture and cannot be removed or replaced by anyone, including admin.',
        });
        return;
      }
    }
  }

  const rawIncomingPhoto = String(body.photoBase64 ?? '').trim();

  if (legalName.length < 2) {
    res.status(400).json({ error: 'Full legal name is required.' });
    return;
  }
  if (!tradeCategory || !db.service_categories.some((c) => c.categoryId === tradeCategory)) {
    res.status(400).json({ error: 'Select a valid trade category.' });
    return;
  }
  if (!isValidIndianPhone(phone)) {
    res.status(400).json({ error: 'Valid 10-digit +91 work mobile number is required.' });
    return;
  }
  if (!/^\d{12}$/.test(aadhaarNumber)) {
    res.status(400).json({ error: 'Aadhaar number must be exactly 12 digits.' });
    return;
  }
  if (!/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(upiId)) {
    res.status(400).json({ error: 'Enter a valid UPI ID (e.g., name@okicici).' });
    return;
  }
  if (!Number.isFinite(experienceYears) || experienceYears < 0 || experienceYears > 60) {
    res.status(400).json({ error: 'Enter valid years of experience (0–60).' });
    return;
  }

  const now = new Date().toISOString();
  let finalPhotoBase64 = existing?.photoBase64 ?? '';
  let finalPhotoLocked = existing ? Boolean(existing.photoBase64) : false;
  let finalPhotoCapturedAt = existing?.photoCapturedAt ?? existing?.createdAt;
  let finalPhotoCaptureMode = existing?.photoCaptureMode;
  let finalPhotoSha256 = existing?.photoSha256;

  if (!existing || !existing.photoBase64) {
    const inspectedPhoto = validateAndInspectImageDataUrl(rawIncomingPhoto);
    if (!inspectedPhoto.ok) {
      res.status(400).json({
        error: `Mandatory live profile photo capture required. ${inspectedPhoto.error}`,
      });
      return;
    }
    finalPhotoBase64 = inspectedPhoto.normalizedDataUrl;
    finalPhotoLocked = true;
    finalPhotoCapturedAt = now;
    finalPhotoCaptureMode =
      body.photoCaptureMode === 'live_camera' ? 'live_camera' : 'upload';
    finalPhotoSha256 = inspectedPhoto.sha256Checksum;
  }

  // If previously rejected and re-submitting KYC, reset status to pending
  const nextStatus =
    existing && existing.verificationStatus === 'approved'
      ? 'approved'
      : 'pending';

  const profile: ProfessionalProfile = {
    uid,
    legalName,
    tradeCategory,
    state,
    district,
    city,
    phone,
    aadhaarNumber,
    upiId,
    experienceYears,
    photoBase64: finalPhotoBase64,
    photoLocked: finalPhotoLocked,
    photoCapturedAt: finalPhotoCapturedAt,
    photoCaptureMode: finalPhotoCaptureMode,
    photoSha256: finalPhotoSha256,
    verificationStatus: nextStatus,
    rejectionNote: nextStatus === 'pending' ? undefined : existing?.rejectionNote,
    isAvailable: existing?.isAvailable ?? false,
    offersFreeService:
      typeof body.offersFreeService === 'boolean'
        ? body.offersFreeService
        : existing?.offersFreeService ?? false,
    lat: existing?.lat,
    lng: existing?.lng,
    locationUpdatedAt: existing?.locationUpdatedAt,
    certificationDocuments: existing?.certificationDocuments ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  db.professionals[uid] = profile;
  saveDb();
  broadcastEvent('professional_updated', toBroadcastSafeProfessional(profile));
  res.json({ professional: profile });
});

// Secure Required Technician Verification Proof Upload & Management
app.post('/api/professionals/:uid/certifications', (req, res) => {
  const uid = req.params.uid;
  if (!isProfileOwnerOrAdmin(req, uid)) {
    res.status(403).json({
      error: 'Only the authenticated technician can upload verification proofs.',
    });
    return;
  }
  const pro = db.professionals[uid];
  if (!pro) {
    res.status(404).json({
      error: 'Complete your basic technician KYC profile before uploading verification proofs.',
    });
    return;
  }

  const body = req.body as {
    docType?: VerificationDocType;
    title?: string;
    issuer?: string;
    certificateNumber?: string;
    imageDataUrl?: string;
  };

  const spec = REQUIRED_TECHNICIAN_DOCS.find((item) => item.docType === body.docType);
  if (!spec) {
    res.status(400).json({
      error:
        'Invalid verification proof type. Allowed proofs: Aadhaar Card ID Proof, UPI ID Proof, and Bike / Two-Wheeler Driving Licence.',
    });
    return;
  }

  const issuer = String(body.issuer ?? '').trim().slice(0, 80) || spec.defaultIssuer;
  const certificateNumber = String(body.certificateNumber ?? '').trim().slice(0, 60);
  const imageDataUrl = String(body.imageDataUrl ?? '');

  const inspected = validateAndInspectImageDataUrl(imageDataUrl);
  if (!inspected.ok) {
    res.status(400).json({ error: inspected.error });
    return;
  }

  const existingDocs = (pro.certificationDocuments ?? []).filter(
    (d) =>
      d.docType &&
      REQUIRED_TECHNICIAN_DOCS.some((reqDoc) => reqDoc.docType === d.docType) &&
      d.docType !== spec.docType
  );

  if (existingDocs.length >= MAX_CERTS_PER_PRO) {
    res.status(400).json({
      error: `Maximum ${MAX_CERTS_PER_PRO} verification proofs allowed per technician profile.`,
    });
    return;
  }

  const now = new Date().toISOString();
  const doc: CertificationDocument = {
    docId: `doc_${spec.docType}_${crypto.randomBytes(4).toString('hex')}`,
    docType: spec.docType,
    title: spec.label,
    issuer,
    certificateNumber: certificateNumber || undefined,
    mimeType: inspected.mimeType,
    imageBase64: inspected.normalizedDataUrl,
    fileSizeBytes: inspected.fileSizeBytes,
    sha256Checksum: inspected.sha256Checksum,
    verificationStatus: 'pending',
    uploadedAt: now,
  };

  // Keep documents ordered cleanly matching REQUIRED_TECHNICIAN_DOCS order
  const combined = [...existingDocs, doc];
  pro.certificationDocuments = REQUIRED_TECHNICIAN_DOCS.map((reqDoc) =>
    combined.find((item) => item.docType === reqDoc.docType)
  ).filter((item): item is CertificationDocument => Boolean(item));
  pro.updatedAt = now;
  db.professionals[uid] = pro;
  saveDb();
  broadcastEvent('professional_updated', toBroadcastSafeProfessional(pro));
  recordLiveEvent({
    type: 'professional_updated',
    title: 'Verification Proof Uploaded',
    detail: `${pro.legalName} submitted "${doc.title}" for KYC review`,
    state: pro.state,
    district: pro.district,
    city: pro.city,
    professionalId: pro.uid,
  });
  res.status(201).json({ professional: pro, document: doc });
});

app.delete('/api/professionals/:uid/certifications/:docId', (req, res) => {
  const { uid, docId } = req.params;
  if (!isProfileOwnerOrAdmin(req, uid)) {
    res.status(403).json({
      error: 'Only the authenticated technician can remove verification proofs.',
    });
    return;
  }
  const pro = db.professionals[uid];
  if (!pro) {
    res.status(404).json({ error: 'Technician profile not found.' });
    return;
  }

  const existingDocs = pro.certificationDocuments ?? [];
  const nextDocs = existingDocs.filter((d) => d.docId !== docId);
  if (nextDocs.length === existingDocs.length) {
    res.status(404).json({ error: 'Verification proof not found.' });
    return;
  }

  pro.certificationDocuments = nextDocs;
  const hasAllRequired = REQUIRED_TECHNICIAN_DOCS.every((reqDoc) =>
    nextDocs.some((d) => d.docType === reqDoc.docType && d.verificationStatus !== 'rejected')
  );
  if (!hasAllRequired && pro.verificationStatus === 'approved') {
    pro.verificationStatus = 'pending';
    pro.isAvailable = false;
  }
  pro.updatedAt = new Date().toISOString();
  db.professionals[uid] = pro;
  saveDb();
  broadcastEvent('professional_updated', toBroadcastSafeProfessional(pro));
  res.json({ professional: pro });
});

app.patch('/api/professionals/:uid/certifications/:docId/verify', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: 'Admin verification required.' });
    return;
  }
  const { uid, docId } = req.params;
  const pro = db.professionals[uid];
  if (!pro) {
    res.status(404).json({ error: 'Technician profile not found.' });
    return;
  }

  const docs = pro.certificationDocuments ?? [];
  const doc = docs.find((d) => d.docId === docId);
  if (!doc) {
    res.status(404).json({ error: 'Verification proof not found.' });
    return;
  }

  const { status, rejectionNote } = req.body as {
    status?: 'approved' | 'rejected';
    rejectionNote?: string;
  };
  if (status !== 'approved' && status !== 'rejected') {
    res.status(400).json({ error: 'Status must be approved or rejected.' });
    return;
  }

  const now = new Date().toISOString();
  doc.verificationStatus = status;
  doc.rejectionNote =
    status === 'rejected'
      ? String(rejectionNote ?? 'Document is unclear or could not be verified.').trim().slice(0, 200)
      : undefined;
  doc.reviewedAt = now;

  if (
    status === 'rejected' &&
    doc.docType &&
    REQUIRED_TECHNICIAN_DOCS.some((reqDoc) => reqDoc.docType === doc.docType) &&
    pro.verificationStatus === 'approved'
  ) {
    pro.verificationStatus = 'pending';
    pro.isAvailable = false;
  }

  pro.updatedAt = now;

  db.professionals[uid] = pro;
  saveDb();
  broadcastEvent('professional_updated', toBroadcastSafeProfessional(pro));
  recordLiveEvent({
    type: 'professional_updated',
    title: `KYC Proof ${status === 'approved' ? 'Verified' : 'Rejected'}`,
    detail: `${pro.legalName} · ${doc.title}`,
    state: pro.state,
    district: pro.district,
    city: pro.city,
    professionalId: pro.uid,
  });
  res.json({ professional: pro, document: doc });
});

app.patch('/api/professionals/:uid/verify', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: 'Admin verification required.' });
    return;
  }
  const pro = db.professionals[req.params.uid];
  if (!pro) {
    res.status(404).json({ error: 'Technician application not found.' });
    return;
  }
  const { status, rejectionNote } = req.body as {
    status: 'approved' | 'rejected';
    rejectionNote?: string;
  };
  if (status !== 'approved' && status !== 'rejected') {
    res.status(400).json({ error: 'Status must be approved or rejected.' });
    return;
  }

  const now = new Date().toISOString();
  if (status === 'approved') {
    const docs = pro.certificationDocuments ?? [];
    const missingSpecs = REQUIRED_TECHNICIAN_DOCS.filter(
      (reqDoc) => !docs.some((d) => d.docType === reqDoc.docType)
    );
    if (missingSpecs.length > 0) {
      res.status(400).json({
        error: `Cannot verify technician account until all 3 proofs are uploaded. Missing: ${missingSpecs
          .map((s) => s.label)
          .join(', ')}.`,
      });
      return;
    }

    const rejectedSpecs = REQUIRED_TECHNICIAN_DOCS.filter((reqDoc) => {
      const matched = docs.find((d) => d.docType === reqDoc.docType);
      return matched?.verificationStatus === 'rejected';
    });
    if (rejectedSpecs.length > 0) {
      res.status(400).json({
        error: `Cannot verify technician account while required proofs are rejected (${rejectedSpecs
          .map((s) => s.label)
          .join(', ')}). Technician must re-upload first.`,
      });
      return;
    }

    // Mark any pending mandatory proofs as approved alongside technician verification
    for (const reqDoc of REQUIRED_TECHNICIAN_DOCS) {
      const matched = docs.find((d) => d.docType === reqDoc.docType);
      if (matched && matched.verificationStatus === 'pending') {
        matched.verificationStatus = 'approved';
        matched.reviewedAt = now;
        matched.rejectionNote = undefined;
      }
    }
  }

  pro.verificationStatus = status;
  pro.rejectionNote =
    status === 'rejected'
      ? String(rejectionNote ?? 'KYC details require correction.').trim()
      : undefined;
  if (status === 'rejected') {
    pro.isAvailable = false;
  }
  pro.updatedAt = now;

  db.professionals[pro.uid] = pro;
  saveDb();
  broadcastEvent('professional_updated', toBroadcastSafeProfessional(pro));
  recordLiveEvent({
    type: 'professional_updated',
    title: `Technician KYC ${status === 'approved' ? 'Verified' : 'Rejected'}`,
    detail: `${pro.legalName} (${pro.city || pro.district}, ${pro.state})`,
    state: pro.state,
    district: pro.district,
    city: pro.city,
    professionalId: pro.uid,
  });
  res.json({ professional: pro });
});

// Live Technician Location Sharing (Explicit & Revocable Consent)
app.patch('/api/professionals/:uid/location', (req, res) => {
  const uid = req.params.uid;
  const actorId = String(req.header('x-user-id') ?? '').trim();
  if (actorId !== uid && !isAdminRequest(req)) {
    res.status(403).json({ error: 'Only the technician can update their live location.' });
    return;
  }
  const pro = db.professionals[uid];
  if (!pro) {
    res.status(404).json({ error: 'Technician profile not found.' });
    return;
  }

  const body = req.body as {
    lat?: number;
    lng?: number;
    city?: string;
    district?: string;
    state?: string;
    clear?: boolean;
  };

  if (body.clear) {
    delete pro.lat;
    delete pro.lng;
    pro.locationUpdatedAt = new Date().toISOString();
    pro.updatedAt = pro.locationUpdatedAt;
    db.professionals[uid] = pro;
    saveDb();
    broadcastEvent('professional_location_updated', {
      uid: pro.uid,
      lat: undefined,
      lng: undefined,
      locationUpdatedAt: pro.locationUpdatedAt,
    });
    recordLiveEvent({
      type: 'professional_location_updated',
      title: 'Live Location Sharing Paused',
      detail: `${pro.legalName} paused live GPS sharing`,
      state: pro.state,
      district: pro.district,
      city: pro.city,
      professionalId: pro.uid,
    });
    res.json({ professional: pro });
    return;
  }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: 'Valid latitude and longitude coordinates are required.' });
    return;
  }

  pro.lat = lat;
  pro.lng = lng;
  if (body.city) pro.city = String(body.city).trim();
  if (body.district) pro.district = String(body.district).trim();
  if (body.state) pro.state = String(body.state).trim();
  pro.locationUpdatedAt = new Date().toISOString();
  pro.updatedAt = pro.locationUpdatedAt;

  db.professionals[uid] = pro;
  saveDb();
  broadcastEvent('professional_location_updated', {
    uid: pro.uid,
    legalName: pro.legalName,
    tradeCategory: pro.tradeCategory,
    state: pro.state,
    district: pro.district,
    city: pro.city,
    lat: pro.lat,
    lng: pro.lng,
    locationUpdatedAt: pro.locationUpdatedAt,
  });
  recordLiveEvent({
    type: 'professional_location_updated',
    title: 'Technician Location Updated',
    detail: `${pro.legalName} shared live position in ${pro.city || pro.district}, ${pro.state}`,
    state: pro.state,
    district: pro.district,
    city: pro.city,
    professionalId: pro.uid,
    lat: pro.lat,
    lng: pro.lng,
  });
  res.json({ professional: pro });
});

// Live Activity Feed
app.get('/api/live-activity', (req, res) => {
  const { state, district, limit } = req.query as Record<string, string | undefined>;
  let events = db.liveEvents;
  if (state) {
    events = events.filter((e) => !e.state || e.state === state);
  }
  if (district) {
    events = events.filter((e) => !e.district || e.district === district);
  }
  const max = Math.min(Math.max(Number(limit) || 30, 1), 60);
  res.json({ events: events.slice(0, max) });
});

// Safe Live Map Overview (Sanitized active bookings + online verified pros)
app.get('/api/map-overview', (req, res) => {
  const actorId = String(req.header('x-user-id') ?? '').trim();
  const isAdmin = isAdminRequest(req);
  const userPro = actorId ? db.professionals[actorId] : undefined;

  let visibleBookings = Object.values(db.bookings);
  if (!isAdmin) {
    visibleBookings = visibleBookings.filter((b) => {
      if (b.customerId === actorId || b.professionalId === actorId) return true;
      if (
        userPro &&
        userPro.verificationStatus === 'approved' &&
        b.status === 'requested' &&
        b.tradeCategory === userPro.tradeCategory &&
        b.state === userPro.state
      ) {
        return true;
      }
      return false;
    });
  }
  visibleBookings.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  const topBookings = visibleBookings.slice(0, 50);
  const assignedProIds = new Set(
    topBookings
      .map((b) => b.professionalId)
      .filter((id): id is string => Boolean(id))
  );

  const onlineProfessionals = Object.values(db.professionals)
    .filter(
      (p) =>
        p.verificationStatus === 'approved' &&
        (p.isAvailable || isAdmin || assignedProIds.has(p.uid))
    )
    .map((p) => ({
      uid: p.uid,
      legalName: p.legalName,
      tradeCategory: p.tradeCategory,
      state: p.state,
      district: p.district,
      city: p.city,
      experienceYears: p.experienceYears,
      isAvailable: p.isAvailable,
      photoBase64: p.photoBase64,
      lat: p.lat,
      lng: p.lng,
      locationUpdatedAt: p.locationUpdatedAt,
    }));

  res.json({
    bookings: topBookings,
    professionals: onlineProfessionals,
  });
});

// Server-Side Geocoding API Proxy (avoids browser CORS & protects key)
const geocodeSessionCache = new Map<
  string,
  { lat: number; lng: number; formattedAddress: string; placeId?: string; cachedAt: number }
>();

app.get('/api/geocode', async (req, res) => {
  const rawAddress = String(req.query.address ?? '').trim();
  if (!rawAddress || rawAddress.length > 300) {
    res.status(400).json({ error: 'Address query parameter (1-300 chars) is required.' });
    return;
  }

  const cacheKey = rawAddress.toLowerCase();
  const cached = geocodeSessionCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 24 * 60 * 60 * 1000) {
    res.json({
      lat: cached.lat,
      lng: cached.lng,
      formattedAddress: cached.formattedAddress,
      placeId: cached.placeId,
      cached: true,
    });
    return;
  }

  const apiKey =
    process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
  if (!apiKey) {
    res.status(503).json({ error: 'Google Maps API key is not configured on the server.' });
    return;
  }

  try {
    // Primary: Geocoding API v4 endpoint
    const v4Url = `https://geocode.googleapis.com/v4/geocode/address/${encodeURIComponent(
      rawAddress
    )}?regionCode=IN&languageCode=en`;
    const v4Res = await fetch(v4Url, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'results.placeId,results.location,results.formattedAddress',
        'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
      },
    });

    if (v4Res.status === 429) {
      res.status(429).json({ error: 'RESOURCE_EXHAUSTED', quotaExceeded: true });
      return;
    }

    if (v4Res.ok) {
      const v4Data = (await v4Res.json()) as {
        results?: Array<{
          placeId?: string;
          formattedAddress?: string;
          location?: { latitude?: number; longitude?: number };
        }>;
      };
      const first = v4Data.results?.[0];
      if (
        first?.location &&
        typeof first.location.latitude === 'number' &&
        typeof first.location.longitude === 'number'
      ) {
        const result = {
          lat: first.location.latitude,
          lng: first.location.longitude,
          formattedAddress: first.formattedAddress || rawAddress,
          placeId: first.placeId,
        };
        geocodeSessionCache.set(cacheKey, { ...result, cachedAt: Date.now() });
        res.json(result);
        return;
      }
    } else {
      const errBody = (await v4Res.json().catch(() => ({}))) as {
        error?: { status?: string };
      };
      if (errBody.error?.status === 'RESOURCE_EXHAUSTED') {
        res.status(429).json({ error: 'RESOURCE_EXHAUSTED', quotaExceeded: true });
        return;
      }
    }

    // Fallback: Standard Geocoding REST endpoint (server-side)
    const restUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
      rawAddress
    )}&region=in&language=en&key=${encodeURIComponent(apiKey)}`;
    const restRes = await fetch(restUrl);
    if (restRes.status === 429) {
      res.status(429).json({ error: 'RESOURCE_EXHAUSTED', quotaExceeded: true });
      return;
    }
    const restData = (await restRes.json()) as {
      status?: string;
      results?: Array<{
        place_id?: string;
        formatted_address?: string;
        geometry?: { location?: { lat?: number; lng?: number } };
      }>;
    };

    if (restData.status === 'OVER_QUERY_LIMIT') {
      res.status(429).json({ error: 'RESOURCE_EXHAUSTED', quotaExceeded: true });
      return;
    }

    const restFirst = restData.results?.[0];
    if (
      restFirst?.geometry?.location &&
      typeof restFirst.geometry.location.lat === 'number' &&
      typeof restFirst.geometry.location.lng === 'number'
    ) {
      const result = {
        lat: restFirst.geometry.location.lat,
        lng: restFirst.geometry.location.lng,
        formattedAddress: restFirst.formatted_address || rawAddress,
        placeId: restFirst.place_id,
      };
      geocodeSessionCache.set(cacheKey, { ...result, cachedAt: Date.now() });
      res.json(result);
      return;
    }

    res.status(404).json({ error: 'No matching geographic coordinates found.' });
  } catch (err) {
    console.error('Geocoding proxy error:', err);
    res.status(502).json({ error: 'Unable to reach Geocoding service.' });
  }
});

// Admin-Only Platform Status & Quick Actions
app.get('/api/admin/platform-status', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: 'Admin privileges required.' });
    return;
  }
  res.json({ platformState: db.platformState });
});

app.post('/api/admin/quick-actions', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: 'Admin privileges required.' });
    return;
  }
  const { action, message } = req.body as {
    action?: 'notify_all_pros' | 'reset_maintenance_mode' | 'enable_maintenance_mode';
    message?: string;
  };
  const now = new Date().toISOString();

  if (action === 'notify_all_pros') {
    const approvedPros = Object.values(db.professionals).filter(
      (p) => p.verificationStatus === 'approved'
    );
    const broadcastMsg =
      String(message ?? '').trim().slice(0, 240) ||
      'High customer demand in your district. Toggle Online in Pro Portal to receive instant job alerts.';

    db.platformState.lastBroadcastAt = now;
    db.platformState.lastBroadcastMessage = broadcastMsg;
    db.platformState.lastNotifiedCount = approvedPros.length;
    saveDb();

    broadcastEvent('admin_broadcast', {
      message: broadcastMsg,
      timestamp: now,
      notifiedCount: approvedPros.length,
    });
    recordLiveEvent({
      type: 'admin_broadcast',
      title: 'Admin Broadcast to Verified Pros',
      detail: broadcastMsg,
    });

    res.json({
      ok: true,
      action,
      notifiedCount: approvedPros.length,
      platformState: db.platformState,
      detail: `Broadcast sent to ${approvedPros.length} verified ${
        approvedPros.length === 1 ? 'technician' : 'technicians'
      }.`,
    });
    return;
  }

  if (action === 'reset_maintenance_mode') {
    db.platformState.maintenanceMode = false;
    saveDb();
    broadcastEvent('platform_status_updated', db.platformState);
    res.json({
      ok: true,
      action,
      platformState: db.platformState,
      detail: 'Maintenance mode has been reset. Platform services are fully operational.',
    });
    return;
  }

  if (action === 'enable_maintenance_mode') {
    db.platformState.maintenanceMode = true;
    saveDb();
    broadcastEvent('platform_status_updated', db.platformState);
    res.json({
      ok: true,
      action,
      platformState: db.platformState,
      detail: 'Maintenance mode enabled for platform operations.',
    });
    return;
  }

  res.status(400).json({ error: 'Unsupported admin quick action.' });
});

// Admin-Only Service Catalog Editing
app.get('/api/admin/services', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: 'Admin privileges required.' });
    return;
  }
  res.json({ categories: db.service_categories });
});

app.put('/api/admin/services/:categoryId', (req, res) => {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: 'Admin privileges required.' });
    return;
  }
  const idx = db.service_categories.findIndex(
    (c) => c.categoryId === req.params.categoryId
  );
  if (idx === -1) {
    res.status(404).json({ error: 'Trade category not found.' });
    return;
  }

  const current = db.service_categories[idx];
  const body = req.body as Partial<ServiceCategory>;
  const title = String(body.title ?? current.title).trim();
  const tradeLabel = String(body.tradeLabel ?? current.tradeLabel).trim();
  const tagline = String(body.tagline ?? current.tagline).trim();
  const active = typeof body.active === 'boolean' ? body.active : current.active;

  if (title.length < 2 || title.length > 60) {
    res.status(400).json({ error: 'Trade title must be 2–60 characters.' });
    return;
  }
  if (tradeLabel.length < 2 || tradeLabel.length > 80) {
    res.status(400).json({ error: 'Trade subtitle must be 2–80 characters.' });
    return;
  }
  if (tagline.length < 4 || tagline.length > 180) {
    res.status(400).json({ error: 'Trade tagline must be 4–180 characters.' });
    return;
  }

  const rawSubs = Array.isArray(body.subServices) ? body.subServices : current.subServices;
  if (rawSubs.length === 0) {
    res.status(400).json({ error: 'Each trade must retain at least 1 sub-service.' });
    return;
  }

  const validatedSubs = [];
  for (const sub of rawSubs) {
    const subTitle = String(sub.title ?? '').trim();
    const subSummary = String(sub.summary ?? '').trim();
    const isFree = Boolean(sub.isFree) || Number(sub.priceInr) === 0;
    const priceInr = isFree ? 0 : Math.round(Number(sub.priceInr));
    const durationMins = Math.round(Number(sub.durationMins));
    const subId =
      String(sub.id ?? '').trim() ||
      subTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '') ||
      `svc_${crypto.randomBytes(3).toString('hex')}`;

    if (subTitle.length < 2 || subTitle.length > 80) {
      res.status(400).json({ error: `Invalid sub-service title: "${subTitle}".` });
      return;
    }
    if (!Number.isFinite(priceInr) || (priceInr !== 0 && (priceInr < 49 || priceInr > 100000))) {
      res.status(400).json({
        error: `Price for "${subTitle}" must be ₹0 (Free Base) or between ₹49 and ₹1,00,000.`,
      });
      return;
    }
    if (!Number.isFinite(durationMins) || durationMins < 15 || durationMins > 600) {
      res.status(400).json({
        error: `Duration for "${subTitle}" must be between 15 and 600 minutes.`,
      });
      return;
    }

    validatedSubs.push({
      id: subId,
      title: subTitle,
      priceInr,
      isFree,
      durationMins,
      summary: subSummary.slice(0, 200) || `${subTitle} by verified specialist.`,
    });
  }

  const updatedCategory: ServiceCategory = {
    ...current,
    title,
    tradeLabel,
    tagline,
    active,
    subServices: validatedSubs,
  };

  db.service_categories[idx] = updatedCategory;
  saveDb();
  broadcastEvent(
    'services_updated',
    db.service_categories.filter((c) => c.active)
  );
  recordLiveEvent({
    type: 'services_updated',
    title: `Service Catalog Updated: ${updatedCategory.title}`,
    detail: `${updatedCategory.subServices.length} sub-services configured (${
      updatedCategory.active ? 'Active' : 'Paused'
    })`,
  });
  res.json({ category: updatedCategory, categories: db.service_categories });
});

// Vite dev middleware or static production build + HTTP & WebSocket Server
async function startServer() {
  const PORT = 3000;
  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    try {
      ws.send(
        JSON.stringify({
          event: 'connected',
          payload: { events: db.liveEvents.slice(0, 25) },
        })
      );
    } catch {
      // ignore send errors
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          type?: string;
          uid?: string;
          lat?: number;
          lng?: number;
        };
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ event: 'pong', payload: { ts: Date.now() } }));
        } else if (
          msg.type === 'technician:location' &&
          msg.uid &&
          typeof msg.lat === 'number' &&
          typeof msg.lng === 'number'
        ) {
          const pro = db.professionals[msg.uid];
          if (pro && pro.verificationStatus === 'approved') {
            pro.lat = msg.lat;
            pro.lng = msg.lng;
            pro.locationUpdatedAt = new Date().toISOString();
            pro.updatedAt = pro.locationUpdatedAt;
            db.professionals[pro.uid] = pro;
            saveDb();
            broadcastEvent('professional_location_updated', {
              uid: pro.uid,
              legalName: pro.legalName,
              tradeCategory: pro.tradeCategory,
              state: pro.state,
              district: pro.district,
              city: pro.city,
              lat: pro.lat,
              lng: pro.lng,
              locationUpdatedAt: pro.locationUpdatedAt,
            });
          }
        }
      } catch {
        // ignore invalid WS JSON
      }
    });

    ws.on('close', () => {
      wsClients.delete(ws);
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        ws: {
          server: httpServer,
          path: '/vite-hmr',
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    const distHtmlPath = path.join(distDir, 'index.html');
    app.get('*', (req, res) => {
      const reqPath = (req.path || '/').toLowerCase();
      if (!fs.existsSync(distHtmlPath)) {
        res.status(404).send('App bundle not built');
        return;
      }
      let html = fs.readFileSync(distHtmlPath, 'utf-8');
      if (reqPath.startsWith('/customer')) {
        html = html
          .replace('href="/manifest.webmanifest"', 'href="/manifest-customer.webmanifest"')
          .replace('href="/apple-touch-icon.png"', 'href="/icons/customer-apple-180.png"')
          .replace('href="/icon.svg"', 'href="/icons/customer-icon.svg"')
          .replace('content="#0F4C5C"', 'content="#E36414"')
          .replace('content="P-Pick Hub"', 'content="P-Pick"')
          .replace(
            /<title>.*?<\/title>/,
            '<title>P-Pick — Customer Home Services App</title>'
          );
      } else if (
        reqPath.startsWith('/technician') ||
        reqPath.startsWith('/partner') ||
        reqPath.startsWith('/pro')
      ) {
        html = html
          .replace('href="/manifest.webmanifest"', 'href="/manifest-technician.webmanifest"')
          .replace('href="/apple-touch-icon.png"', 'href="/icons/technician-apple-180.png"')
          .replace('href="/icon.svg"', 'href="/icons/technician-icon.svg"')
          .replace('content="#0F4C5C"', 'content="#1B7F5A"')
          .replace('content="P-Pick Hub"', 'content="P-Pick Pro"')
          .replace(
            /<title>.*?<\/title>/,
            '<title>P-Pick Pro — Technician Partner App</title>'
          );
      } else if (reqPath.startsWith('/admin')) {
        html = html
          .replace('href="/manifest.webmanifest"', 'href="/manifest-admin.webmanifest"')
          .replace('href="/apple-touch-icon.png"', 'href="/icons/admin-apple-180.png"')
          .replace('href="/icon.svg"', 'href="/icons/admin-icon.svg"')
          .replace('content="#0F4C5C"', 'content="#0F172A"')
          .replace('content="P-Pick Hub"', 'content="P-PickOps"')
          .replace(
            /<title>.*?<\/title>/,
            '<title>P-PickOps — Admin Operations App</title>'
          );
      }
      res.type('html').send(html);
    });
  }

  httpServer.on('upgrade', (request, socket, head) => {
    const urlPath = (request.url || '').split('?')[0];
    if (urlPath === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (urlPath !== '/vite-hmr') {
      socket.destroy();
    }
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`P-Pick HTTP + WebSocket server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
