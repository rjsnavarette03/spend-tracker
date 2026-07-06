import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppRoot } from './AppRoot';
import { UiHost } from './components/feedback';
import { applyTheme } from './theme';
import './styles.css';

// Reflect the saved/system theme before the first paint.
applyTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppRoot />
    </BrowserRouter>
    <UiHost />
  </React.StrictMode>
);
