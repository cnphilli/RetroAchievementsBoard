import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { gameIds, users as trackedUsers } from './dashboardConfig'

const systems = ['Games', 'Rankings', 'Leaderboards', 'Forums', 'News', 'Docs']

function App() {
  const [dashboard, setDashboard] = useState(null)
  const [status, setStatus] = useState('Loading RetroAchievements data...')
  const [error, setError] = useState('')

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

  const raceEntries = useMemo(() => {
    if (!dashboard) return []

    return dashboard.users
      .map((user) => {
        let achieved = 0
        let possible = 0

        for (const game of dashboard.games) {
          const cell = getProgress(dashboard.progress, user.username, game.id)
          achieved += Number(cell?.numAchievedHardcore ?? cell?.numAchieved ?? 0)
          possible += Number(cell?.numPossibleAchievements ?? game.totalAchievements ?? 0)
        }

        return {
          achieved,
          avatar: user.avatar,
          displayUsername: user.displayUsername || user.username,
          percent: possible ? (achieved / possible) * 100 : 0,
          possible,
          username: user.username,
        }
      })
      .sort((a, b) => a.percent - b.percent)
  }, [dashboard])

  async function loadDashboard() {
    setError('')
    setStatus('Loading RetroAchievements data...')

    try {
      const response = await fetch('/api/ra-dashboard')
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
        `Achievement progress last downloaded from RetroAchievements at ${formatTime(
          payload.progressFetchedAt,
        )}`,
      )
    } catch (err) {
      setError(err.message)
      setStatus('Could not update data.')
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
              <RaceTrack entries={raceEntries} />
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

    </div>
  )
}

function RaceTrack({ entries }) {
  return (
    <div className="race-track" aria-label="Overall achievement progress race">
      <span className="race-label race-label-start">0%</span>
      <span className="race-label race-label-finish">100%</span>
      <div className="race-line" aria-hidden="true" />
      {entries.map((entry, index) => (
        <div
          className="race-runner"
          key={entry.username}
          style={{
            left: `${Math.max(0, Math.min(100, entry.percent))}%`,
            zIndex: 10 + index,
          }}
        >
          {entry.avatar ? (
            <img src={entry.avatar} alt="" />
          ) : (
            <span>{entry.displayUsername.slice(0, 2).toUpperCase()}</span>
          )}
          <div className="race-tooltip">
            <strong>{entry.displayUsername}</strong>
            <small>
              {entry.achieved}/{entry.possible} achievements (
              {Math.round(entry.percent)}%)
            </small>
          </div>
        </div>
      ))}
    </div>
  )
}

function AchievementTable({ dashboard }) {
  const headerRef = useRef(null)
  const usersRef = useRef(null)

  function syncScroll(event) {
    if (headerRef.current) headerRef.current.scrollLeft = event.currentTarget.scrollLeft
    if (usersRef.current) usersRef.current.scrollTop = event.currentTarget.scrollTop
  }

  return (
    <div
      className="table-frame"
      style={{
        '--game-area-width': `${dashboard.games.length * 11.7}rem`,
        '--game-count': dashboard.games.length,
        '--user-count': dashboard.users.length,
      }}
    >
      <div className="table-corner">User</div>

      <div className="table-header-scroll" ref={headerRef}>
        <div className="game-header-row">
          {dashboard.games.map((game) => (
            <a
              className="game-heading"
              href={`https://retroachievements.org/game/${game.id}`}
              key={game.id}
              target="_blank"
            >
              {game.boxArt && <img src={game.boxArt} alt="" />}
              <span>{game.title}</span>
              <small>{game.system}</small>
            </a>
          ))}
        </div>
      </div>

      <div className="table-users-scroll" ref={usersRef}>
        {dashboard.users.map((user) => (
          <UserCard key={user.username} user={user} />
        ))}
      </div>

      <div className="table-body-scroll" onScroll={syncScroll}>
        <div
          className="progress-grid"
          style={{
            gridTemplateColumns: `repeat(${dashboard.games.length}, var(--game-col-width))`,
          }}
        >
          {dashboard.users.map((user) =>
            dashboard.games.map((game) => {
              const progress = getProgress(dashboard.progress, user.username, game.id)
              const achieved = Number(
                progress?.numAchievedHardcore ?? progress?.numAchieved ?? 0,
              )
              const possible = Number(
                progress?.numPossibleAchievements ?? game.totalAchievements ?? 0,
              )
              const percent = possible ? Math.round((achieved / possible) * 100) : 0

              return (
                <div className="progress-cell" key={`${user.username}-${game.id}`}>
                  <strong>
                    {achieved}/{possible}
                  </strong>
                  <div className="progress-inline">
                    <span>{percent}%</span>
                    <div className="meter" aria-hidden="true">
                      <div style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                </div>
              )
            }),
          )}
        </div>
      </div>
    </div>
  )
}

function UserCard({ user }) {
  return (
    <div className="user-card">
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

export default App
