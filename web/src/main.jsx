import React from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.js';
import App from './App';
import DemoGate from './demo/DemoGate';
import GalleryGate from './prototypes/GalleryGate';
import LiveChatGate from './live-chat/LiveChatGate';
import { demoTokenFromPath } from './demo/token';
import { galleryRouteFromPath } from './prototypes/route';
import { liveChatRouteFromPath } from './live-chat/route';
import './styles.css';

const demoToken = demoTokenFromPath(window.location.pathname);
const galleryRoute = demoToken == null ? galleryRouteFromPath(window.location.pathname) : null;
const liveChat = demoToken == null && galleryRoute == null
  ? liveChatRouteFromPath(window.location.pathname)
  : null;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {demoToken != null ? <DemoGate token={demoToken} />
      : galleryRoute != null ? <GalleryGate route={galleryRoute} />
        : liveChat != null ? <LiveChatGate />
          : <App />}
  </React.StrictMode>,
);
