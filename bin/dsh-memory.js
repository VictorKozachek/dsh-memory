#!/usr/bin/env node
/**
 * Исполняемая обёртка CLI `dsh-memory` (package.json → `bin.dsh-memory`).
 * Вся логика — в `lib/cli.js`; здесь только код возврата процесса.
 */

import { main } from '../lib/cli.js'

process.exitCode = main(process.argv.slice(2))
