import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, info) { console.error('App crash:', error, info); }
  render() {
    if (this.state.hasError) {
      return React.createElement('div', {
        style: { padding: '2rem', color: '#E2E8F0', background: '#060A0F', minHeight: '100vh', fontFamily: 'monospace' }
      },
        React.createElement('h1', { style: { color: '#C8FF00' } }, 'Something went wrong'),
        React.createElement('p', null, 'The app crashed. Please refresh the page.'),
        React.createElement('button', {
          onClick: () => window.location.reload(),
          style: { marginTop: '1rem', padding: '0.5rem 1rem', background: '#C8FF00', color: '#060A0F', border: 'none', borderRadius: '8px', cursor: 'pointer' }
        }, 'Refresh')
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
)
