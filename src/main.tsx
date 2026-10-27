import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/noto-sans';
import '@fontsource-variable/noto-sans-sc';
import '@fontsource-variable/noto-sans-mono';
import 'katex/dist/katex.min.css';
import App from './App';
import './App.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
