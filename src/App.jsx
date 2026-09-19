import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Overview from './pages/Overview'
import Accounts from './pages/Accounts'
import Analytics from './pages/Analytics'
import Calendar from './pages/Calendar'
import VideoGenerator from './pages/VideoGenerator'
import Editor from './pages/Editor'
import PostGenerator from './pages/PostGenerator'
import CarouselAgent from './pages/CarouselAgent'
import Posting from './pages/Posting'
import Warmup from './pages/Warmup'
import History from './pages/History'
import Settings from './pages/Settings'
import Personas from './pages/Personas'
import Content from './pages/Content'
import RedditFeed from './pages/RedditFeed'
import ThreadsContent from './pages/ThreadFeed'
import iPhoneBridge from './pages/iPhoneBridge'
import UtmLinks from './pages/UtmLinks'
import YtcFusion from './pages/YtcFusion'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/generator" element={<VideoGenerator />} />
        <Route path="/editor" element={<Editor />} />
        <Route path="/posts" element={<PostGenerator />} />
        <Route path="/carousel-agent" element={<CarouselAgent />} />
        <Route path="/posting" element={<Posting />} />
        <Route path="/warmup" element={<Warmup />} />
        <Route path="/threads" element={<ThreadsContent />} />
        <Route path="/history" element={<History />} />
        <Route path="/personas" element={<Personas />} />
        <Route path="/content" element={<Content />} />
        <Route path="/reddit" element={<RedditFeed />} />
        <Route path="/iphone" element={<iPhoneBridge />} />
        <Route path="/utm" element={<UtmLinks />} />
        <Route path="/ytcfusion" element={<YtcFusion />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Layout>
  )
}
