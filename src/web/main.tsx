import { createRoot } from 'react-dom/client';
import { About } from './About';
import { Control } from './Control';
import { Overlay } from './Overlay';
import { Reader } from './Reader';
import './styles/app.css';

import { BASE } from './net';

const path = (location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname).replace(/\/+$/, '');
const root = createRoot(document.getElementById('root')!);
if (path === '/overlay' || path === '/read') root.render(<Overlay />);
// The charity stream scene for OBS: the reader in a panel, with the donations around it. Loaded on its
// own (its fonts and QR encoder are not for readers).
else if (path === '/stream') void import('./Stream').then(({ Stream }) => root.render(<Stream />));
// The hosted service serves its home page at "/" (a self-hosted server redirects "/" to /control).
else if (path === '/reader' || path === '') root.render(<Reader />);
else if (path === '/about') root.render(<About />);
else root.render(<Control />);
