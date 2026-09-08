import { gameIds, users } from '../../src/dashboardConfig.js'

const RA_API_BASE = 'https://retroachievements.org/API'
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000
const PROGRESS_TTL_MS = 15 * 60 * 1000
const REFRESH_LOCK_MS = 2 * 60 * 1000

export async function onRequestGet({ env }) {
  try {
    if (!env.RA_WEB_API_KEY) {
      return json(500, {
        error: 'Missing RA_WEB_API_KEY Cloudflare environment variable.',
      })
    }

    const refreshSummary = await refreshExpiredData(env.DB, env.RA_WEB_API_KEY)
    return json(200, {
      ...(await buildDashboardFromDb(env.DB, refreshSummary.source)),
      refreshSummary,
    })
  } catch (error) {
    return json(500, { error: error.message || 'Server error.' })
  }
}

async function refreshExpiredData(db, apiKey) {
  const now = Date.now()
  const summary = {
    source: 'sqlite',
    gamesFetched: 0,
    profilesFetched: 0,
    progressFetched: 0,
    skipped: '',
    guardrails: {
      games: 'fetch once, then keep forever',
      profiles: 'refresh after 24 hours',
      progress: 'refresh after 15 minutes',
    },
  }

  if (!(await dataNeedsRefresh(db, now))) return summary

  const lockAcquired = await acquireRefreshLock(db, now)
  if (!lockAcquired) {
    summary.skipped = 'A refresh is already running.'
    return summary
  }

  try {
    for (const gameId of gameIds) {
      if (await getGame(db, gameId)) continue

      const game = await fetchRa('API_GetGameInfoAndUserProgress.php', {
        g: gameId,
        u: users[0],
        y: apiKey,
      })

      await upsertGame(db, {
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
      const profile = await getProfile(db, username)
      if (!profile || now - profile.fetchedAt > PROFILE_TTL_MS) {
        const nextProfile = await fetchRa(
          'API_GetUserProfile.php',
          { u: username, y: apiKey },
          { allowNotFound: true },
        )

        await upsertProfile(db, {
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

      if (await progressExpired(db, username, now)) {
        const progress = await fetchRa(
          'API_GetUserProgress.php',
          { u: username, i: gameIds.join(','), y: apiKey },
          { allowNotFound: true },
        )
        const awards = await fetchUserAwards(apiKey, username)

        await upsertProgressSet(db, username, progress, awards, now)
        summary.progressFetched += 1
      }
    }

    if (summary.gamesFetched || summary.profilesFetched || summary.progressFetched) {
      summary.source = 'retroachievements'
    }

    return summary
  } finally {
    await releaseRefreshLock(db)
  }
}

async function dataNeedsRefresh(db, now) {
  for (const gameId of gameIds) {
    if (!(await getGame(db, gameId))) return true
  }

  for (const username of users) {
    const profile = await getProfile(db, username)
    if (!profile || now - profile.fetchedAt > PROFILE_TTL_MS) return true
    if (await progressExpired(db, username, now)) return true
  }

  return false
}

async function acquireRefreshLock(db, now) {
  await db
    .prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('refresh_lock_until', '0')")
    .run()

  const result = await db
    .prepare(
      `UPDATE app_meta
       SET value = ?
       WHERE key = 'refresh_lock_until' AND CAST(value AS INTEGER) < ?`,
    )
    .bind(String(now + REFRESH_LOCK_MS), now)
    .run()

  return result.meta.changes === 1
}

async function releaseRefreshLock(db) {
  await db
    .prepare("UPDATE app_meta SET value = '0' WHERE key = 'refresh_lock_until'")
    .run()
}

async function buildDashboardFromDb(db, source) {
  const games = await allGames(db)
  const profiles = await allProfiles(db)
  const progressRows = await allProgress(db)
  const progress = {}
  const progressFetchedAts = progressRows.map((row) => row.fetchedAt)
  const profileFetchedAts = profiles.map((row) => row.fetchedAt).filter(Boolean)
  const lastProgressFetchedAt = Math.max(0, ...progressFetchedAts)

  for (const row of progressRows) {
    progress[row.username] ??= {}
    progress[row.username][row.gameId] = {
      numPossibleAchievements: row.numPossibleAchievements,
      possibleScore: row.possibleScore,
      numAchieved: row.numAchieved,
      scoreAchieved: row.scoreAchieved,
      numAchievedHardcore: row.numAchievedHardcore,
      scoreAchievedHardcore: row.scoreAchievedHardcore,
      beaten: Boolean(row.beaten),
      mastered: Boolean(row.mastered),
    }
  }

  return {
    dashboard: {
      games,
      users: profiles,
      progress,
      source,
      cachedAt: new Date(Math.max(0, ...progressFetchedAts, ...profileFetchedAts)).toISOString(),
      progressFetchedAt: lastProgressFetchedAt
        ? new Date(lastProgressFetchedAt).toISOString()
        : null,
      refreshedAt: new Date().toISOString(),
    },
    progressFetchedAt: lastProgressFetchedAt
      ? new Date(lastProgressFetchedAt).toISOString()
      : null,
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
        'user-agent': 'RetroAchievementsBoardCloudflare/0.1',
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

  throw new Error(`RetroAchievements ${endpoint} failed after retries.`)
}

async function getGame(db, gameId) {
  return db.prepare('SELECT id FROM games WHERE id = ?').bind(gameId).first()
}

async function allGames(db) {
  const { results } = await db
    .prepare(
      `SELECT id, title, system, box_art AS boxArt,
        total_achievements AS totalAchievements, fetched_at AS fetchedAt
       FROM games`,
    )
    .all()

  return gameIds.map((id) => results.find((row) => row.id === id)).filter(Boolean)
}

async function upsertGame(db, game) {
  await db
    .prepare(
      `INSERT OR REPLACE INTO games
        (id, title, system, box_art, total_achievements, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      game.id,
      game.title,
      game.system,
      game.boxArt,
      game.totalAchievements,
      game.fetchedAt,
    )
    .run()
}

async function getProfile(db, username) {
  return db
    .prepare('SELECT fetched_at AS fetchedAt FROM user_profiles WHERE username = ?')
    .bind(username)
    .first()
}

async function allProfiles(db) {
  const { results } = await db
    .prepare(
      `SELECT username, display_username AS displayUsername, avatar, motto,
        total_points AS totalPoints, true_points AS truePoints,
        member_since AS memberSince, rich_presence AS richPresence,
        missing, fetched_at AS fetchedAt
       FROM user_profiles`,
    )
    .all()

  return users
    .map((username) => {
      const row = results.find((profile) => profile.username === username)
      if (!row) return { username, displayUsername: username, missing: true, totalPoints: 0 }
      return { ...row, missing: Boolean(row.missing) }
    })
    .sort((a, b) =>
      (a.displayUsername || a.username).localeCompare(
        b.displayUsername || b.username,
        undefined,
        { sensitivity: 'base' },
      ),
    )
}

async function upsertProfile(db, profile) {
  await db
    .prepare(
      `INSERT OR REPLACE INTO user_profiles
        (username, display_username, avatar, motto, total_points, true_points,
         member_since, rich_presence, missing, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
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
    .run()
}

async function progressExpired(db, username, now) {
  const placeholders = gameIds.map(() => '?').join(',')
  const row = await db
    .prepare(
      `SELECT MIN(fetched_at) AS oldest, COUNT(*) AS count
       FROM user_progress
       WHERE username = ? AND game_id IN (${placeholders})`,
    )
    .bind(username, ...gameIds)
    .first()

  return !row || row.count < gameIds.length || now - row.oldest > PROGRESS_TTL_MS
}

async function allProgress(db) {
  const { results } = await db
    .prepare(
      `SELECT username, game_id AS gameId,
        num_possible_achievements AS numPossibleAchievements,
        possible_score AS possibleScore,
        num_achieved AS numAchieved,
        score_achieved AS scoreAchieved,
        num_achieved_hardcore AS numAchievedHardcore,
        score_achieved_hardcore AS scoreAchievedHardcore,
        beaten, mastered,
        fetched_at AS fetchedAt
       FROM user_progress`,
    )
    .all()

  return results
}

async function fetchUserAwards(apiKey, username) {
  const awards = await fetchRa(
    'API_GetUserAwards.php',
    { u: username, y: apiKey },
    { allowNotFound: true },
  )
  const beatenGameIds = new Set()
  const masteredGameIds = new Set()

  for (const award of awards?.VisibleUserAwards ?? []) {
    const gameId = Number(award.AwardData)
    if (!gameIds.includes(gameId)) continue

    if (award.AwardType === 'Game Beaten') beatenGameIds.add(gameId)
    if (award.AwardType === 'Mastery/Completion') masteredGameIds.add(gameId)
  }

  return { beatenGameIds, masteredGameIds }
}

async function upsertProgressSet(db, username, progress, awards, fetchedAt) {
  for (const gameId of gameIds) {
    const row = progress?.[gameId] ?? progress?.[String(gameId)] ?? {}
    await db
      .prepare(
        `INSERT OR REPLACE INTO user_progress
          (username, game_id, num_possible_achievements, possible_score,
           num_achieved, score_achieved, num_achieved_hardcore,
           score_achieved_hardcore, beaten, mastered, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        username,
        gameId,
        Number(readRaField(row, 'numPossibleAchievements', 'NumPossibleAchievements')),
        Number(readRaField(row, 'possibleScore', 'PossibleScore')),
        Number(readRaField(row, 'numAchieved', 'NumAchieved')),
        Number(readRaField(row, 'scoreAchieved', 'ScoreAchieved')),
        Number(readRaField(row, 'numAchievedHardcore', 'NumAchievedHardcore')),
        Number(readRaField(row, 'scoreAchievedHardcore', 'ScoreAchievedHardcore')),
        awards.beatenGameIds.has(gameId) ? 1 : 0,
        awards.masteredGameIds.has(gameId) ? 1 : 0,
        fetchedAt,
      )
      .run()
  }
}

function readRaField(row, camelName, pascalName) {
  return row?.[camelName] ?? row?.[pascalName] ?? 0
}

function absoluteRaUrl(value) {
  if (!value) return ''
  return value.startsWith('http') ? value : `https://retroachievements.org${value}`
}

function json(status, payload) {
  return Response.json(payload, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  })
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
