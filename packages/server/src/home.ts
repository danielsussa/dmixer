import os from 'node:os'
import path from 'node:path'

/** Where the index of linked mixes and the config live. */
export const HOME = process.env.DMIXER_HOME ?? path.join(os.homedir(), '.dmixer')
