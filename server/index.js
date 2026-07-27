const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const uploadDir = path.join(__dirname, 'public', 'uploads');
let dataVersion = Date.now();
let auctionDataVersion = dataVersion;
const liveDataClients = new Set();
let xlsxModule;
let sharpModule;
fs.mkdirSync(uploadDir, { recursive: true });

const getXlsx = () => {
  if (!xlsxModule) xlsxModule = require('xlsx');
  return xlsxModule;
};

const getSharp = () => {
  if (!sharpModule) sharpModule = require('sharp');
  return sharpModule;
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeName = `${Date.now()}-${crypto.randomUUID()}-${file.originalname.replace(/\s+/g, '-')}`;
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 20
  }
});

const imageUploadProfiles = {
  backgroundImage: { maxDimension: 1920, quality: 82 },
  image: { maxDimension: 1000, quality: 82 },
  paymentReceipt: { maxDimension: 1600, quality: 82 },
  logo: { maxDimension: 900, quality: 86 },
  teamLogo: { maxDimension: 900, quality: 86 },
  winnerImage: { maxDimension: 1200, quality: 84 },
  eventImages: { maxDimension: 1600, quality: 82 }
};

function imageProfileFor(file) {
  if (file.fieldname?.startsWith('categoryImage_')) return { maxDimension: 1400, quality: 82 };
  if (file.fieldname?.startsWith('teamLogo_')) return imageUploadProfiles.teamLogo;
  return imageUploadProfiles[file.fieldname] || { maxDimension: 1600, quality: 82 };
}

async function optimizeImageUpload(file) {
  const optimizableTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff']);
  if (!file?.path || !optimizableTypes.has(file.mimetype)) return file;

  const { maxDimension, quality } = imageProfileFor(file);
  const parsedPath = path.parse(file.path);
  const optimizedFilename = `${path.parse(file.filename).name}.webp`;
  const optimizedPath = path.join(parsedPath.dir, optimizedFilename);
  const temporaryPath = path.join(parsedPath.dir, `${path.parse(file.filename).name}.optimizing.webp`);

  try {
    await getSharp()(file.path, { failOn: 'warning', limitInputPixels: 50_000_000 })
      .rotate()
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({
        quality,
        alphaQuality: 90,
        effort: 5,
        smartSubsample: true
      })
      .toFile(temporaryPath);

    await fs.promises.unlink(file.path);
    await fs.promises.rename(temporaryPath, optimizedPath);
    const optimizedStats = await fs.promises.stat(optimizedPath);
    file.filename = optimizedFilename;
    file.path = optimizedPath;
    file.mimetype = 'image/webp';
    file.size = optimizedStats.size;
    return file;
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    console.warn(`Image optimization skipped for ${file.originalname}:`, error.message);
    return file;
  }
}

async function optimizeRequestUploads(req) {
  const files = [
    ...(req.file ? [req.file] : []),
    ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat())
  ];
  await Promise.all(files.map(optimizeImageUpload));
  return files;
}

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
      const files = await optimizeRequestUploads(req);
      await persistRequestUploads(req);
      res.on('finish', () => {
        Promise.all(files.map((file) => fs.promises.unlink(file.path).catch(() => {}))).catch(() => {});
      });
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
  let normalizedPath = String(filePath).trim();
  if (/^https?:\/\//i.test(normalizedPath)) {
    try {
      normalizedPath = new URL(normalizedPath).pathname;
    } catch {
      return;
    }
  }
  if (!normalizedPath.startsWith('/uploads/')) return;
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

function uploadPathPattern(filePath) {
  if (!filePath) return null;
  let normalizedPath = String(filePath).trim();
  if (/^https?:\/\//i.test(normalizedPath)) {
    try {
      normalizedPath = new URL(normalizedPath).pathname;
    } catch {
      return null;
    }
  }
  if (!normalizedPath.startsWith('/uploads/')) return null;
  const escapedPath = normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escapedPath}$`);
}

async function deleteReplacedUpload(previousPath, nextPath) {
  const previousPattern = uploadPathPattern(previousPath);
  const nextPattern = uploadPathPattern(nextPath);
  if (!previousPattern || String(previousPattern) === String(nextPattern)) return;

  const referenceQuery = previousPattern;
  const [settingsReferences, teamReferences, playerReferences, testimonialReferences] = await Promise.all([
    Settings.countDocuments({
      $or: [
        { backgroundImage: referenceQuery }, { logo: referenceQuery },
        { auctionStartAudio: referenceQuery }, { playerSoldAudio: referenceQuery },
        { welcomeVideo: referenceQuery }, { 'categoryImages.allrounder': referenceQuery },
        { 'categoryImages.batsmen': referenceQuery }, { 'categoryImages.bowler': referenceQuery },
        { 'categoryImages.wicketkeeper': referenceQuery }, { 'categoryImages.mvp': referenceQuery }
      ]
    }),
    Team.countDocuments({ logo: referenceQuery }),
    Player.countDocuments({ $or: [{ image: referenceQuery }, { paymentReceipt: referenceQuery }] }),
    Testimonial.countDocuments({ $or: [{ images: referenceQuery }, { winnerImage: referenceQuery }] })
  ]);

  if (settingsReferences + teamReferences + playerReferences + testimonialReferences === 0) {
    await deleteUploadFile(previousPath);
  }
}

function collectUploadPaths(value, paths = new Set()) {
  if (typeof value === 'string') {
    if (uploadPathPattern(value)) paths.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectUploadPaths(item, paths));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectUploadPaths(item, paths));
  }
  return paths;
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
  team: { type: String, select: false },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
  amount: Number,
  age: Number,
  phone: String,
  tshirtSize: String,
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
  scorerPasswordHash: { type: String, default: '', select: false },
  categoryImages: {
    allrounder: { type: String, default: '' },
    batsmen: { type: String, default: '' },
    bowler: { type: String, default: '' },
    wicketkeeper: { type: String, default: '' }
    ,
    mvp: { type: String, default: '' }
  }
}, { timestamps: true });

playerSchema.index({ source: 1, registrationStatus: 1, createdAt: 1 });
playerSchema.index({ teamId: 1, sold: 1 });
playerSchema.index({ category: 1, sold: 1, unsold: 1, auctionNumber: 1 });

const Player = mongoose.model('Player', playerSchema);
const Settings = mongoose.model('Settings', settingsSchema);
const teamSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  logo: { type: String, default: '' },
  purse: { type: Number, default: 0, min: 0 },
  remainingPurse: { type: Number, default: 0, min: 0 }
}, { timestamps: true });
const Team = mongoose.model('Team', teamSchema);

async function playersWithCurrentTeamNames(players) {
  const plainPlayers = (players || []).map((player) => (
    typeof player?.toObject === 'function' ? player.toObject() : player
  ));
  const teamIds = [...new Set(plainPlayers.map((player) => String(player.teamId || '')).filter(Boolean))];
  if (!teamIds.length) return plainPlayers.map((player) => ({ ...player, team: '' }));
  const teams = await Team.find({ _id: { $in: teamIds } }).select('name').lean();
  const namesById = new Map(teams.map((team) => [String(team._id), team.name]));
  return plainPlayers.map((player) => ({
    ...player,
    team: namesById.get(String(player.teamId || '')) || ''
  }));
}

async function playerWithCurrentTeamName(player) {
  if (!player) return player;
  const [resolved] = await playersWithCurrentTeamNames([player]);
  return resolved;
}

async function teamIsUsedInMatchHistory(teamId) {
  const CricketMatch = mongoose.models.CricketMatch;
  if (!CricketMatch) return false;
  return Boolean(await CricketMatch.exists({
    $or: [
      { teamAId: teamId },
      { teamBId: teamId },
      { 'teamA.teamId': teamId },
      { 'teamB.teamId': teamId },
      { 'innings.battingTeamId': teamId },
      { 'innings.bowlingTeamId': teamId }
    ]
  }));
}

async function playerIsUsedInMatchHistory(playerId) {
  const CricketMatch = mongoose.models.CricketMatch;
  if (!CricketMatch) return false;
  return Boolean(await CricketMatch.exists({
    $or: [
      { 'teamA.players.playerId': playerId },
      { 'teamB.players.playerId': playerId },
      { teamAPlayerIds: playerId },
      { teamBPlayerIds: playerId },
      { 'innings.lineupEvents.strikerId': playerId },
      { 'innings.lineupEvents.nonStrikerId': playerId },
      { 'innings.lineupEvents.bowlerId': playerId },
      { 'innings.deliveries.strikerId': playerId },
      { 'innings.deliveries.nonStrikerId': playerId },
      { 'innings.deliveries.bowlerId': playerId },
      { 'innings.deliveries.wicket.dismissedBatterId': playerId },
      { 'awards.manOfMatch.playerId': playerId },
      { 'awards.bestBowler.playerId': playerId },
      { manOfMatchPlayerId: playerId },
      { bestBowlerPlayerId: playerId }
    ]
  }));
}
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

async function initializePlayerData() {
  await Player.updateMany(
    {
      sold: { $ne: true },
      team: { $nin: ['', null] },
      $or: [{ playedIn: { $exists: false } }, { playedIn: '' }, { playedIn: null }]
    },
    [{ $set: { playedIn: '$team', team: '' } }]
  );

  await Promise.all(
    ['allrounder', 'batsmen', 'bowler', 'wicketkeeper', 'mvp'].map(async (category) => {
      const [numberedPlayers, unnumberedPlayers] = await Promise.all([
        Player.find({ category, auctionNumber: { $ne: null } }).select('auctionNumber').lean(),
        Player.find({
          category,
          $or: [{ auctionNumber: { $exists: false } }, { auctionNumber: null }]
        }).sort({ createdAt: 1 }).select('_id').lean()
      ]);
      const usedNumbers = new Set(numberedPlayers.map((player) => player.auctionNumber));
      let nextNumber = 1;
      const updates = unnumberedPlayers.map((player) => {
        while (usedNumbers.has(nextNumber)) nextNumber += 1;
        const auctionNumber = nextNumber;
        usedNumbers.add(auctionNumber);
        nextNumber += 1;
        return {
          updateOne: {
            filter: { _id: player._id },
            update: { $set: { auctionNumber } }
          }
        };
      });

      if (updates.length) {
        await Player.bulkWrite(updates, { ordered: false });
      }
    })
  );

  const registrationPlayers = await Player.find({ source: 'registration' }).lean();
  const registrationUpdates = registrationPlayers.flatMap((player) => {
    const selectedRoles = parseRoleSelections(player.registrationRoles || []);
    const nextCategory = resolveRegistrationCategory(selectedRoles, player.category || 'allrounder');
    const updates = {};
    if (nextCategory !== player.category) {
      updates.category = nextCategory;
    }
    if (selectedRoles.length) {
      const nextDetails = resolveRegistrationDetails(selectedRoles);
      if (nextDetails !== player.details) updates.details = nextDetails;
    }
    return Object.keys(updates).length
      ? [{ updateOne: { filter: { _id: player._id }, update: { $set: updates } } }]
      : [];
  });

  if (registrationUpdates.length) {
    await Player.bulkWrite(registrationUpdates, { ordered: false });
  }
}

async function initializeSettingsData() {
  const settingsCount = await Settings.countDocuments();
  if (settingsCount === 0) {
    await Settings.create({ backgroundImage: '', logo: '' });
  }
}

async function initializeDatabase() {
  await Promise.all([initializePlayerData(), initializeSettingsData()]);
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
  },
  maxAge: 86400
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
    && req.path !== '/api/auction/select'
    && req.path !== '/api/scorer/session';
  const changesScoringData = req.path === '/api/matches'
    || req.path.startsWith('/api/matches/');

  if (changesBackendData) {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        dataVersion = Math.max(Date.now(), dataVersion + 1);
        if (!changesScoringData) auctionDataVersion = dataVersion;
        const message = `event: version\ndata: ${JSON.stringify({
          version: dataVersion,
          auctionVersion: auctionDataVersion,
          path: req.path,
          method: req.method,
          sourceId: String(req.get('x-live-source') || '').slice(0, 100)
        })}\n\n`;
        liveDataClients.forEach((client) => {
          if (client.destroyed || client.writableEnded) {
            liveDataClients.delete(client);
          } else {
            client.write(message);
          }
        });
      }
    });
  }
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/data-version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: dataVersion, auctionVersion: auctionDataVersion });
});

app.get('/api/live-events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  liveDataClients.add(res);
  res.write(`retry: 2000\nevent: version\ndata: ${JSON.stringify({
    version: dataVersion,
    auctionVersion: auctionDataVersion
  })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    liveDataClients.delete(res);
  });
});

require('./scoring').registerScoringRoutes(app, { mongoose, Team, Player, Settings });

const categoryNames = {
  allrounder: 'All Rounder',
  batsmen: 'Batsmen',
  bowler: 'Bowler',
  wicketkeeper: 'Wicket Keeper',
  mvp: 'MVP Players'
};

function buildCategories(players) {
  const categoryMap = {
    allrounder: [],
    batsmen: [],
    bowler: [],
    wicketkeeper: [],
    mvp: []
  };

  players.forEach((player) => {
    if (categoryMap[player.category]) {
      categoryMap[player.category].push(player);
    }
  });

  return Object.entries(categoryMap).map(([key, entries]) => ({
    key,
    label: categoryNames[key],
    count: entries.length,
    players: entries
  }));
}

async function loadCategories() {
  const players = await Player.find({
    sold: { $ne: true },
    unsold: { $ne: true },
    $or: [
      { source: { $ne: 'registration' } },
      { registrationStatus: 'approved' }
    ]
  }).sort({ category: 1, auctionNumber: 1 }).lean();

  return buildCategories(players);
}

async function loadPendingRegistrations() {
  return Player.find({
    source: 'registration',
    $or: [{ registrationStatus: { $exists: false } }, { registrationStatus: 'pending' }]
  }).sort({ createdAt: 1 }).lean();
}

app.get('/api/categories', async (_req, res) => {
  res.json({ categories: await loadCategories() });
});

async function teamsWithStats() {
  const [teams, soldPlayers] = await Promise.all([
    Team.find().sort({ name: 1 }).lean(),
    Player.find({ teamId: { $ne: null }, sold: true }).lean()
  ]);
  const playersByTeam = new Map();

  soldPlayers.forEach((player) => {
    const teamKey = String(player.teamId);
    const teamPlayers = playersByTeam.get(teamKey) || [];
    teamPlayers.push(player);
    playersByTeam.set(teamKey, teamPlayers);
  });

  return teams.map((team) => {
    const teamPlayers = playersByTeam.get(String(team._id)) || [];
    return {
      ...team,
      playerCount: teamPlayers.length,
      spent: teamPlayers.reduce((total, player) => total + Number(player.amount || 0), 0),
      players: teamPlayers.map((player) => ({ ...player, team: team.name }))
    };
  });
}

app.get('/api/teams', async (_req, res) => {
  res.json({ teams: await teamsWithStats() });
});

app.get('/api/bootstrap', async (_req, res) => {
  const version = dataVersion;
  const auctionVersion = auctionDataVersion;
  const [categories, settings, teams, pendingRegistrations] = await Promise.all([
    loadCategories(),
    Settings.findOne().lean(),
    teamsWithStats(),
    loadPendingRegistrations()
  ]);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    version,
    auctionVersion,
    categories,
    settings: settings || { backgroundImage: '', logo: '' },
    teams,
    pendingRegistrations
  });
});

app.get('/api/public/registration-summary', async (_req, res) => {
  const [settings, registrationCount] = await Promise.all([
    Settings.findOne().select('logo backgroundImage').lean(),
    Player.countDocuments({ source: 'registration' })
  ]);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    logo: settings?.logo || '',
    backgroundImage: settings?.backgroundImage || '',
    registrationCount
  });
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
  const previousLogo = team.logo;
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
  await Player.updateMany({ teamId: team._id }, { $unset: { team: '' } });
  await deleteReplacedUpload(previousLogo, team.logo);
  res.json({ message: 'Team updated successfully', team });
});

app.delete('/api/teams/:id', async (req, res) => {
  const team = await Team.findById(req.params.id);
  if (!team) return res.status(404).json({ message: 'Team not found' });
  if (await teamIsUsedInMatchHistory(team._id)) {
    return res.status(409).json({
      message: 'This team is used in match history and cannot be deleted'
    });
  }
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

  res.json({ players: await playersWithCurrentTeamNames(players) });
});

app.get('/api/players/unsold', async (_req, res) => {
  const players = await Player.find({ unsold: true, sold: { $ne: true } }).sort({ updatedAt: -1 }).lean();
  res.json({ players });
});

app.get('/api/players', async (_req, res) => {
  const players = await Player.find().sort({ updatedAt: -1 }).lean();
  res.json({ players: await playersWithCurrentTeamNames(players) });
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
  const { name, age, details, category, playedIn, team, amount, phone, imageUrl } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ message: 'Player name is required' });
  }

  const normalizedCategory = normalizeCategory(category);
  const highestNumberPlayer = await Player.findOne({ category: normalizedCategory }).sort({ auctionNumber: -1 }).select('auctionNumber').lean();
  const player = await Player.create({
    name: name.trim(),
    age: age ? Number(age) : undefined,
    image: req.file ? `/uploads/${req.file.filename}` : imageUrl?.trim() || '',
    details: details?.trim() || '',
    category: normalizedCategory,
    auctionNumber: Number(highestNumberPlayer?.auctionNumber || 0) + 1,
    playedIn: playedIn?.trim() || team?.trim() || '',
    amount: Number(amount || 0),
    phone: phone?.trim() || '',
    sold: false,
    unsold: false,
    source: 'manual'
  });

  res.status(201).json({ message: 'Player added successfully', player });
});

app.get('/api/players/registrations/pending', async (_req, res) => {
  res.json({ registrations: await loadPendingRegistrations() });
});

app.get('/api/players/registrations', async (_req, res) => {
  const registrations = await Player.find({ source: 'registration' })
    .sort({ createdAt: -1 })
    .lean();

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
    const age = Number(req.body.age);
    const phone = String(req.body.phone || '').trim();
    const playedIn = String(req.body.playedIn || req.body.previouslyPlayedIn || '').trim();
    const tshirtSize = String(req.body.tshirtSize || '').trim();
    const selectedRoles = parseRoleSelections(req.body.roles);
    const imageFile = req.files?.image?.[0];
    const paymentFile = req.files?.paymentReceipt?.[0];

    if (!name) {
      return res.status(400).json({ message: 'Player name is required' });
    }
    if (!Number.isInteger(age) || age < 1) {
      return res.status(400).json({ message: 'Please enter a valid age' });
    }
    if (!phone) {
      return res.status(400).json({ message: 'Phone number is required' });
    }
    if (!playedIn) {
      return res.status(400).json({ message: 'Previously played information is required' });
    }
    if (!/^\d+$/.test(tshirtSize) || Number(tshirtSize) < 1) {
      return res.status(400).json({ message: 'Please enter a valid numeric T-shirt size' });
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
      age,
      image: imageFile ? `/uploads/${imageFile.filename}` : '',
      details: resolveRegistrationDetails(selectedRoles),
      category: normalizedCategory,
      auctionNumber: Number(highestNumberPlayer?.auctionNumber || 0) + 1,
      playedIn: playedIn || '',
      amount: 0,
      phone,
      tshirtSize,
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
  const { name, age, details, category, playedIn, team, amount, phone, image, imageUrl } = req.body;
  if (!name?.trim()) {
    return res.status(400).json({ message: 'Player name is required' });
  }

  const existingPlayer = await Player.findById(req.params.id);
  if (!existingPlayer) return res.status(404).json({ message: 'Player not found' });
  const previousImage = existingPlayer.image;
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

  const player = await Player.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        name: name.trim(),
        age: age ? Number(age) : existingPlayer.age,
        details: details?.trim() || '',
        category: normalizedCategory,
        auctionNumber,
        playedIn: playedIn?.trim() || (!existingPlayer.sold ? team?.trim() : '') || existingPlayer.playedIn || '',
        amount: nextAmount,
        phone: phone?.trim() || existingPlayer.phone || '',
        image: req.file ? `/uploads/${req.file.filename}` : imageUrl?.trim() || image?.trim() || existingPlayer.image || ''
      },
      $unset: { team: '' }
    },
    { new: true, runValidators: true }
  );

  await deleteReplacedUpload(previousImage, player.image);
  res.json({
    message: 'Player updated successfully',
    player: await playerWithCurrentTeamName(player)
  });
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
  }
  const player = await Player.findByIdAndUpdate(
    req.params.id,
    { $set: updates, $unset: { team: '' } },
    { new: true }
  );
  if (!player) return res.status(404).json({ message: 'Player not found' });
  res.json({
    message: `Player marked as ${req.body.status}`,
    player: await playerWithCurrentTeamName(player)
  });
});

app.delete('/api/players/:id', async (req, res) => {
  const player = await Player.findById(req.params.id);
  if (!player) return res.status(404).json({ message: 'Player not found' });
  if (await playerIsUsedInMatchHistory(player._id)) {
    return res.status(409).json({
      message: 'This player is used in match history and cannot be deleted'
    });
  }
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
    const XLSX = getXlsx();
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
  const XLSX = getXlsx();
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
  player.team = undefined;
  player.teamId = selectedTeam?._id || null;
  player.sold = status === 'sold';
  player.unsold = status === 'unsold';
  player.category = normalizedCategory;
  await player.save();
  await Player.updateOne({ _id: player._id }, { $unset: { team: '' } });

  if (status === 'sold') {
    await Player.findByIdAndUpdate(playerId, { sold: true, unsold: false });
  }

  res.json({
    message: 'Bid saved',
    category: normalizedCategory,
    player: {
      ...player.toObject(),
      team: selectedTeam?.name || ''
    }
  });
});

app.get('/api/settings', async (_req, res) => {
  const settings = await Settings.findOne().lean();
  res.json(settings || { backgroundImage: '', logo: '' });
});

app.post('/api/settings/welcome-video', durableUpload(upload.single('welcomeVideo')), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Choose a video file to upload' });
  const welcomeVideo = `/uploads/${req.file.filename}`;
  const current = await Settings.findOne().lean();
  const settings = await Settings.findOneAndUpdate(
    {},
    { $set: { welcomeVideo } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  await deleteReplacedUpload(current?.welcomeVideo, welcomeVideo);
  res.json({ message: 'Welcome video saved successfully', welcomeVideo, settings });
});

app.post('/api/settings', durableUpload(upload.any()), async (req, res) => {
  const current = await Settings.findOne();
  const previousUploadPaths = collectUploadPaths(current?.toObject() || {});
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
    }
  };

  if (current) {
    await Settings.findByIdAndUpdate(current._id, nextSettings, { new: true });
  } else {
    await Settings.create(nextSettings);
  }

  const nextUploadPatterns = new Set(
    [...collectUploadPaths(nextSettings)].map((filePath) => String(uploadPathPattern(filePath)))
  );
  await Promise.all(
    [...previousUploadPaths]
      .filter((filePath) => !nextUploadPatterns.has(String(uploadPathPattern(filePath))))
      .map((filePath) => deleteReplacedUpload(filePath, ''))
  );

  res.json(nextSettings);
});

app.get('/api/export/excel', async (_req, res) => {
  const XLSX = getXlsx();
  const workbook = XLSX.utils.book_new();
  const players = await Player.find({ sold: true }).lean();
  const teams = await Team.find().sort({ name: 1 }).lean();

  teams.forEach((team, index) => {
    const sheetData = players
      .filter((player) => String(player.teamId || '') === String(team._id))
      .map((player) => ({
        Name: player.name,
        Age: player.age || '',
        Category: player.category,
        Amount: player.amount,
        'Phone Number': player.phone || '',
        'T-Shirt Size': player.tshirtSize || '',
        Team: team.name
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
    await Promise.all([migrateLocalUploads(), initializeDatabase()]);
    app.listen(PORT, () => {
      console.log(`Auction server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  }
}

startServer();
