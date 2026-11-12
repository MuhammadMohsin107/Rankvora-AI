import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import NotFound from './NotFound';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

describe('NotFound page', () => {
  it('names the address that failed, so a stale bookmark is easy to spot', () => {
    render(
      <MemoryRouter initialEntries={['/old/bookmark?x=1']}>
        <NotFound />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText('/old/bookmark')).toBeInTheDocument();
  });

  it('leads back to the dashboard without reloading the app', () => {
    render(
      <MemoryRouter initialEntries={['/nope']}>
        <Where />
        <Routes>
          <Route path="/nope" element={<NotFound />} />
          <Route path="/" element={<p>dashboard</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(document.querySelector('s-button[href="/"]')!);
    expect(screen.getByTestId('where')).toHaveTextContent('/');
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });
});
