import React from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.js';
import App from './App';
import DemoGate from './demo/DemoGate';
import GalleryGate from './prototypes/GalleryGate';
import LiveChatGate from './live-chat/LiveChatGate';
import { demoTokenFromPath } from './demo/token';
import { galleryRouteFromPath } from './prototypes/route';
import { liveChatRouteFromPath, prototypeChatFromPath } from './live-chat/route';
import './styles.css';

const demoToken = demoTokenFromPath(window.location.pathname);
const galleryRoute = demoToken == null ? galleryRouteFromPath(window.location.pathname) : null;
const prototypeChat = demoToken == null && galleryRoute == null
  ? prototypeChatFromPath(window.location.pathname)
  : null;
const liveChat = prototypeChat == null && demoToken == null && galleryRoute == null
  ? liveChatRouteFromPath(window.location.pathname)
  : null;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {demoToken != null ? <DemoGate token={demoToken} />
      : galleryRoute != null ? <GalleryGate route={galleryRoute} />
        : prototypeChat != null ? <LiveChatGate token={prototypeChat.token} malformed={prototypeChat.malformed === true} />
          : liveChat != null ? <LiveChatGate />
          : <App />}
  </React.StrictMode>,
);
