#!/usr/bin/env node
// Thin shim over the compiled entry point. The published package ships
// `dist/`, built from `src/` by `npm run build`.
import '../dist/main.js';
