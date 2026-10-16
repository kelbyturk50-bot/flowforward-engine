import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DemoGate from './demo/DemoGate';
import { demoTokenFromPath } from './demo/token';
import './styles.css';

const demoToken = demoTokenFromPath(window.location.pathname);

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {demoToken == null ? <App /> : <DemoGate token={demoToken} />}
  </React.StrictMode>,
);
