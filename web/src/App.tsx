import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TeamActivatePage } from './pages/TeamActivatePage.js';
import { TeamHomePage } from './pages/TeamHomePage.js';
import { QrScanPage } from './pages/QrScanPage.js';
import { TeamFinalPage } from './pages/TeamFinalPage.js';
import { StaffLoginPage } from './pages/StaffLoginPage.js';
import { FinalOrganizerPage } from './pages/FinalOrganizerPage.js';
import { AdminPage } from './pages/AdminPage.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 2_000,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/acceso" element={<TeamActivatePage />} />
          <Route path="/" element={<TeamHomePage />} />
          <Route path="/q/:code" element={<QrScanPage />} />
          <Route path="/final" element={<TeamFinalPage />} />
          <Route path="/staff/login" element={<StaffLoginPage />} />
          <Route path="/final-staff" element={<FinalOrganizerPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
