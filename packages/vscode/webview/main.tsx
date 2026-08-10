import { createRoot } from 'react-dom/client';
import { App } from './App';
// Bundled as text (esbuild css loader) and injected inline — the strict CSP
// allows inline styles only, no external resources of any kind.
import themeCss from './theme.css';

const style = document.createElement('style');
style.textContent = themeCss as unknown as string;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
