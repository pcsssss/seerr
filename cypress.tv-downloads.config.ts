import { defineConfig } from 'cypress';

// Deliberately separate from the production-like Cypress default (port 5055).
export default defineConfig({
  e2e: {
    baseUrl: 'http://127.0.0.1:15056',
    specPattern: 'cypress/e2e/tv-download-diagnostics.cy.ts',
    supportFile: false,
  },
  video: false,
  allowCypressEnv: false,
  retries: 0,
});
