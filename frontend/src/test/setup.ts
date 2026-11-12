import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Vitest runs with no globals, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
})
