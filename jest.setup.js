// Set environment variable to indicate we're running tests
// This must be set before importing cli.js
process.env.AVO_TEST_MODE = 'true';

// Error messages wrap names like avo.json in chalk colours, and chalk colours
// whenever the terminal supports it, so tests asserting on message text would
// pass in CI and fail in a local terminal. Turn colour off for every run.
process.env.FORCE_COLOR = '0';

// Mock process.exit to prevent yargs from exiting during tests
const originalExit = process.exit;
process.exit = (code) => {
  // In test mode, don't actually exit - just return
  // This allows yargs to run but prevents process termination
  if (process.env.AVO_TEST_MODE) {
    return;
  }
  return originalExit(code);
};

