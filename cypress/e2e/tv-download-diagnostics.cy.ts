// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths -- Synthetic Cypress fixtures live outside application aliases.
import { mockSearchForSelection } from '../fixtures/tv-downloads';

const panel = 'section[aria-label="Download details"]';
const dialog = '[role="dialog"]';
const searchUrl = '/api/v1/tv/123/downloads/search';
function openPanel() {
  cy.setCookie('mock-role', 'manager');
  cy.visit('/tv/123');
  cy.wait('@hydratedUser', { timeout: 30000 });
  cy.contains('button', 'Show download details').scrollIntoView().click();
  cy.get(panel).should('be.visible');
  cy.get(panel)
    .contains('label', /^Season/)
    .find('select')
    .select('2');
}
function findSources() {
  cy.get(panel).contains('button', 'Find sources').click();
  cy.get(dialog).should('be.visible').should('have.length', 1);
  cy.get(dialog).contains('Sources for season 2').should('be.visible');
  cy.get(dialog)
    .find('[data-testid="modal-title"]')
    .then(($el) => {
      const rect = $el[0].getBoundingClientRect();
      expect(rect.top).to.be.at.least(0);
      expect(rect.bottom).to.be.lessThan(Cypress.config('viewportHeight'));
    });
}
// Native Cypress exercises real TV page, i18n, SWR, portals and focus management.
// Synthetic APIs only; every grab is intercepted and no production connection exists.
describe('TV DownloadDiagnostics source picker', () => {
  beforeEach(() => {
    expect(Cypress.config('baseUrl')).to.eq('http://127.0.0.1:15056');
    cy.intercept('GET', '/api/v1/auth/me').as('hydratedUser');
    cy.intercept({ url: '**', middleware: true }, (req) => {
      if (new URL(req.url).origin !== 'http://127.0.0.1:15056')
        throw new Error('Browser attempted a non-mock request.');
    });
  });
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    it(`opens immediately, loads S2 sources and confirms in one dialog on ${name}`, () => {
      cy.viewport(width, height);
      let searches = 0;
      cy.intercept('POST', searchUrl, (req) => {
        searches++;
        expect(req.body).to.deep.eq({ is4k: false, seasonNumber: 2 });
        req.reply({ delay: 1500, body: mockSearchForSelection(2) });
      }).as('search');
      let grabs = 0;
      cy.intercept('POST', '/api/v1/tv/123/downloads/grab', (req) => {
        grabs++;
        expect(req.body).to.deep.eq({
          is4k: false,
          seasonNumber: 2,
          token: 'a'.repeat(48),
          confirmRejected: true,
          confirmDuplicate: true,
        });
        req.reply({ statusCode: 202, body: {} });
      }).as('grab');
      openPanel();
      cy.get(panel).contains('0 of 8 episodes imported').should('be.visible');
      findSources();
      cy.get(dialog).contains('Searching indexers…').should('be.visible');
      cy.get(panel).contains('button', 'Find sources').should('be.disabled');
      cy.wait('@search');
      cy.get(dialog)
        .should('contain', 'Industry S02 mock season pack')
        .and('contain', 'Season pack')
        .and('contain', 'Episode release')
        .and('not.contain', 'Industry S03');
      cy.then(() => expect(searches).to.eq(1));
      cy.get(dialog).contains('button', 'Select release').first().click();
      cy.get(dialog)
        .should('have.length', 1)
        .within(() => {
          cy.contains('Send this release to Sonarr?').should('be.visible');
          cy.get('[data-testid="modal-ok-button"]').should('be.disabled');
        });
      cy.focused().closest(dialog).should('exist');
      cy.screenshot(`source-picker-${name}-confirmation`, {
        capture: 'viewport',
      });
      cy.get('[data-testid="modal-cancel-button"]').click();
      cy.get(dialog).should('contain', 'Sources for season 2');
      cy.then(() => expect(grabs).to.eq(0));
      cy.focused().closest(dialog).should('exist');
      cy.get(dialog).contains('button', 'Select release').first().click();
      cy.get(dialog).within(() => {
        cy.contains('label', 'I have reviewed the rejection reasons')
          .find('input')
          .check();
        cy.get('[data-testid="modal-ok-button"]').should('be.disabled');
        cy.contains('label', 'I understand this may duplicate')
          .find('input')
          .check();
        cy.get('[data-testid="modal-ok-button"]').click();
      });
      cy.wait('@grab');
      cy.get(dialog).should('not.exist');
      cy.get(panel)
        .contains('Release sent to Sonarr. Refresh progress shortly.')
        .should('be.visible');
      cy.then(() => expect(grabs).to.eq(1));
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
    });
    it(`shows failure and empty states with retry in the picker on ${name}`, () => {
      cy.viewport(width, height);
      let count = 0;
      cy.intercept('POST', searchUrl, (req) => {
        count++;
        if (count === 1)
          req.reply({
            statusCode: 502,
            body: { message: 'Synthetic Sonarr search failed. Search again.' },
          });
        else if (count === 2)
          req.reply({ body: { ...mockSearchForSelection(2), releases: [] } });
        else req.reply({ body: mockSearchForSelection(2) });
      }).as('search');
      openPanel();
      findSources();
      cy.wait('@search');
      cy.get(dialog)
        .contains('[role="alert"]', 'Synthetic Sonarr search failed')
        .should('be.visible');
      cy.get(dialog).contains('button', 'Search again').click();
      cy.wait('@search');
      cy.get(dialog)
        .contains('This search returned no releases.')
        .should('be.visible');
      cy.get(dialog).should('not.contain', 'Synthetic Sonarr search failed');
      cy.get(dialog).contains('button', 'Search again').click();
      cy.wait('@search');
      cy.get(dialog).should('contain', 'Industry S02 mock season pack');
      cy.screenshot(`source-picker-${name}-results`, { capture: 'viewport' });
      cy.get(dialog).contains('button', 'Close').click();
      cy.get(dialog).should('not.exist');
      cy.focused().should('contain', 'Find sources');
    });
    it(`ignores canceled slow results and uses the new episode target on ${name}`, () => {
      cy.viewport(width, height);
      cy.intercept('POST', searchUrl, (req) => {
        if (req.body.seasonNumber === 2)
          req.reply({ delay: 2500, body: mockSearchForSelection(2) });
        else {
          expect(req.body).to.deep.eq({
            is4k: false,
            seasonNumber: 3,
            episodeId: 301,
          });
          req.reply({ body: mockSearchForSelection(3, 301) });
        }
      }).as('search');
      openPanel();
      findSources();
      cy.get(dialog).contains('Searching indexers…').should('be.visible');
      cy.get(dialog).contains('button', 'Close').click();
      cy.get(dialog).should('not.exist');
      cy.get(panel)
        .contains('label', /^Season/)
        .find('select')
        .select('3');
      cy.get(panel)
        .contains('li', 'S3E1')
        .contains('button', 'Find releases')
        .click();
      cy.get(dialog).should('contain', 'Sources for S3E1');
      cy.get(dialog)
        .contains('Industry S03E01 mock episode')
        .should('be.visible');
      // Beyond the canceled response delay: it must never replace the new target.
      cy.wait(2800);
      cy.get(dialog)
        .should('contain', 'Sources for S3E1')
        .and('not.contain', 'Industry S02');
      cy.get(dialog).contains('button', 'Close').click();
    });
    it(`expires selections, clears confirmation and retries on ${name}`, () => {
      cy.viewport(width, height);
      let count = 0;
      cy.intercept('POST', searchUrl, (req) => {
        const body = mockSearchForSelection(2);
        if (++count === 1)
          body.expiresAt = new Date(Date.now() + 3000).toISOString();
        req.reply({ body });
      }).as('search');
      openPanel();
      findSources();
      cy.wait('@search');
      cy.get(dialog).contains('button', 'Select release').first().click();
      cy.get(dialog)
        .contains('Send this release to Sonarr?')
        .should('be.visible');
      cy.get(dialog)
        .contains('These sources have expired.', { timeout: 7000 })
        .should('be.visible');
      cy.get(dialog).should('not.contain', 'Send this release to Sonarr?');
      cy.get(dialog).contains('button', 'Select release').should('be.disabled');
      cy.get(dialog).contains('button', 'Search again').click();
      cy.wait('@search');
      cy.get(dialog).should('not.contain', 'These sources have expired.');
      cy.get(dialog)
        .contains('button', 'Select release')
        .first()
        .should('not.be.disabled');
    });
  }
  it('keeps keyboard focus inside the picker, Escape cancels and focus returns to the trigger', () => {
    openPanel();
    findSources();
    cy.focused().closest(dialog).should('exist');
    cy.get(dialog).contains('button', 'Close').focus();
    cy.focused().trigger('keydown', { key: 'Escape', bubbles: true });
    cy.get(dialog).should('not.exist');
    cy.focused().should('contain', 'Find sources');
  });
  it('keeps the ordinary-user TV page free of diagnostics/download API requests', () => {
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
