export * from './types.js';
export { TrainingModuleImpl } from './engine.js';
export { openDatabase } from './schema.js';
export { deriveExerciseCurve } from './curve.js';

import { openDatabase } from './schema.js';
import { TrainingModuleImpl } from './engine.js';
import { TrainingModule } from './types.js';

/** Create the training module backed by a SQLite file (':memory:' allowed). */
export function createTrainingModule(dbPath: string): TrainingModule {
  return new TrainingModuleImpl(openDatabase(dbPath));
}
