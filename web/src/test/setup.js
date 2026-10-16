import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

vi.stubGlobal('fetch', () => {
  throw new Error('Tests must not call fetch. The API client is mocked.');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.pushState({}, '', '/');
  window.location.hash = '';
});
