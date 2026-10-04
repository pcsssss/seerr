const panel = 'section[aria-label="Download details"]';

// Run only with cypress.tv-downloads.config.ts and the mock-only Next server.
// Real messages, SWR, TV page, Modal portal and Headless UI transitions render.
describe('TV DownloadDiagnostics runtime', () => {
  beforeEach(() => {
    expect(Cypress.config('baseUrl')).to.eq('http://127.0.0.1:15056');
    cy.intercept('GET', '/api/v1/auth/me').as('hydratedUser');
    cy.intercept({ url: '**', middleware: true }, (req) => {
      const url = new URL(req.url);
      if (url.origin !== 'http://127.0.0.1:15056') {
        throw new Error(`Browser attempted non-mock request: ${url.origin}`);
      }
    });
  });
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    it(`renders authorized TV details, opens/cancels/confirms a release on ${name}`, () => {
      cy.viewport(width, height);
      cy.setCookie('mock-role', 'manager');
      cy.intercept('POST', '/api/v1/tv/123/downloads/search', (req) => {
        expect(req.body).to.deep.eq({ is4k: false, seasonNumber: 3 });
        req.continue();
      }).as('search');
      let grabs = 0;
      cy.intercept('POST', '/api/v1/tv/123/downloads/grab', (req) => {
        grabs++;
        expect(req.body).to.deep.eq({
          is4k: false,
          seasonNumber: 3,
          token: 'a'.repeat(48),
          confirmRejected: true,
          confirmDuplicate: true,
        });
        req.reply({ statusCode: 202, body: {} });
      }).as('grab');
      cy.visit('/tv/123');
      // SSR buttons can exist before React attaches their event handlers.
      cy.wait('@hydratedUser', { timeout: 30000 });
      cy.get('[data-testid="media-title"]').should('contain', 'Industry');
      cy.contains('button', 'Show download details').scrollIntoView().click();
      cy.get(panel)
        .should('be.visible')
        .within(() => {
          cy.contains('0 of 8 episodes imported').should('be.visible');
          cy.contains('1.8% downloaded').should('be.visible');
          cy.contains(
            'Sonarr reports a warning or error but supplied no explanation.'
          ).should('be.visible');
          cy.contains('label', /^Season/)
            .find('select')
            .select('3');
          cy.contains('1 of 8 episodes imported').should('be.visible');
          cy.contains('li', 'S3E8').should('contain', 'Imported in Sonarr');
          cy.contains('li', 'S3E1').should(
            'contain',
            'No file / no visible queue'
          );
          cy.contains('button', 'Search season releases').click();
        });
      cy.wait('@search');
      cy.contains('button', 'Select release').scrollIntoView().click();
      cy.get('[role="dialog"]')
        .should('be.visible')
        .within(() => {
          cy.contains('Send this release to Sonarr?').should('be.visible');
          cy.get('[data-testid="modal-ok-button"]').should('be.disabled');
        });
      cy.screenshot(`tv-downloads-${name}-confirmation`, {
        capture: 'viewport',
      });
      cy.get('[data-testid="modal-cancel-button"]').click();
      cy.get('[role="dialog"]').should('not.exist');
      cy.then(() => expect(grabs).to.eq(0));
      cy.contains('button', 'Select release').click();
      cy.get('[role="dialog"]')
        .should('be.visible')
        .within(() => {
          cy.contains('label', 'I have reviewed the rejection reasons')
            .find('input')
            .check();
          cy.get('[data-testid="modal-ok-button"]').should('be.disabled');
          cy.contains('label', 'I understand this may duplicate')
            .find('input')
            .check();
          cy.get('[data-testid="modal-ok-button"]')
            .should('not.be.disabled')
            .click();
        });
      cy.wait('@grab');
      cy.get('[role="dialog"]').should('not.exist');
      cy.contains('Release sent to Sonarr. Refresh progress shortly.').should(
        'be.visible'
      );
      cy.then(() => expect(grabs).to.eq(1));
      cy.contains('button', 'Hide download details').scrollIntoView().click();
      cy.get(panel).should('not.exist');
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
    });
  }
  it('renders the ordinary-user TV page without diagnostics or download API requests', () => {
    cy.setCookie('mock-role', 'ordinary');
    cy.intercept('/api/v1/tv/123/downloads*', () => {
      throw new Error('Ordinary user requested diagnostics.');
    });
    cy.visit('/tv/123');
    cy.wait('@hydratedUser', { timeout: 30000 });
    cy.get('[data-testid="media-title"]').should('contain', 'Industry');
    cy.contains('Show download details').should('not.exist');
    cy.get(panel).should('not.exist');
  });
});
