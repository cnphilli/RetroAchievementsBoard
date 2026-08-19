import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { gameIds, users as trackedUsers } from './dashboardConfig'

const systems = ['Games', 'Rankings', 'Leaderboards', 'Forums', 'News', 'Docs']

function App() {
  const [dashboard, setDashboard] = useState(null)
  const [status, setStatus] = useState('Loading RetroAchievements data...')
  const [error, setError] = useState('')
  const [isHardPulling, setIsHardPulling] = useState(false)

  useEffect(() => {
    loadDashboard()
  }, [])

  const totals = useMemo(() => {
    if (!dashboard) return { achieved: 0, possible: 0 }

    let achieved = 0
    let possible = 0

    for (const user of dashboard.users) {
      for (const game of dashboard.games) {
        const cell = getProgress(dashboard.progress, user.username, game.id)
        achieved += Number(cell?.numAchievedHardcore ?? cell?.numAchieved ?? 0)
        possible += Number(cell?.numPossibleAchievements ?? game.totalAchievements ?? 0)
      }
    }

    return { achieved, possible }
  }, [dashboard])

  async function loadDashboard({ force = false } = {}) {
    setError('')
    setStatus(force ? 'Hard pull in progress...' : 'Loading RetroAchievements data...')
    setIsHardPulling(force)

    try {
      const response = await fetch(`/api/ra-dashboard${force ? '?force=1' : ''}`)
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        throw new Error(
          'The dev API is not running. Stop the old server and restart with npm run dev.',
        )
      }

      const payload = await response.json()

      if (!response.ok) {
        if (payload.dashboard) setDashboard(payload.dashboard)
        throw new Error(payload.error || 'Unable to load dashboard.')
      }

      setDashboard(payload.dashboard ?? payload)
      setStatus(
        `${statusLabel(payload)} at ${formatTime(payload.cachedAt)}`,
      )
    } catch (err) {
      setError(err.message)
      setStatus('Could not update data.')
    } finally {
      setIsHardPulling(false)
    }
  }

  return (
    <div className="site-shell">
      <header className="site-header is-hidden-for-now">
        <a className="brand" href="/" aria-label="RetroAchievements Board home">
          <span className="brand-mark">RA</span>
          <span className="brand-copy">
            <strong>RetroAchievements</strong>
            <small>Board</small>
          </span>
        </a>

        <nav className="main-nav" aria-label="Primary navigation">
          {systems.map((item) => (
            <a href="/" key={item}>
              {item}
            </a>
          ))}
        </nav>

        <form className="search-form" role="search">
          <label htmlFor="site-search">Search</label>
          <input id="site-search" type="search" placeholder="Search..." />
        </form>

        <div className="account-links">
          <a href="/">Log in</a>
          <a className="register-link" href="/">
            Register
          </a>
        </div>
      </header>

      <main className="page-preview">
        <section className="welcome-panel">
          <div className="dashboard-header">
            <div>
              <p className="eyebrow">Year of Achievements Progress Tracker</p>
              <h1>Super Illegal Entertainment System</h1>
            </div>
            <div className="summary-strip">
              <span>{trackedUsers.length} users</span>
              <span>{gameIds.length} games</span>
              <span>
                {totals.achieved}/{totals.possible || '--'} achievements
              </span>
            </div>
          </div>

          {error && <div className="status-message error">{error}</div>}
          <div className="status-message">{status}</div>

      {dashboard ? (
            <AchievementTable dashboard={dashboard} />
          ) : (
            <div className="loading-box">Fetching profiles, games, and progress...</div>
          )}
        </section>
      </main>

      <button
        className="hard-pull-button"
        disabled={isHardPulling}
        type="button"
        onClick={() => loadDashboard({ force: true })}
      >
        {isHardPulling ? 'Pulling...' : 'Hard Pull'}
      </button>
    </div>
  )
}

function AchievementTable({ dashboard }) {
  return (
    <div className="table-frame">
      <table className="achievement-table">
        <thead>
          <tr>
            <th className="user-column">User</th>
            {dashboard.games.map((game) => (
              <th key={game.id}>
                <a
                  className="game-heading"
                  href={`https://retroachievements.org/game/${game.id}`}
                  target="_blank"
                >
                  {game.boxArt && <img src={game.boxArt} alt="" />}
                  <span>{game.title}</span>
                  <small>{game.system}</small>
                </a>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dashboard.users.map((user) => (
            <tr key={user.username}>
              <th className="user-card" scope="row">
                <a
                  className="user-link"
                  href={`https://retroachievements.org/user/${user.username}`}
                  target="_blank"
                >
                  {user.avatar && <img src={user.avatar} alt="" />}
                  <span>
                    <strong>{user.displayUsername || user.username}</strong>
                    <small>
                      {user.missing
                        ? 'Profile not found'
                        : `${user.totalPoints.toLocaleString()} points`}
                    </small>
                  </span>
                </a>
                {user.motto && <p>{user.motto}</p>}
              </th>
              {dashboard.games.map((game) => {
                const progress = getProgress(
                  dashboard.progress,
                  user.username,
                  game.id,
                )
                const achieved = Number(
                  progress?.numAchievedHardcore ?? progress?.numAchieved ?? 0,
                )
                const possible = Number(
                  progress?.numPossibleAchievements ?? game.totalAchievements ?? 0,
                )
                const percent = possible ? Math.round((achieved / possible) * 100) : 0

                return (
                  <td key={`${user.username}-${game.id}`}>
                    <div className="progress-cell">
                      <strong>
                        {achieved}/{possible}
                      </strong>
                      <span>{percent}%</span>
                      <div className="meter" aria-hidden="true">
                        <div style={{ width: `${percent}%` }} />
                      </div>
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function getProgress(progress, username, gameId) {
  return progress?.[username]?.[gameId] ?? progress?.[username]?.[String(gameId)]
}

function formatTime(value) {
  if (!value) return 'just now'
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function statusLabel(payload) {
  if (payload.source === 'sqlite') return 'Loaded from SQLite'
  if (payload.source === 'hard-pull') return 'Hard pull updated progress'
  if (payload.source === 'retroachievements') return 'Updated from RetroAchievements'
  return 'Loaded'
}

export default App
