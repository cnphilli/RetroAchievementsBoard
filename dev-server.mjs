import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer as createViteServer } from 'vite'
import { gameIds, users } from './src/dashboardConfig.js'

const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT || 5173)
const RA_API_BASE = 'https://retroachievements.org/API'
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000
const PROGRESS_TTL_MS = 15 * 60 * 1000
const HARD_PULL_COOLDOWN_MS = 60 * 1000
const DB_PATH = path.resolve('data', 'ra-cache.sqlite')

let lastHardPullAt = 0
let inFlightRefresh = null

loadLocalEnv()
const db = openDatabase()

const vite = await createViteServer({
  server: { host: HOST, middlewareMode: true },
  appType: 'spa',
})

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)

    if (url.pathname === '/api/ra-dashboard') {
      await handleDashboard(req, res, url)
      return
    }

    vite.middlewares(req, res)
  } catch (error) {
    console.error(error)
    sendJson(res, 500, { error: error.message || 'Server error.' })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`\n  Local: http://localhost:${PORT}/\n`)
})

async function handleDashboard(req, res, url) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed.' })
    return
  }

  const apiKey = process.env.RA_WEB_API_KEY
  if (!apiKey) {
    sendJson(res, 500, {
      error: 'Missing RA_WEB_API_KEY. Add it to .env.local and restart npm run dev.',
    })
    return
  }

  const forceProgress = url.searchParams.get('force') === '1'
  const now = Date.now()

  if (forceProgress && now - lastHardPullAt < HARD_PULL_COOLDOWN_MS) {
    sendJson(res, 429, {
      error: `Hard pull cooldown active. Try again in ${Math.ceil(
        (HARD_PULL_COOLDOWN_MS - (now - lastHardPullAt)) / 1000,
      )} seconds.`,
      dashboard: buildDashboardFromDb('rate-limited'),
    })
    return
  }

  if (!inFlightRefresh) {
    if (forceProgress) lastHardPullAt = now
    inFlightRefresh = refreshExpiredData(apiKey, forceProgress).finally(() => {
      inFlightRefresh = null
    })
  }

  const refreshSummary = await inFlightRefresh
  sendJson(res, 200, {
    ...buildDashboardFromDb(forceProgress ? 'hard-pull' : refreshSummary.source),
    refreshSummary,
  })
}

async function refreshExpiredData(apiKey, forceProgress) {
  const now = Date.now()
  const summary = {
    source: 'sqlite',
    gamesFetched: 0,
    profilesFetched: 0,
    progressFetched: 0,
    guardrails: {
      games: 'fetch once, then keep forever',
      profiles: 'refresh after 24 hours',
      progress: 'refresh after 15 minutes, or on Hard Pull',
    },
  }

  for (const gameId of gameIds) {
    if (getGame(gameId)) continue

    const game = await fetchRa('API_GetGameInfoAndUserProgress.php', {
      g: gameId,
      u: users[0],
      y: apiKey,
    })

    upsertGame({
      id: Number(game.ID ?? gameId),
      title: game.Title ?? `Game ${gameId}`,
      system: game.ConsoleName ?? 'Unknown system',
      boxArt: absoluteRaUrl(game.ImageBoxArt),
      totalAchievements: Number(game.NumAchievements ?? 0),
      fetchedAt: now,
    })
    summary.gamesFetched += 1
  }

  for (const username of users) {
    const profile = getProfile(username)
    if (!profile || now - profile.fetchedAt > PROFILE_TTL_MS) {
      const nextProfile = await fetchRa(
        'API_GetUserProfile.php',
        { u: username, y: apiKey },
        { allowNotFound: true },
      )

      upsertProfile({
        username,
        displayUsername: nextProfile.User ?? username,
        avatar: absoluteRaUrl(nextProfile.UserPic),
        motto: nextProfile.Motto ?? '',
        totalPoints: Number(nextProfile.TotalPoints ?? 0),
        truePoints: Number(nextProfile.TotalTruePoints ?? 0),
        memberSince: nextProfile.MemberSince ?? '',
        richPresence: nextProfile.RichPresenceMsg ?? '',
        missing: Boolean(nextProfile.notFound),
        fetchedAt: now,
      })
      summary.profilesFetched += 1
    }

    if (forceProgress || progressExpired(username, now)) {
      const progress = await fetchRa(
        'API_GetUserProgress.php',
        { u: username, i: gameIds.join(','), y: apiKey },
        { allowNotFound: true },
      )

      upsertProgressSet(username, progress, now)
      summary.progressFetched += 1
    }
  }

  if (summary.gamesFetched || summary.profilesFetched || summary.progressFetched) {
    summary.source = 'retroachievements'
  }

  return summary
}

function buildDashboardFromDb(source) {
  const games = allGames()
  const profiles = allProfiles()
  const progressRows = allProgress()
  const progress = {}
  const progressFetchedAts = progressRows.map((row) => row.fetchedAt)
  const profileFetchedAts = profiles.map((row) => row.fetchedAt)

  for (const row of progressRows) {
    progress[row.username] ??= {}
    progress[row.username][row.gameId] = {
      numPossibleAchievements: row.numPossibleAchievements,
      possibleScore: row.possibleScore,
      numAchieved: row.numAchieved,
      scoreAchieved: row.scoreAchieved,
      numAchievedHardcore: row.numAchievedHardcore,
      scoreAchievedHardcore: row.scoreAchievedHardcore,
    }
  }

  return {
    games,
    users: profiles,
    progress,
    source,
    dbPath: DB_PATH,
    cachedAt: new Date(Math.max(0, ...progressFetchedAts, ...profileFetchedAts)).toISOString(),
    refreshedAt: new Date().toISOString(),
  }
}

async function fetchRa(endpoint, params, options = {}) {
  const url = new URL(`${RA_API_BASE}/${endpoint}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'RetroAchievementsBoardLocalDev/0.1',
      },
    })

    if (response.status === 429 && attempt < 4) {
      await wait(2000 * attempt)
      continue
    }

    if (response.status === 404 && options.allowNotFound) {
      return { notFound: true }
    }

    if (!response.ok) {
      throw new Error(`RetroAchievements ${endpoint} failed: ${response.status}`)
    }

    await wait(300)
    return response.json()
  }
}

function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const database = new DatabaseSync(DB_PATH)
  database.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      system TEXT NOT NULL,
      box_art TEXT NOT NULL,
      total_achievements INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
      username TEXT PRIMARY KEY,
      display_username TEXT NOT NULL,
      avatar TEXT NOT NULL,
      motto TEXT NOT NULL,
      total_points INTEGER NOT NULL,
      true_points INTEGER NOT NULL,
      member_since TEXT NOT NULL,
      rich_presence TEXT NOT NULL,
      missing INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_progress (
      username TEXT NOT NULL,
      game_id INTEGER NOT NULL,
      num_possible_achievements INTEGER NOT NULL,
      possible_score INTEGER NOT NULL,
      num_achieved INTEGER NOT NULL,
      score_achieved INTEGER NOT NULL,
      num_achieved_hardcore INTEGER NOT NULL,
      score_achieved_hardcore INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (username, game_id)
    );
  `)
  return database
}

function getGame(gameId) {
  return db.prepare('SELECT id FROM games WHERE id = ?').get(gameId)
}

function allGames() {
  const rows = db
    .prepare(
      `SELECT id, title, system, box_art AS boxArt,
        total_achievements AS totalAchievements, fetched_at AS fetchedAt
       FROM games`,
    )
    .all()

  return gameIds.map((id) => rows.find((row) => row.id === id)).filter(Boolean)
}

function upsertGame(game) {
  db.prepare(
    `INSERT OR REPLACE INTO games
      (id, title, system, box_art, total_achievements, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    game.id,
    game.title,
    game.system,
    game.boxArt,
    game.totalAchievements,
    game.fetchedAt,
  )
}

function getProfile(username) {
  return db
    .prepare('SELECT fetched_at AS fetchedAt FROM user_profiles WHERE username = ?')
    .get(username)
}

function allProfiles() {
  const rows = db
    .prepare(
      `SELECT username, display_username AS displayUsername, avatar, motto,
        total_points AS totalPoints, true_points AS truePoints,
        member_since AS memberSince, rich_presence AS richPresence,
        missing, fetched_at AS fetchedAt
       FROM user_profiles`,
    )
    .all()

  return users.map((username) => {
    const row = rows.find((profile) => profile.username === username)
    if (!row) return { username, displayUsername: username, missing: true, totalPoints: 0 }
    return { ...row, missing: Boolean(row.missing) }
  })
}

function upsertProfile(profile) {
  db.prepare(
    `INSERT OR REPLACE INTO user_profiles
      (username, display_username, avatar, motto, total_points, true_points,
       member_since, rich_presence, missing, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    profile.username,
    profile.displayUsername,
    profile.avatar,
    profile.motto,
    profile.totalPoints,
    profile.truePoints,
    profile.memberSince,
    profile.richPresence,
    profile.missing ? 1 : 0,
    profile.fetchedAt,
  )
}

function progressExpired(username, now) {
  const row = db
    .prepare(
      `SELECT MIN(fetched_at) AS oldest, COUNT(*) AS count
       FROM user_progress
       WHERE username = ? AND game_id IN (${gameIds.map(() => '?').join(',')})`,
    )
    .get(username, ...gameIds)

  return !row || row.count < gameIds.length || now - row.oldest > PROGRESS_TTL_MS
}

function allProgress() {
  return db
    .prepare(
      `SELECT username, game_id AS gameId,
        num_possible_achievements AS numPossibleAchievements,
        possible_score AS possibleScore,
        num_achieved AS numAchieved,
        score_achieved AS scoreAchieved,
        num_achieved_hardcore AS numAchievedHardcore,
        score_achieved_hardcore AS scoreAchievedHardcore,
        fetched_at AS fetchedAt
       FROM user_progress`,
    )
    .all()
}

function upsertProgressSet(username, progress, fetchedAt) {
  for (const gameId of gameIds) {
    const row = progress?.[gameId] ?? progress?.[String(gameId)] ?? {}
    db.prepare(
      `INSERT OR REPLACE INTO user_progress
        (username, game_id, num_possible_achievements, possible_score,
         num_achieved, score_achieved, num_achieved_hardcore,
         score_achieved_hardcore, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      username,
      gameId,
      Number(readRaField(row, 'numPossibleAchievements', 'NumPossibleAchievements')),
      Number(readRaField(row, 'possibleScore', 'PossibleScore')),
      Number(readRaField(row, 'numAchieved', 'NumAchieved')),
      Number(readRaField(row, 'scoreAchieved', 'ScoreAchieved')),
      Number(readRaField(row, 'numAchievedHardcore', 'NumAchievedHardcore')),
      Number(readRaField(row, 'scoreAchievedHardcore', 'ScoreAchievedHardcore')),
      fetchedAt,
    )
  }
}

function readRaField(row, camelName, pascalName) {
  return row?.[camelName] ?? row?.[pascalName] ?? 0
}

function loadLocalEnv() {
  const envPath = path.resolve('.env.local')
  if (!fs.existsSync(envPath)) return

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue

    const [key, ...valueParts] = trimmed.split('=')
    process.env[key.trim()] ??= valueParts.join('=').trim()
  }
}

function absoluteRaUrl(value) {
  if (!value) return ''
  return value.startsWith('http') ? value : `https://retroachievements.org${value}`
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(payload))
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
