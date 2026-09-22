import React from 'react';
import ReactDOM from 'react-dom/client';
import { CityPage } from './CityPage';
import './city.css';

/** /city/@nick[/building] — the nickname is the segment after /city/, without the @ it is written with. */
const nickname = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] ?? '').replace(/^@/, '');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CityPage nickname={nickname} />
  </React.StrictMode>,
);
