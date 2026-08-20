export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // The mapper above rewrites `./cli.js` to `./cli`, and jest's default extension
  // order puts `js` before `ts` — so a bare `yarn test` resolved the COMPILED
  // cli.js and silently exercised the previous build. Putting `ts` first makes the
  // suite test the source it is written against, whether or not `yarn build` ran.
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testMatch: ['**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};

