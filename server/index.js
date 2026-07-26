const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const uploadDir = path.join(__dirname, 'public', 'uploads');
let dataVersion = Date.now();
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeName = `${Date.now()}-${crypto.randomUUID()}-${file.originalname.replace(/\s+/g, '-')}`;
    cb(null, safeName);
  }
});

const upload = multer({ storage });

function getUploadsBucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
}

async function persistUpload(file) {
  if (!file?.path || !file.filename) return;
  const bucket = getUploadsBucket();
  const existing = await bucket.find({ filename: file.filename }).limit(1).next();
  if (existing) return;
  await new Promise((resolve, reject) => {
    fs.createReadStream(file.path)
      .pipe(bucket.openUploadStream(file.filename, {
        contentType: file.mimetype || 'application/octet-stream',
        metadata: { originalName: file.originalname || file.filename }
      }))
      .on('error', reject)
      .on('finish', resolve);
  });
}

async function persistRequestUploads(req) {
  const files = [
    ...(req.file ? [req.file] : []),
    ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat())
  ];
  await Promise.all(files.map(persistUpload));
}

const durableUpload = (middleware) => (req, res, next) => {
  middleware(req, res, async (error) => {
    if (error) return next(error);
    try {
      await persistRequestUploads(req);
      next();
    } catch (persistError) {
      next(persistError);
    }
  });
};

async function migrateLocalUploads() {
  const contentTypes = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
    '.pdf': 'application/pdf'
  };
  const entries = await fs.promises.readdir(uploadDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === '.gitkeep') continue;
    await persistUpload({
      path: path.join(uploadDir, entry.name),
      filename: entry.name,
      originalname: entry.name,
      mimetype: contentTypes[path.extname(entry.name).toLowerCase()] || 'application/octet-stream'
    });
  }
}

const categoryAliases = {
  'all rounder': 'allrounder',
  'all-rounder': 'allrounder',
  'allrounder': 'allrounder',
  'batsman': 'batsmen',
  'batman': 'batsmen',
  'batsmen': 'batsmen',
  'bowler': 'bowler',
  'bowlers': 'bowler',
  'wicket keeper': 'wicketkeeper',
  'wicket-keeper': 'wicketkeeper',
  'wicketkeeper': 'wicketkeeper'
  ,
  'mvp': 'mvp',
  'most valuable player': 'mvp'
};

const normalizeCategory = (value) => {
  if (!value) return 'allrounder';
  const normalized = String(value).trim().toLowerCase();
  return categoryAliases[normalized] || normalized.replace(/\s+/g, '');
};

function normalizePhoneNumber(phone) {
  const value = String(phone || '').trim();
  if (!value) return '';
  if (/[a-zA-Z]/.test(value)) return '';

  const compact = value.replace(/[^\d+]/g, '');
  if (!compact) return '';

  if (compact.startsWith('+')) {
    const digitsOnly = compact.replace(/\D/g, '');
    return digitsOnly.length >= 10 ? `+${digitsOnly}` : '';
  }

  const digitsOnly = compact.replace(/\D/g, '');
  if (!digitsOnly) return '';
  if (digitsOnly.length === 10) return `+91${digitsOnly}`;
  if (digitsOnly.length > 10 && digitsOnly.startsWith('91')) return `+${digitsOnly}`;
  if (digitsOnly.length > 10) return `+${digitsOnly}`;
  return '';
}

async function sendApprovalMessage(_phone, _playerName) {
  return { sent: false, reason: 'disabled' };
}

async function deleteUploadFile(filePath) {
  if (!filePath) return;
  const normalizedPath = String(filePath).trim();
  if (!normalizedPath || !normalizedPath.startsWith('/uploads/')) return;
  const fileName = path.basename(normalizedPath);
  const absolutePath = path.join(uploadDir, fileName);
  if (mongoose.connection.readyState === 1) {
    const bucket = getUploadsBucket();
    const storedFiles = await bucket.find({ filename: fileName }).toArray();
    await Promise.all(storedFiles.map((file) => bucket.delete(file._id)));
  }
  try {
    await fs.promises.unlink(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to delete upload file', absolutePath, error.message);
    }
  }
}

function parseRoleSelections(rawValues) {
  const values = Array.isArray(rawValues) ? rawValues : rawValues ? [rawValues] : [];
  return values.flatMap((value) => {
    if (!value) return [];
    const text = String(value).trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return text.includes(',') ? text.split(',').map((entry) => entry.trim()).filter(Boolean) : [text];
    }
  }).map((role) => String(role).trim()).filter(Boolean);
}

const playerSchema = new mongoose.Schema({
  name: String,
  image: String,
  details: String,
  category: String,
  auctionNumber: Number,
  playedIn: String,
  team: String,
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
  amount: Number,
  phone: String,
  sold: Boolean,
  unsold: Boolean,
  source: String,
  registrationRoles: [String],
  battingStyle: String,
  bowlingStyle: String,
  paymentReceipt: String,
  previouslyPlayedIn: String,
  registrationStatus: { type: String, default: 'pending' }
}, { timestamps: true });

const settingsSchema = new mongoose.Schema({
  backgroundImage: String,
  logo: String,
  auctionStartAudio: String,
  playerSoldAudio: String,
  welcomeVideo: { type: String, default: '' },
  playerLimitEnabled: { type: Boolean, default: false },
  maxPlayersPerTeam: { type: Number, default: 0, min: 0 },
  auctionCardSelectionEnabled: { type: Boolean, default: false },
  categoryImages: {
    allrounder: { type: String, default: '' },
    batsmen: { type: String, default: '' },
    bowler: { type: String, default: '' },
    wicketkeeper: { type: String, default: '' }
    ,
    mvp: { type: String, default: '' }
  },
  teams: [{
    name: String,
    logo: String
  }]
}, { timestamps: true });

const Player = mongoose.model('Player', playerSchema);
const Settings = mongoose.model('Settings', settingsSchema);
const teamSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  logo: { type: String, default: '' },
  purse: { type: Number, default: 0, min: 0 },
  remainingPurse: { type: Number, default: 0, min: 0 }
}, { timestamps: true });
const Team = mongoose.model('Team', teamSchema);
const testimonialSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  eventDate: String,
  images: [String],
  winnerName: String,
  winnerImage: String,
  highlighted: { type: Boolean, default: false }
}, { timestamps: true });
const Testimonial = mongoose.model('Testimonial', testimonialSchema);

async function connectDatabase() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/auctiondb';

  await mongoose.connect(mongoUri, {
    dbName: 'auctiondb',
    serverSelectionTimeoutMS: 5000
  });

  console.log(`Connected to MongoDB (${mongoose.connection.name})`);
}

async function initializeDatabase() {
  await Player.updateMany(
    {
      sold: { $ne: true },
      team: { $nin: ['', null] },
      $or: [{ playedIn: { $exists: false } }, { playedIn: '' }, { playedIn: null }]
    },
    [{ $set: { playedIn: '$team', team: '' } }]
  );

  for (const category of ['allrounder', 'batsmen', 'bowler', 'wicketkeeper', 'mvp']) {
    const numberedPlayers = await Player.find({ category, auctionNumber: { $ne: null } }).select('auctionNumber').lean();
    const usedNumbers = new Set(numberedPlayers.map((player) => player.auctionNumber));
    let nextNumber = 1;
    const unnumberedPlayers = await Player.find({
      category,
      $or: [{ auctionNumber: { $exists: false } }, { auctionNumber: null }]
    }).sort({ createdAt: 1 });
    for (const player of unnumberedPlayers) {
      while (usedNumbers.has(nextNumber)) nextNumber += 1;
      player.auctionNumber = nextNumber;
      usedNumbers.add(nextNumber);
      await player.save();
    }
  }

  const registrationPlayers = await Player.find({ source: 'registration' }).lean();
  for (const player of registrationPlayers) {
    const selectedRoles = parseRoleSelections(player.registrationRoles || []);
    const nextCategory = resolveRegistrationCategory(selectedRoles, player.category || 'allrounder');
    const updates = {};
    if (nextCategory !== player.category) {
      updates.category = nextCategory;
    }
    if (selectedRoles.length) {
      updates.details = resolveRegistrationDetails(selectedRoles);
    }
    if (Object.keys(updates).length) {
      await Player.updateOne({ _id: player._id }, { $set: updates });
    }
  }

  const settingsCount = await Settings.countDocuments();
  if (settingsCount === 0) {
    await Settings.create({ backgroundImage: '', logo: '', teams: [] });
  } else {
    await Settings.updateMany({ teams: { $exists: false } }, { $set: { teams: [] } });
  }
}

const allowedClientOrigins = new Set(
  (process.env.CLIENT_URL || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedClientOrigins.has(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }
    return callback(new Error('Origin is not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  const assetOrigin = `${req.protocol}://${req.get('host')}`;
  const resolveUploadPaths = (value) => {
    if (typeof value === 'string' && value.startsWith('/uploads/')) return `${assetOrigin}${value}`;
    if (Array.isArray(value)) return value.map(resolveUploadPaths);
    if (value && typeof value.toJSON === 'function') return resolveUploadPaths(value.toJSON());
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveUploadPaths(item)]));
    }
    return value;
  };
  res.json = (body) => sendJson(resolveUploadPaths(body));
  next();
});

app.get('/uploads/:filename', async (req, res, next) => {
  try {
    const fileName = path.basename(req.params.filename);
    const absolutePath = path.join(uploadDir, fileName);
    if (fs.existsSync(absolutePath)) return res.sendFile(absolutePath);
    const bucket = getUploadsBucket();
    const storedFile = await bucket.find({ filename: fileName }).limit(1).next();
    if (!storedFile) return res.status(404).json({ message: 'File not found' });
    res.setHeader('Content-Type', storedFile.contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    bucket.openDownloadStream(storedFile._id).on('error', next).pipe(res);
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  const changesBackendData = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
    && req.path !== '/api/auction/select';

  if (changesBackendData) {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        dataVersion = Math.max(Date.now(), dataVersion + 1);
      }
    });
  }
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/data-version', (_req, res) => res.json({ version: dataVersion }));

app.get('/api/categories', async (_req, res) => {
  const players = await Player.find({
    sold: { $ne: true },
    unsold: { $ne: true }
  }).sort({ category: 1, auctionNumber: 1 }).lean();
  const visiblePlayers = players.filter((player) => player.source !== 'registration' || player.registrationStatus === 'approved');
  const categoryMap = {
    allrounder: [],
    batsmen: [],
    bowler: [],
    wicketkeeper: [],
    mvp: []
  };

  visiblePlayers.forEach((player) => {
    if (categoryMap[player.category]) {
      categoryMap[player.category].push(player);
    }
  });

  const categoryNames = { allrounder: 'All Rounder', batsmen: 'Batsmen', bowler: 'Bowler', wicketkeeper: 'Wicket Keeper', mvp: 'MVP Players' };
  const categories = Object.entries(categoryMap).map(([key, entries]) => ({
    key,
    label: categoryNames[key],
    count: entries.length,
    players: entries
  }));

  res.json({ categories });
});

async function teamsWithStats() {
  const teams = await Team.find().sort({ name: 1 }).lean();
  return Promise.all(teams.map(async (team) => {
    const soldPlayers = await Player.find({ teamId: team._id, sold: true }).lean();
    return {
      ...team,
      playerCount: soldPlayers.length,
      spent: soldPlayers.reduce((total, player) => total + Number(player.amount || 0), 0),
      players: soldPlayers
    };
  }));
}

app.get('/api/teams', async (_req, res) => {
  res.json({ teams: await teamsWithStats() });
});

app.post('/api/teams', durableUpload(upload.single('teamLogo')), async (req, res) => {
  const name = req.body.name?.trim();
  const purse = Number(req.body.purse || 0);
  if (!name) return res.status(400).json({ message: 'Team name is required' });
  const team = await Team.create({
    name,
    purse,
    remainingPurse: purse,
    logo: req.file ? `/uploads/${req.file.filename}` : req.body.logoUrl?.trim() || ''
  });
  res.status(201).json({ message: 'Team created successfully', team });
});

app.put('/api/teams/:id', durableUpload(upload.single('teamLogo')), async (req, res) => {
  const team = await Team.findById(req.params.id);
  if (!team) return res.status(404).json({ message: 'Team not found' });
  const soldPlayers = await Player.find({ teamId: team._id, sold: true }).lean();
  const spent = soldPlayers.reduce((total, player) => total + Number(player.amount || 0), 0);
  const purse = Number(req.body.purse || 0);
  if (purse < spent) return res.status(400).json({ message: `Purse cannot be below already spent amount ₹${spent}` });
  team.name = req.body.name?.trim() || team.name;
  team.purse = purse;
  team.remainingPurse = purse - spent;
  if (req.file) team.logo = `/uploads/${req.file.filename}`;
  else if (req.body.logoUrl !== undefined) team.logo = req.body.logoUrl.trim();
  await team.save();
  await Player.updateMany({ teamId: team._id }, { team: team.name });
  res.json({ message: 'Team updated successfully', team });
});

app.delete('/api/teams/:id', async (req, res) => {
  const team = await Team.findById(req.params.id);
  if (!team) return res.status(404).json({ message: 'Team not found' });
  await deleteUploadFile(team.logo);
  await Team.deleteOne({ _id: team._id });
  await Player.updateMany({ teamId: team._id }, { $set: { teamId: null } });
  res.json({ message: 'Team deleted successfully' });
});

app.get('/api/purse-stats', async (_req, res) => {
  res.json({ teams: await teamsWithStats() });
});

app.get('/api/testimonials', async (_req, res) => {
  const testimonials = await Testimonial.find().sort({ highlighted: -1, createdAt: -1 }).lean();
  res.json({ testimonials });
});

app.post('/api/testimonials', durableUpload(upload.fields([{ name: 'eventImages', maxCount: 10 }, { name: 'winnerImage', maxCount: 1 }])), async (req, res) => {
  if (!req.body.title?.trim()) return res.status(400).json({ message: 'Event title is required' });
  const testimonial = await Testimonial.create({
    title: req.body.title.trim(),
    description: req.body.description?.trim() || '',
    eventDate: req.body.eventDate || '',
    images: (req.files?.eventImages || []).map((file) => `/uploads/${file.filename}`),
    winnerName: req.body.winnerName?.trim() || '',
    winnerImage: req.files?.winnerImage?.[0] ? `/uploads/${req.files.winnerImage[0].filename}` : '',
    highlighted: req.body.highlighted === 'on'
  });
  res.status(201).json({ message: 'Previous event saved successfully', testimonial });
});

app.delete('/api/testimonials/:id', async (req, res) => {
  const testimonial = await Testimonial.findById(req.params.id);
  if (!testimonial) return res.status(404).json({ message: 'Previous event not found' });
  await Promise.all((testimonial.images || []).map((image) => deleteUploadFile(image)));
  await deleteUploadFile(testimonial.winnerImage);
  await Testimonial.deleteOne({ _id: testimonial._id });
  res.json({ message: 'Previous event deleted successfully' });
});

app.get('/api/players/selected', async (_req, res) => {
  const players = await Player.find({ sold: true }).sort({ updatedAt: -1 }).lean();

  res.json({ players });
});

app.get('/api/players/unsold', async (_req, res) => {
  const players = await Player.find({ unsold: true, sold: { $ne: true } }).sort({ updatedAt: -1 }).lean();
  res.json({ players });
});

app.get('/api/players', async (_req, res) => {
  const players = await Player.find().sort({ updatedAt: -1 }).lean();
  res.json({ players });
});

function resolveRegistrationCategory(selectedRoles = [], fallbackCategory = 'allrounder') {
  const roles = parseRoleSelections(selectedRoles);
  const normalizedRoles = roles.map((role) => String(role).trim().toLowerCase());
  const isWicketKeeper = normalizedRoles.some((role) => /\bwicket[\s-]*keepers?\b/.test(role));
  const isAllRounder = normalizedRoles.some((role) => role === 'all rounder' || role === 'allrounder');
  const hasBatsman = normalizedRoles.some((role) => /\b(?:batsman|batsmen|batman|batmen)\b/.test(role));
  const hasBowler = normalizedRoles.some((role) => /\bbowlers?\b/.test(role));

  if (isWicketKeeper) {
    return 'wicketkeeper';
  }
  if (isAllRounder || (hasBatsman && hasBowler)) {
    return 'allrounder';
  }
  if (hasBatsman) {
    return 'batsmen';
  }
  if (hasBowler) {
    return 'bowler';
  }
  return normalizeCategory(fallbackCategory);
}

function resolveRegistrationDetails(selectedRoles = [], fallbackDetails = '') {
  const roleLabels = parseRoleSelections(selectedRoles).map((role) => String(role).trim()).filter(Boolean);
  const detailsParts = [];
  if (roleLabels.length) {
    detailsParts.push(`Roles: ${roleLabels.join(', ')}`);
  }
  if (fallbackDetails?.trim()) {
    detailsParts.push(fallbackDetails.trim());
  }
  return detailsParts.join(' | ');
}

app.post('/api/players', durableUpload(upload.single('image')), async (req, res) => {
  const { name, details, category, playedIn, team, amount, phone, imageUrl } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ message: 'Player name is required' });
  }

  const normalizedCategory = normalizeCategory(category);
  const highestNumberPlayer = await Player.findOne({ category: normalizedCategory }).sort({ auctionNumber: -1 }).select('auctionNumber').lean();
  const player = await Player.create({
    name: name.trim(),
    image: req.file ? `/uploads/${req.file.filename}` : imageUrl?.trim() || '',
    details: details?.trim() || '',
    category: normalizedCategory,
    auctionNumber: Number(highestNumberPlayer?.auctionNumber || 0) + 1,
    playedIn: playedIn?.trim() || team?.trim() || '',
    team: '',
    amount: Number(amount || 0),
    phone: phone?.trim() || '',
    sold: false,
    unsold: false,
    source: 'manual'
  });

  res.status(201).json({ message: 'Player added successfully', player });
});

app.get('/api/players/registrations/pending', async (_req, res) => {
  const registrations = await Player.find({
    source: 'registration',
    $or: [{ registrationStatus: { $exists: false } }, { registrationStatus: 'pending' }]
  }).sort({ createdAt: 1 }).lean();

  res.json({ registrations });
});

app.patch('/api/players/:id/approve', async (req, res) => {
  const player = await Player.findById(req.params.id);
  if (!player) return res.status(404).json({ message: 'Registration not found' });

  if (player.registrationStatus === 'approved') {
    return res.json({ message: 'Player already approved', player });
  }

  player.registrationStatus = 'approved';
  player.approvedAt = new Date();
  await player.save();

  const messageResult = await sendApprovalMessage(player.phone, player.name);

  res.json({
    message: 'Player approved and now visible in the auction.',
    player,
    messageResult
  });
});

app.post('/api/players/register', durableUpload(upload.fields([{ name: 'image', maxCount: 1 }, { name: 'paymentReceipt', maxCount: 1 }])), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const playedIn = String(req.body.playedIn || req.body.previouslyPlayedIn || '').trim();
    const selectedRoles = parseRoleSelections(req.body.roles);
    const imageFile = req.files?.image?.[0];
    const paymentFile = req.files?.paymentReceipt?.[0];

    if (!name) {
      return res.status(400).json({ message: 'Player name is required' });
    }
    if (!phone) {
      return res.status(400).json({ message: 'Phone number is required' });
    }
    if (!playedIn) {
      return res.status(400).json({ message: 'Previously played information is required' });
    }
    if (!selectedRoles.length) {
      return res.status(400).json({ message: 'Please select at least one role for the player' });
    }
    if (!imageFile) {
      return res.status(400).json({ message: 'Player photo is required' });
    }
    if (!paymentFile) {
      return res.status(400).json({ message: 'Payment receipt is required' });
    }

    const normalizedCategory = resolveRegistrationCategory(selectedRoles, req.body.category || 'allrounder');
    const highestNumberPlayer = await Player.findOne({ category: normalizedCategory }).sort({ auctionNumber: -1 }).select('auctionNumber').lean();
    const player = await Player.create({
      name,
      image: imageFile ? `/uploads/${imageFile.filename}` : '',
      details: resolveRegistrationDetails(selectedRoles),
      category: normalizedCategory,
      auctionNumber: Number(highestNumberPlayer?.auctionNumber || 0) + 1,
      playedIn: playedIn || '',
      team: '',
      amount: 0,
      phone,
      sold: false,
      unsold: false,
      source: 'registration',
      registrationRoles: selectedRoles,
      battingStyle: selectedRoles.includes('Right Hand Batsman') || selectedRoles.includes('Right Hand Batsmen') || selectedRoles.includes('right hand batsman') || selectedRoles.includes('right hand batsmen') ? 'Right Hand Batsman' : '',
      bowlingStyle: selectedRoles.includes('Pace Bowler') || selectedRoles.includes('pace bowler') || selectedRoles.includes('Fast Bowler') ? 'Pace Bowler' : selectedRoles.includes('Spin Bowler') || selectedRoles.includes('spin bowler') ? 'Spin Bowler' : '',
      paymentReceipt: paymentFile ? `/uploads/${paymentFile.filename}` : '',
      previouslyPlayedIn: playedIn || '',
      registrationStatus: 'pending'
    });

    res.status(201).json({ message: 'Player registered successfully', player });
  } catch (error) {
    console.error('Registration failed', error);
    res.status(500).json({ message: 'Entry not done. Backend error. Please try again.' });
  }
});

app.put('/api/players/:id', durableUpload(upload.single('image')), async (req, res) => {
  const { name, details, category, playedIn, team, amount, phone, image, imageUrl } = req.body;
  if (!name?.trim()) {
    return res.status(400).json({ message: 'Player name is required' });
  }

  const existingPlayer = await Player.findById(req.params.id);
  if (!existingPlayer) return res.status(404).json({ message: 'Player not found' });
  const normalizedCategory = normalizeCategory(category);
  let auctionNumber = existingPlayer.auctionNumber;
  if (normalizedCategory !== existingPlayer.category) {
    const highestNumberPlayer = await Player.findOne({ category: normalizedCategory }).sort({ auctionNumber: -1 }).select('auctionNumber').lean();
    auctionNumber = Number(highestNumberPlayer?.auctionNumber || 0) + 1;
  }
  const nextAmount = Number(amount || 0);
  if (existingPlayer.sold && existingPlayer.teamId && nextAmount !== Number(existingPlayer.amount || 0)) {
    const purseDifference = nextAmount - Number(existingPlayer.amount || 0);
    const updatedTeam = await Team.findOneAndUpdate(
      { _id: existingPlayer.teamId, remainingPurse: { $gte: Math.max(0, purseDifference) } },
      { $inc: { remainingPurse: -purseDifference } },
      { new: true }
    );
    if (!updatedTeam) return res.status(400).json({ message: 'Team does not have enough purse for the updated bid amount' });
  }

  const player = await Player.findByIdAndUpdate(req.params.id, {
    name: name.trim(),
    details: details?.trim() || '',
    category: normalizedCategory,
    auctionNumber,
    playedIn: playedIn?.trim() || (!existingPlayer.sold ? team?.trim() : '') || existingPlayer.playedIn || '',
    team: existingPlayer.sold ? existingPlayer.team : '',
    amount: nextAmount,
    phone: phone?.trim() || existingPlayer.phone || '',
    image: req.file ? `/uploads/${req.file.filename}` : imageUrl?.trim() || image?.trim() || existingPlayer.image || ''
  }, { new: true, runValidators: true });

  res.json({ message: 'Player updated successfully', player });
});

app.patch('/api/players/:id/status', async (req, res) => {
  const statusUpdates = {
    sold: { sold: true, unsold: false },
    unsold: { sold: false, unsold: true },
    available: { sold: false, unsold: false }
  };
  const updates = statusUpdates[req.body.status];
  if (!updates) return res.status(400).json({ message: 'Invalid player status' });

  const existingPlayer = await Player.findById(req.params.id);
  if (!existingPlayer) return res.status(404).json({ message: 'Player not found' });
  if (existingPlayer.sold && req.body.status !== 'sold' && existingPlayer.teamId) {
    await Team.findByIdAndUpdate(existingPlayer.teamId, { $inc: { remainingPurse: Number(existingPlayer.amount || 0) } });
  }
  if (req.body.status !== 'sold') {
    updates.teamId = null;
    updates.team = '';
  }
  const player = await Player.findByIdAndUpdate(req.params.id, updates, { new: true });
  if (!player) return res.status(404).json({ message: 'Player not found' });
  res.json({ message: `Player marked as ${req.body.status}`, player });
});

app.delete('/api/players/:id', async (req, res) => {
  const player = await Player.findById(req.params.id);
  if (!player) return res.status(404).json({ message: 'Player not found' });
  if (player.sold && player.teamId) {
    await Team.findByIdAndUpdate(player.teamId, { $inc: { remainingPurse: Number(player.amount || 0) } });
  }
  await Promise.all([deleteUploadFile(player.image), deleteUploadFile(player.paymentReceipt)]);
  await player.deleteOne();
  res.json({ message: 'Player deleted successfully' });
});

app.post('/api/excel/import', durableUpload(upload.single('excelFile')), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Excel file is required' });
  }

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const columns = {
      name: req.body.nameColumn || 'name',
      category: req.body.categoryColumn || 'category',
      details: req.body.detailsColumn || 'details',
      team: req.body.teamColumn || 'team',
      amount: req.body.amountColumn || 'amount',
      image: req.body.imageColumn || 'image',
      phone: req.body.phoneColumn || 'phone'
    };

    const normalizedRows = rows.map((row, index) => ({
      name: row[columns.name] || row.name || row.playerName || `Player ${index + 1}`,
      image: row[columns.image] || row.image || row.imageUrl || '',
      details: row[columns.details] || row.details || row.description || row.role || 'Imported player',
      category: normalizeCategory(row[columns.category] || row.category || row.type || 'allrounder'),
      playedIn: row[columns.team] || row.team || '',
      team: '',
      amount: Number(row[columns.amount] || row.amount || 0),
      phone: String(row[columns.phone] || row.phone || row.phoneNumber || '').trim(),
      sold: false,
      unsold: false,
      source: 'excel'
    }));

    const categoryCounters = {};
    normalizedRows.forEach((player) => {
      categoryCounters[player.category] = (categoryCounters[player.category] || 0) + 1;
      player.auctionNumber = categoryCounters[player.category];
    });

    const deletedPlayers = await Player.find().select('image paymentReceipt').lean();
    await Player.deleteMany({});
    await Player.insertMany(normalizedRows);
    await Promise.all(deletedPlayers.flatMap((player) => [
      deleteUploadFile(player.image),
      deleteUploadFile(player.paymentReceipt)
    ]));

    res.json({ message: 'Excel import complete', count: normalizedRows.length });
  } finally {
    await deleteUploadFile(`/uploads/${req.file.filename}`);
  }
});

app.get('/api/excel/template', (req, res) => {
  const columns = {
    [req.query.nameColumn || 'name']: 'Sample Player',
    [req.query.categoryColumn || 'category']: 'allrounder',
    [req.query.detailsColumn || 'details']: 'Player role and details',
    [req.query.teamColumn || 'team']: 'Team A',
    [req.query.amountColumn || 'amount']: 1000,
    [req.query.imageColumn || 'image']: 'https://example.com/player.jpg',
    [req.query.phoneColumn || 'phone']: '9999999999'
  };
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([columns]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Players');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="player-import-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

app.post('/api/auction/select', async (req, res) => {
  const { category } = req.body;
  const normalizedCategory = normalizeCategory(category || 'allrounder');
  const availablePlayers = await Player.find({
    category: normalizedCategory,
    sold: { $ne: true },
    unsold: { $ne: true }
  }).lean();

  if (!availablePlayers.length) {
    return res.status(404).json({ message: 'No players available in this category' });
  }

  const randomPlayer = availablePlayers[Math.floor(Math.random() * availablePlayers.length)];
  res.json({ player: randomPlayer, category: normalizedCategory });
});

app.post('/api/auction/bid', async (req, res) => {
  const { category, playerId, amount, teamId, status } = req.body;
  const normalizedCategory = normalizeCategory(category || 'allrounder');
  const player = await Player.findById(playerId);

  if (!player) {
    return res.status(404).json({ message: 'Player not found' });
  }

  const bidAmount = Number(amount || 0);
  let selectedTeam = null;
  if (status === 'sold') {
    const auctionSettings = await Settings.findOne().lean();
    if (auctionSettings?.playerLimitEnabled && Number(auctionSettings.maxPlayersPerTeam) > 0) {
      const purchasedPlayerCount = await Player.countDocuments({ teamId, sold: true });
      if (purchasedPlayerCount >= Number(auctionSettings.maxPlayersPerTeam)) {
        return res.status(400).json({ message: `This team already has the maximum ${auctionSettings.maxPlayersPerTeam} players. Its bidding is closed.` });
      }
    }
    selectedTeam = await Team.findOneAndUpdate(
      { _id: teamId, remainingPurse: { $gte: bidAmount } },
      { $inc: { remainingPurse: -bidAmount } },
      { new: true }
    );
    if (!selectedTeam) {
      return res.status(400).json({ message: 'Select a valid team with enough remaining purse' });
    }
  }

  player.amount = bidAmount;
  player.team = selectedTeam?.name || '';
  player.teamId = selectedTeam?._id || null;
  player.sold = status === 'sold';
  player.unsold = status === 'unsold';
  player.category = normalizedCategory;
  await player.save();

  if (status === 'sold') {
    await Player.findByIdAndUpdate(playerId, { sold: true, unsold: false });
  }

  res.json({ message: 'Bid saved', category: normalizedCategory, player });
});

app.get('/api/settings', async (_req, res) => {
  const settings = await Settings.findOne().lean();
  res.json(settings || { backgroundImage: '', logo: '' });
});

app.post('/api/settings/welcome-video', durableUpload(upload.single('welcomeVideo')), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Choose a video file to upload' });
  const welcomeVideo = `/uploads/${req.file.filename}`;
  const settings = await Settings.findOneAndUpdate(
    {},
    { $set: { welcomeVideo } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ message: 'Welcome video saved successfully', welcomeVideo, settings });
});

app.post('/api/settings', durableUpload(upload.any()), async (req, res) => {
  const current = await Settings.findOne();
  const uploadedFiles = req.files || [];
  const backgroundFile = uploadedFiles.find((file) => file.fieldname === 'backgroundImage');
  const logoFile = uploadedFiles.find((file) => file.fieldname === 'logo');
  const auctionStartAudioFile = uploadedFiles.find((file) => file.fieldname === 'auctionStartAudio');
  const playerSoldAudioFile = uploadedFiles.find((file) => file.fieldname === 'playerSoldAudio');
  const categoryImageFiles = {
    allrounder: uploadedFiles.find((file) => file.fieldname === 'categoryImage_allrounder'),
    batsmen: uploadedFiles.find((file) => file.fieldname === 'categoryImage_batsmen'),
    bowler: uploadedFiles.find((file) => file.fieldname === 'categoryImage_bowler'),
    wicketkeeper: uploadedFiles.find((file) => file.fieldname === 'categoryImage_wicketkeeper'),
    mvp: uploadedFiles.find((file) => file.fieldname === 'categoryImage_mvp')
  };
  const teamNames = Array.isArray(req.body.teamName) ? req.body.teamName : req.body.teamName ? [req.body.teamName] : [];
  const existingTeamLogos = Array.isArray(req.body.existingTeamLogo) ? req.body.existingTeamLogo : req.body.existingTeamLogo ? [req.body.existingTeamLogo] : [];
  const teams = teamNames
    .map((name, index) => {
      const teamLogoFile = uploadedFiles.find((file) => file.fieldname === `teamLogo_${index}`);
      return {
        name: String(name || '').trim(),
        logo: teamLogoFile ? `/uploads/${teamLogoFile.filename}` : existingTeamLogos[index] || ''
      };
    })
    .filter((team) => team.name);

  const nextSettings = {
    backgroundImage: backgroundFile ? `/uploads/${backgroundFile.filename}` : current?.backgroundImage || '',
    logo: logoFile ? `/uploads/${logoFile.filename}` : current?.logo || '',
    auctionStartAudio: auctionStartAudioFile ? `/uploads/${auctionStartAudioFile.filename}` : current?.auctionStartAudio || '',
    playerSoldAudio: playerSoldAudioFile ? `/uploads/${playerSoldAudioFile.filename}` : current?.playerSoldAudio || '',
    playerLimitEnabled: req.body.playerLimitEnabled === 'on' || req.body.playerLimitEnabled === 'true',
    maxPlayersPerTeam: Math.max(0, Number(req.body.maxPlayersPerTeam || 0)),
    auctionCardSelectionEnabled: req.body.auctionCardSelectionEnabled === 'on' || req.body.auctionCardSelectionEnabled === 'true',
    categoryImages: {
      allrounder: categoryImageFiles.allrounder ? `/uploads/${categoryImageFiles.allrounder.filename}` : current?.categoryImages?.allrounder || '',
      batsmen: categoryImageFiles.batsmen ? `/uploads/${categoryImageFiles.batsmen.filename}` : current?.categoryImages?.batsmen || '',
      bowler: categoryImageFiles.bowler ? `/uploads/${categoryImageFiles.bowler.filename}` : current?.categoryImages?.bowler || '',
      wicketkeeper: categoryImageFiles.wicketkeeper ? `/uploads/${categoryImageFiles.wicketkeeper.filename}` : current?.categoryImages?.wicketkeeper || '',
      mvp: categoryImageFiles.mvp ? `/uploads/${categoryImageFiles.mvp.filename}` : current?.categoryImages?.mvp || ''
    },
    teams
  };

  if (current) {
    await Settings.findByIdAndUpdate(current._id, nextSettings, { new: true });
  } else {
    await Settings.create(nextSettings);
  }

  res.json(nextSettings);
});

app.get('/api/export/excel', async (_req, res) => {
  const workbook = XLSX.utils.book_new();
  const players = await Player.find({ sold: true }).lean();
  const teams = await Team.find().sort({ name: 1 }).lean();

  teams.forEach((team, index) => {
    const sheetData = players
      .filter((player) => String(player.teamId || '') === String(team._id))
      .map((player) => ({
        Name: player.name,
        Category: player.category,
        Amount: player.amount,
        'Phone Number': player.phone || '',
        Team: player.team || team.name
      }));

    const sheet = XLSX.utils.json_to_sheet(sheetData);
    const safeTeamName = team.name.replace(/[\\/?*[\]:]/g, '-').slice(0, 27);
    XLSX.utils.book_append_sheet(workbook, sheet, `${safeTeamName || 'Team'}-${index + 1}`);
  });

  if (!teams.length) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([]), 'No Teams');
  }

  const fileName = 'auction-player-list.xlsx';
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

async function startServer() {
  try {
    await connectDatabase();
    await migrateLocalUploads();
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Auction server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  }
}

startServer();
