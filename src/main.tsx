import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './components/ui';
import { detectInitialLang, setActiveLang } from './lib/lang';
import './styles.css';

// Resolve the language before the first render so the UI never flashes English
// and then switches to Chinese.
setActiveLang(detectInitialLang());

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>
);
