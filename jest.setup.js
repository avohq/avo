// Set environment variable to indicate we're running tests
// This must be set before importing cli.js
process.env.AVO_TEST_MODE = 'true';

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

