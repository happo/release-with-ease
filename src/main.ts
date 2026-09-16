#!/usr/bin/env node
import { cli } from './cli.ts';

await cli(process.argv.slice(2));
