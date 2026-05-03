import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { Browser } from './components/Browser'
import { ShareView } from './components/ShareView'
import { useStore } from './lib/store'

import { useEffect } from 'react'
import { api } from './lib/api'

function App() {
  const { channel, setChannel } = useStore()

  useEffect(() => {
    api.channels.list().then(r => {
      if (r.channels.length > 0 && !useStore.getState().channel) {
        setChannel(r.channels[0])
      }
    })
  }, [setChannel])

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        {/* Public share links — no sidebar */}
        <Route path="/s/:token" element={<ShareView />} />

        {/* Main authenticated view */}
        <Route
          path="/*"
          element={
            <div style={{ height: '100%', display: 'flex' }}>
              {useStore().sidebarOpen && <Sidebar />}
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {channel ? (
                  <Browser />
                ) : (
                  <div style={{
                    flex: 1, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', color: 'var(--text-3)', fontSize: 14,
                  }}>
                    Select a album to browse
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
