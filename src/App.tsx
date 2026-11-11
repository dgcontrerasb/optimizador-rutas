import React from 'react';
import { LoginView } from './components/LoginView';
import { showConsoleView } from './ui/authGate';

export default function App() {
  return <LoginView onLoginSuccess={() => showConsoleView()} />;
}
