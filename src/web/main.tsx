import { createRoot } from 'react-dom/client';
import { Control } from './Control';
import { Overlay } from './Overlay';
import { Reader } from './Reader';
import './styles/app.css';

const path = location.pathname.replace(/\/+$/, '');
const root = createRoot(document.getElementById('root')!);
if (path === '/overlay' || path === '/read') root.render(<Overlay />);
// The hosted service serves its home page at "/" (a self-hosted server redirects "/" to /control).
else if (path === '/reader' || path === '') root.render(<Reader />);
else root.render(<Control />);
