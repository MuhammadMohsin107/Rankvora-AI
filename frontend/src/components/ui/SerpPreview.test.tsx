import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SerpPreview from './SerpPreview';

describe('SerpPreview', () => {
  it('draws only the fields it is given', () => {
    render(<SerpPreview title="Blue linen shirt | Northline" />);
    expect(screen.getByText('Blue linen shirt | Northline')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Search result preview' })).toBeInTheDocument();
  });

  it('shows the address, title and description together', () => {
    render(<SerpPreview address="/products/blue-shirt" title="Blue shirt" description="A soft linen shirt." />);
    expect(screen.getByText('/products/blue-shirt')).toBeInTheDocument();
    expect(screen.getByText('Blue shirt')).toBeInTheDocument();
    expect(screen.getByText('A soft linen shirt.')).toBeInTheDocument();
  });

  it('renders nothing when there is neither a title nor a description', () => {
    const { container } = render(<SerpPreview address="/x" />);
    expect(container).toBeEmptyDOMElement();
  });
});
