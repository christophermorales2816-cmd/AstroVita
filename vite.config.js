import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the production build works unchanged on Vercel, Netlify
// and GitHub Pages (which serves from /<repo>/ rather than the domain root).
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1800,
    rollupOptions: {
      output: {
        // three.js is by far the heaviest dependency; splitting it keeps the
        // application chunk small enough to be parsed quickly on mobile.
        manualChunks: {
          three: ['three'],
          r3f: ['@react-three/fiber', '@react-three/drei'],
        },
      },
    },
  },
})
