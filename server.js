const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Utility ----
function wrapAsync(fn) {
  return function(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function adminAuth(req, res, next) {
  const role = (req.headers['x-role'] || '').toLowerCase();
  if (role !== 'admin') return res.status(403).json({ error: 'Akses admin diperlukan' });
  next();
}

function parsePagination(req) {
  const page = Math.max(1, parseInt(req.query.page || '1'));
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '20')));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// ---- TAMBAHAN: Helper Waktu WIB ----
function getNowWIB() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
}

// Inisialisasi WhatsApp Client
const waClient = new Client({
    authStrategy: new LocalAuth()
});

waClient.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('SILAKAN SCAN QR CODE INI UNTUK LOGIN WHATSAPP BOT');
});

waClient.on('ready', () => {
    console.log('OK - WhatsApp Bot sudah siap!');
});

waClient.initialize();

// ---- Config ----
const EMAIL_CONFIG = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  user: '',
  pass: '',
  from: '"PawCare Petshop" <noreply@pawcare.id>'
};

const SLOT_CONFIG = {
  hours: ['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00'],
  maxPerSlot: 2
};

const DAILY_MAX_BOOKINGS = 15;
const STORE_COORDS = { lat: -6.200000, lng: 106.816666 };
const numberFields = ['price','harga','biaya','total','total_price','subtotal','stock','stok','qty','jumlah','duration','berat','weight','discount','rating','surcharge','lat','lng','shipping_cost'];

// ---- Helpers ----
function deg2rad(deg) { return deg * (Math.PI / 180); }

function haversineKm(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var dLat = deg2rad(lat2 - lat1);
  var dLon = deg2rad(lon2 - lon1);
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
          Math.sin(dLon/2) * Math.sin(dLon/2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getModel(col) {
  if (mongoose.models[col]) return mongoose.models[col];
  return mongoose.model(col, new mongoose.Schema({}, { strict: false }));
}

function cleanDoc(doc) {
  if (!doc) return doc;
  const c = { _id: doc._id };
  for (const [k, v] of Object.entries(doc)) {
    if (k === '__v' || v === null || v === undefined || v === 'undefined' || (typeof v === 'string' && v.trim() === '')) continue;
    if (typeof v === 'string' && !isNaN(v) && v.trim() !== '' && numberFields.includes(k.toLowerCase())) c[k] = Number(v);
    else c[k] = v;
  }
  return c;
}

function sendEmail(to, subject, html) {
  if (!EMAIL_CONFIG.user) {
    console.log('[EMAIL SKIP] Ke:', to, '| Subjek:', subject);
    return Promise.resolve();
  }
  const transporter = nodemailer.createTransport(EMAIL_CONFIG);
  return transporter.sendMail({ from: EMAIL_CONFIG.from, to, subject, html });
}

async function sendWhatsApp(phone, message) {
  if (!phone) {
    console.log('[WA SKIP] Tidak ada nomor telepon');
    return Promise.resolve();
  }

  let formattedPhone = phone.replace(/\D/g, ''); // Hapus karakter non-angka
  if (formattedPhone.startsWith('0')) {
      formattedPhone = '62' + formattedPhone.substring(1);
  }
  if (!formattedPhone.endsWith('@c.us')) {
      formattedPhone += '@c.us';
  }

  try {
      await waClient.sendMessage(formattedPhone, message);
      console.log(`[WA SUCCESS] Pesan terkirim ke ${formattedPhone}`);
  } catch (error) {
      console.error(`[WA ERROR] Gagal kirim pesan ke ${formattedPhone}:`, error);
  }
}

async function countSlotBookings(date, time) {
  return getModel('appointments').countDocuments({ date, time });
}

// ===== User Model =====
const User = mongoose.model('User', new mongoose.Schema({
  email: String, password: String, name: String, phone: String, role: String
}, { strict: false }));

// ===== AUTH =====
app.post('/api/login', async (req, res) => {
  try {
    const u = await User.findOne({ email: req.body.email, password: req.body.password });
    if (!u) return res.status(400).json({ error: 'Email atau password salah' });
    res.json({ email: u.email, name: u.name, phone: u.phone, role: u.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/register', async (req, res) => {
  try {
    if (!req.body.email || !req.body.password || !req.body.name)
      return res.status(400).json({ error: 'Email, password, nama wajib diisi' });
    if (await User.findOne({ email: req.body.email }))
      return res.status(400).json({ error: 'Email sudah terdaftar' });
    const u = await User.create({ ...req.body, role: 'user' });
    res.json({ email: u.email, name: u.name, phone: u.phone, role: u.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile', async (req, res) => {
  try {
    const update = { name: req.body.name, phone: req.body.phone };
    if (req.body.password) update.password = req.body.password;
    const u = await User.findOneAndUpdate({ email: req.body.email }, update, { new: true });
    if (!u) return res.status(404).json({ error: 'Tidak ditemukan' });
    res.json({ email: u.email, name: u.name, phone: u.phone, role: u.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== GENERIC CRUD =====
app.get('/api/collections', async (req, res) => {
  try {
    const cols = await mongoose.connection.db.listCollections().toArray();
    // TAMBAHAN: Sembunyikan users, employees, dan doctors dari list menu Admin default
    res.json(cols.map(c => c.name).filter(n => n !== 'users' && n !== 'employees' && n !== 'doctors'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:col', async (req, res) => {
  try {
    const raw = await getModel(req.params.col).find().sort({ _id: -1 }).lean();
    res.json(raw.map(cleanDoc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:col/:id', async (req, res) => {
  try {
    const doc = await getModel(req.params.col).findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Tidak ditemukan' });
    res.json(cleanDoc(doc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:col', async (req, res) => {
  try {
    const doc = await getModel(req.params.col).create(req.body);
    res.json(cleanDoc(doc.toObject()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/data/:col/:id', async (req, res) => {
  try {
    const doc = await getModel(req.params.col).findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ error: 'Tidak ditemukan' });
    res.json(cleanDoc(doc.toObject()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/data/:col/:id', async (req, res) => {
  try {
    await getModel(req.params.col).findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== USER APPOINTMENTS =====
app.get('/api/my-appointments', async (req, res) => {
  try {
    const raw = await getModel('appointments').find({ customer_email: req.headers['x-email'] }).sort({ _id: -1 }).lean();
    res.json(raw.map(cleanDoc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/my-appointments', async (req, res) => {
  try {
    const { date, time, service_name } = req.body;
    if (date) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (new Date(date + 'T00:00:00') < today)
        return res.status(400).json({ error: 'Tidak bisa booking di tanggal yang sudah lewat' });
    }
    if (time) {
      if (SLOT_CONFIG.hours.indexOf(time) < 0)
        return res.status(400).json({ error: 'Waktu tidak valid' });
      const booked = await countSlotBookings(date, time);
      if (booked >= SLOT_CONFIG.maxPerSlot)
        return res.status(400).json({ error: 'Slot jam ' + time + ' pada ' + date + ' sudah penuh.' });
    }
    if (date) {
      const dayCount = await getModel('appointments').countDocuments({ date });
      if (dayCount >= DAILY_MAX_BOOKINGS)
        return res.status(400).json({ error: 'Kuota booking harian penuh' });
    }
    
    // ---- TAMBAHAN: Validasi WIB untuk proteksi backend ----
    if (date && time) {
      const now = getNowWIB();
      if (date === now.toISOString().split('T')[0]) {
        const [slotH, slotM] = time.split(':').map(Number);
        if (now.getHours() > slotH || (now.getHours() === slotH && now.getMinutes() >= slotM)) {
          return res.status(400).json({ error: 'Slot waktu sudah terlewat hari ini.' });
        }
      }
    }

    const nameLower = (service_name || '').toLowerCase();
    const isSteril = nameLower.includes('steril') || nameLower.includes('sterilisasi');
    req.body.status = isSteril ? 'Pending' : 'Disetujui';
    if (isSteril) { req.body.date = null; req.body.time = null; }
    req.body.customer_email = req.headers['x-email'];
    const doc = await getModel('appointments').create(req.body);
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/my-appointments/:id', async (req, res) => {
  try {
    await getModel('appointments').findOneAndDelete({ _id: req.params.id, customer_email: req.headers['x-email'] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ADMIN: APPROVE APPOINTMENT =====
app.put('/api/appointments/:id/approve', adminAuth, async (req, res) => {
  try {
    const Apt = getModel('appointments');
    const apt = await Apt.findById(req.params.id);
    if (!apt) return res.status(404).json({ error: 'Tidak ditemukan' });
    const newDate = req.body.date !== undefined ? req.body.date : apt.date;
    const newTime = req.body.time !== undefined ? req.body.time : apt.time;
    if (newDate) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (new Date(newDate + 'T00:00:00') < today)
        return res.status(400).json({ error: 'Tanggal tidak boleh di masa lalu' });
    }
    if (newTime) {
      if (SLOT_CONFIG.hours.indexOf(newTime) < 0)
        return res.status(400).json({ error: 'Waktu tidak valid' });
      const booked = await Apt.countDocuments({ date: newDate, time: newTime, _id: { $ne: apt._id } });
      if (booked >= SLOT_CONFIG.maxPerSlot)
        return res.status(400).json({ error: 'Slot sudah penuh' });
    }
    if (newDate) {
      const dayCount = await Apt.countDocuments({ date: newDate, _id: { $ne: apt._id } });
      if (dayCount >= DAILY_MAX_BOOKINGS)
        return res.status(400).json({ error: 'Kuota harian penuh' });
    }
    apt.status = 'Disetujui';
    apt.doctor_name = req.body.doctor_name || apt.doctor_name;
    apt.date = newDate || apt.date;
    apt.time = newTime || apt.time;
    apt.approved_at = new Date();
    await apt.save();
    if (apt.customer_email) {
      await sendEmail(apt.customer_email, 'PawCare - Appointment Disetujui',
        '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">' +
        '<div style="background:#2d6a4f;color:#fff;padding:20px;border-radius:12px 12px 0;text-align:center"><h2 style="margin:0">Appointment Disetujui</h2></div>' +
        '<div style="background:#fff;padding:24px;border:1px solid #e0d8cc;border-radius:0 0 12px 12px">' +
        '<p>Halo <b>' + (apt.customer_name || 'Pelanggan') + '</b>,</p>' +
        '<p>Appointment <b>' + (apt.pet_name || '-') + '</b> (' + (apt.pet_type || '-') + ') <b style="color:#16a34a">disetujui</b>.</p>' +
        '<p>Layanan: ' + (apt.service_name || '-') + '<br>Tanggal: ' + (apt.date || '-') + '<br>Jam: ' + (apt.time || '-') + '<br>Dokter: ' + (apt.doctor_name || '-') + '</p>' +
        (apt.total_price ? '<p style="font-size:18px;font-weight:900;color:#2d6a4f">Rp ' + Number(apt.total_price).toLocaleString('id-ID') + '</p>' : '') +
        '</div></div>'
      ).catch(function(e) { console.log('Email gagal:', e.message); });
    }
    res.json(cleanDoc(apt.toObject()));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/appointments/:id/status', async (req, res) => {
  try {
    const apt = await getModel('appointments').findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    if (!apt) return res.status(404).json({ error: 'Tidak ditemukan' });
    res.json(cleanDoc(apt.toObject()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== USER ORDERS =====
app.post('/api/orders', async (req, res) => {
  try {
    req.body.customer_email = req.headers['x-email'];
    // TAMBAHAN: Status otomatis menjadi "Menunggu Verifikasi"
    req.body.status = 'Menunggu Verifikasi';
    req.body.created_at = new Date();
    var dm = (req.body.delivery_method || 'pickup').toLowerCase();
    req.body.delivery_method = dm === 'delivery' ? 'delivery' : 'pickup';
    if (req.body.delivery_method === 'delivery' && !req.body.address)
      return res.status(400).json({ error: 'Alamat wajib diisi untuk delivery' });
    var shippingCost = 0;
    if (req.body.delivery_method === 'delivery' && req.body.lat && req.body.lng) {
      var lat = Number(req.body.lat);
      var lng = Number(req.body.lng);
      shippingCost = Math.round(haversineKm(STORE_COORDS.lat, STORE_COORDS.lng, lat, lng) * 2500);
      req.body.shipping_cost = shippingCost;
      req.body.lat = lat;
      req.body.lng = lng;
    } else {
      req.body.shipping_cost = 0;
    }
    const ord = await getModel('orders').create(req.body);
    if (req.body.customer_email) {
      await sendEmail(req.body.customer_email, 'PawCare - Pesanan Dibuat',
        '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">' +
        '<div style="background:#2d6a4f;color:#fff;padding:20px;border-radius:12px 12px 0;text-align:center"><h2 style="margin:0">Pesanan Berhasil</h2></div>' +
        '<div style="background:#fff;padding:24px;border:1px solid #e0d8cc;border-radius:0 0 12px 12px">' +
        '<p>Halo <b>' + (req.body.customer_name || 'Pelanggan') + '</b>, pesanan Anda telah diterima.</p>' +
        '<p>Total: <b style="color:#2d6a4f">Rp ' + Number(req.body.total_price || 0).toLocaleString('id-ID') + '</b></p>' +
        '</div></div>'
      ).catch(function(e) { console.log('Email order gagal:', e.message); });
    }
    res.json(ord);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/my-orders', async (req, res) => {
  try {
    const raw = await getModel('orders').find({ customer_email: req.headers['x-email'] }).sort({ _id: -1 }).lean();
    res.json(raw.map(cleanDoc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== SLOTS =====
app.get('/api/slots', async (req, res) => {
  try {
    const tanggal = req.query.tanggal;
    if (!tanggal) return res.status(400).json({ error: 'Parameter tanggal wajib' });
    const bookings = await getModel('appointments').find({ date: tanggal }, 'time').lean();
    const countMap = {};
    for (const b of bookings) { if (b.time) countMap[b.time] = (countMap[b.time] || 0) + 1; }
    
    // TAMBAHAN: Validasi Waktu WIB
    const now = getNowWIB();
    const todayStr = now.toISOString().split('T')[0];
    const isToday = (tanggal === todayStr);
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();

    const slots = SLOT_CONFIG.hours.map(function(hour) {
      let isPast = false;
      if (isToday) {
        const [slotH, slotM] = hour.split(':').map(Number);
        if (currentHour > slotH || (currentHour === slotH && currentMin >= slotM)) {
          isPast = true;
        }
      }
      const bookedCount = countMap[hour] || 0;
      const full = isPast || (bookedCount >= SLOT_CONFIG.maxPerSlot);

      return { 
        time: hour, 
        booked: bookedCount, 
        available: isPast ? 0 : Math.max(0, SLOT_CONFIG.maxPerSlot - bookedCount), 
        full: full 
      };
    });
    res.json({ tanggal: tanggal, slots: slots, maxPerSlot: SLOT_CONFIG.maxPerSlot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/slots/check', async (req, res) => {
  try {
    const { tanggal, jam } = req.query;
    if (!tanggal || !jam) return res.status(400).json({ error: 'tanggal dan jam wajib' });
    const booked = await countSlotBookings(tanggal, jam);
    res.json({ tanggal: tanggal, time: jam, booked: booked, available: Math.max(0, SLOT_CONFIG.maxPerSlot - booked), full: booked >= SLOT_CONFIG.maxPerSlot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ADMIN REPORTS & DOCTORS STATS (TAMBAHAN) =====
app.get('/api/admin/reports', adminAuth, wrapAsync(async (req, res) => {
  const orders = await getModel('orders').find({ status: { $in: ['Selesai', 'Diterima'] } }).lean();
  const appointments = await getModel('appointments').find({ status: 'Selesai' }).lean();
  
  let totalOrderRev = 0;
  orders.forEach(o => totalOrderRev += (Number(o.total_price) || 0));
  let totalAptRev = 0;
  appointments.forEach(a => totalAptRev += (Number(a.total_price) || 0));

  res.json({
    total_revenue: totalOrderRev + totalAptRev,
    orders_completed: orders.length,
    appointments_completed: appointments.length
  });
}));

app.get('/api/admin/doctors-stats', adminAuth, wrapAsync(async (req, res) => {
  const doctors = await getModel('doctors').find().lean();
  const appointments = await getModel('appointments').find({ status: { $nin: ['Batal', 'Ditolak'] } }).lean();
  
  const stats = doctors.map(doc => {
    const activeCount = appointments.filter(a => a.doctor_name === doc.name).length;
    return { ...cleanDoc(doc), active_appointments: activeCount };
  });
  res.json(stats);
}));

// ===== ADMIN PAGINATED =====
app.get('/api/admin/appointments', adminAuth, wrapAsync(async (req, res) => {
  const { page, limit, skip } = parsePagination(req);
  const [total, docs] = await Promise.all([getModel('appointments').countDocuments(), getModel('appointments').find().sort({ _id: -1 }).skip(skip).limit(limit).lean()]);
  res.json({ meta: { page, limit, total }, data: docs.map(cleanDoc) });
}));

app.get('/api/admin/orders', adminAuth, wrapAsync(async (req, res) => {
  const { page, limit, skip } = parsePagination(req);
  const [total, docs] = await Promise.all([getModel('orders').countDocuments(), getModel('orders').find().sort({ _id: -1 }).skip(skip).limit(limit).lean()]);
  res.json({ meta: { page, limit, total }, data: docs.map(cleanDoc) });
}));

app.get('/api/admin/users', adminAuth, wrapAsync(async (req, res) => {
  const { page, limit, skip } = parsePagination(req);
  const [total, users] = await Promise.all([User.countDocuments(), User.find().sort({ _id: -1 }).skip(skip).limit(limit).lean()]);
  res.json({ meta: { page, limit, total }, data: users.map(function(u) { delete u.password; return cleanDoc(u); }) });
}));

app.post('/api/admin/users', adminAuth, wrapAsync(async (req, res) => {
  const { email, password, name, phone, role } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, password, name wajib' });
  if (await User.findOne({ email })) return res.status(400).json({ error: 'Email sudah terdaftar' });
  const u = await User.create({ email, password, name, phone, role: role || 'user' });
  delete u.password;
  res.json(cleanDoc(u.toObject()));
}));

app.put('/api/admin/users/:id', adminAuth, wrapAsync(async (req, res) => {
  const update = { name: req.body.name, phone: req.body.phone };
  if (req.body.password) update.password = req.body.password;
  if (req.body.role) update.role = req.body.role;
  const u = await User.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
  if (!u) return res.status(404).json({ error: 'Tidak ditemukan' });
  delete u.password;
  res.json(cleanDoc(u));
}));

app.delete('/api/admin/users/:id', adminAuth, wrapAsync(async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().lean();
    res.json(users.map(function(u) { delete u.password; return cleanDoc(u); }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ADMIN WHATSAPP =====
app.post('/api/admin/whatsapp', adminAuth, wrapAsync(async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'Nomor HP dan pesan wajib' });
  await sendWhatsApp(phone, message);
  res.json({ ok: true, sent: true });
}));

app.post('/api/admin/whatsapp/bulk-appointment', adminAuth, wrapAsync(async (req, res) => {
  const { appointment_id, custom_message } = req.body;
  const apt = await getModel('appointments').findById(appointment_id);
  if (!apt) return res.status(404).json({ error: 'Appointment tidak ditemukan' });
  const phone = apt.customer_phone || apt.phone || '';
  if (!phone) return res.status(400).json({ error: 'Tidak ada nomor HP' });
  var message = custom_message;
  if (!message) {
    var svcLower = (apt.service_name || '').toLowerCase();
    var header = 'Halo ' + (apt.customer_name || 'Pelanggan') + ',\n\nPawCare Petshop';
    var body = 'Hewan: ' + (apt.pet_name || '-') + ' (' + (apt.pet_type || '-') + ')\nLayanan: ' + (apt.service_name || '-') + '\nTanggal: ' + (apt.date || 'Menunggu jadwal') + '\nJam: ' + (apt.time || 'Menunggu jadwal') + '\nDokter: ' + (apt.doctor_name || 'Akan ditentukan');
    if (svcLower.includes('steril')) {
      message = header + ' - Konfirmasi Sterilisasi\n\n' + body + '\n\nPENTING:\n- Puasakan hewan minimal 8 jam sebelum prosedur\n- Bawa hewan dalam carrier/kandang\n- Pastikan hewan dalam kondisi sehat\n\nHubungi (021) 1234-5678 jika ada pertanyaan.\n\nTerima kasih\nPawCare Petshop';
    } else if (svcLower.includes('groom')) {
      message = header + ' - Konfirmasi Grooming\n\n' + body + (apt.total_price ? '\nEstimasi: Rp ' + Number(apt.total_price).toLocaleString('id-ID') : '') + '\n\nTips:\n- Datang 10 menit sebelum jadwal\n\nHubungi (021) 1234-5678 jika ada pertanyaan.\n\nTerima kasih\nPawCare Petshop';
    } else if (svcLower.includes('vaksin') || svcLower.includes('fvrcp') || svcLower.includes('rabies') || svcLower.includes('leptosp') || svcLower.includes('distemper')) {
      message = header + ' - Konfirmasi Vaksinasi\n\n' + body + (apt.total_price ? '\nBiaya: Rp ' + Number(apt.total_price).toLocaleString('id-ID') : '') + '\n\nCatatan:\n- Hewan harus sehat dan tidak demam\n- Bawa buku vaksinasi sebelumnya jika ada\n- Hindari aktivitas berat 24 jam setelah vaksinasi\n\nHubungi (021) 1234-5678 jika ada pertanyaan.\n\nTerima kasih\nPawCare Petshop';
    } else {
      message = header + ' - Konfirmasi Appointment\n\n' + body + '\nStatus: ' + (apt.status || '-') + '\n\nHubungi (021) 1234-5678 jika ada pertanyaan.\n\nTerima kasih\nPawCare Petshop';
    }
  }
  await sendWhatsApp(phone, message);
  res.json({ ok: true, sent: true, phone: phone, message: message });
}));

app.post('/api/admin/whatsapp/order-delivery', adminAuth, wrapAsync(async (req, res) => {
  const { order_id, custom_message, status } = req.body;
  const ord = await getModel('orders').findById(order_id);
  if (!ord) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  const phone = ord.customer_phone || ord.phone || '';
  if (!phone) return res.status(400).json({ error: 'Tidak ada nomor HP' });
  var message = custom_message;
  if (!message) {
    var statusText = status || ord.status || 'Diproses';
    message = 'Halo ' + (ord.customer_name || 'Pelanggan') + ',\n\n' +
      'PawCare Petshop - Update Pesanan\n\n' +
      'ID: ' + ord._id + '\n' +
      'Metode: ' + (ord.delivery_method === 'delivery' ? 'Delivery' : 'Pickup') + '\n' +
      'Pembayaran: ' + (ord.payment_method || '-') + '\n' +
      'Item: ' + (ord.items || ord.item_names || '-') + '\n' +
      (ord.total_price ? 'Total: Rp ' + Number(ord.total_price).toLocaleString('id-ID') + '\n' : '') +
      '\nStatus: ' + statusText + '\n';
    if (statusText === 'Dikirim' && ord.address) {
      message += '\nDikirim ke:\n' + ord.address + '\n\nEstimasi tiba 1-3 jam.\n';
    } else if (statusText === 'Diterima' || statusText === 'Selesai') {
      message += '\nTerima kasih telah berbelanja di PawCare!\n';
    } else {
      message += '\nPesanan sedang kami proses.\n';
    }
    message += '\nHubungi (021) 1234-5678 jika ada pertanyaan.\n\nTerima kasih\nPawCare Petshop';
  }
  await sendWhatsApp(phone, message);
  res.json({ ok: true, sent: true, phone: phone, message: message });
}));

// ===== ERROR HANDLER =====
app.use(function(err, req, res, next) {
  console.error('ERROR:', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// ===== SPA FALLBACK =====
app.use(function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== START SERVER =====
const PORT = 3100;

mongoose.connect('mongodb://localhost:27017/petshop_db')
  .then(function() {
    console.log('OK - MongoDB nyambung');
    app.listen(PORT, function() {
      console.log('Buka: http://localhost:' + PORT);
    });
  })