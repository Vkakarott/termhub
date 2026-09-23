import React from 'react';
import ReactDOM from 'react-dom/client';
import { CityPage } from './CityPage';
import { nicknameFromPath } from './url';
import './city.css';

const nickname = nicknameFromPath(location.pathname);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CityPage nickname={nickname} />
  </React.StrictMode>,
);
