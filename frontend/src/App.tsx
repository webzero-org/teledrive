import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { Browser } from './components/Browser'
import { ShareView } from './components/ShareView'
import { useStore } from './lib/store'

function App() {
  const { channel } = useStore()

  return (
    <BrowserRouter>
      <Routes>
        {/* Public share links — no sidebar */}
        <Route path="/s/:token" element={<ShareView />} />

        {/* Main authenticated view */}
        <Route
          path="/*"
          element={
            <div style={{ height: '100%', display: 'flex' }}>
              <Sidebar />
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {channel ? (
                  <Browser />
                ) : (
                  <div style={{
                    flex: 1, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', color: 'var(--text-3)', fontSize: 14,
                  }}>
                    Select a channel to browse
                  </div>
                )}
              </div>
            </div>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

export default App
