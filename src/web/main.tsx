import { createRoot } from 'react-dom/client';
import { Control } from './Control';
import { Overlay } from './Overlay';
import './styles/app.css';

const path = location.pathname.replace(/\/+$/, '');
const root = createRoot(document.getElementById('root')!);
if (path === '/overlay' || path === '/read') root.render(<Overlay />);
else root.render(<Control />);
